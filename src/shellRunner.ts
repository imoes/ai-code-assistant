import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';
import { ConfirmFn } from './confirm';

export interface ShellResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    command: string;
    timedOut: boolean;
}

const DANGEROUS_PATTERNS = [
    /rm\s+-rf?\s+[^.]/i,
    /:\s*\(\)\s*\{.*\}/,
    />\s*\/dev\/sd/i,
    /chmod\s+777/i,
    /curl.*\|\s*(ba)?sh/i,
    /wget.*\|\s*(ba)?sh/i,
    /dd\s+if=/i,
    /mkfs/i,
    /sudo\s+rm/i,
];

/**
 * Which shell executes a command.
 *
 * `auto` follows the `aiAssistant.shell` setting; the model can per command
 * deviate from this, because some tasks only work in one of the two: `npm
 * test` belongs under WSL, a `Get-Service` or the addressing of a
 * Windows program only into the PowerShell.
 */
export type ShellKind = 'auto' | 'wsl' | 'powershell' | 'bash';

/**
 * What this machine can run.
 *
 * The platform alone is not enough: Windows without WSL is an ordinary case,
 * and on Linux there is usually no PowerShell. Both matter for the prompt as
 * well – a model told about a shell that is not installed will reach for it.
 */
export interface ShellEnvironment {
    platform: 'windows' | 'linux' | 'macos';
    /** wsl.exe present (Windows only) */
    wsl: boolean;
    /** powershell.exe present (Windows only) */
    powershell: boolean;
    /** /bin/bash present (Linux and macOS) */
    bash: boolean;
}

/** Dangerous PowerShell patterns – the counterpart to DANGEROUS_PATTERNS. */
const DANGEROUS_PS_PATTERNS = [
    /Remove-Item\s+.*-Recurse.*-Force/i,
    /Format-Volume/i,
    /Clear-Disk/i,
    /Stop-Computer|Restart-Computer/i,
    /Set-ExecutionPolicy\s+Unrestricted/i,
    /iex\s*\(|Invoke-Expression\s*\(/i,       // download-and-run
    /Invoke-WebRequest.*\|\s*iex/i,
    /reg\s+delete/i,
    /Remove-ItemProperty\s+.*HKLM/i,
];

/**
 * ShellRunner: Executes shell commands securely – via WSL/bash or PowerShell.
 * Confirmations are displayed as in-chat cards via ConfirmFn.
 */
export class ShellRunner {
    private static instance: ShellRunner;
    private logger = Logger.getInstance();
    private terminal: vscode.Terminal | undefined;

    private constructor() {}

    static getInstance(): ShellRunner {
        if (!ShellRunner.instance) {
            ShellRunner.instance = new ShellRunner();
        }
        return ShellRunner.instance;
    }

    /** Converts WSL path (/mnt/d/foo) back to Windows path (D:\foo) */
    static wslPathToWindows(wslPath: string): string {
        return wslPath
            .replace(/^\/mnt\/([a-z])\//, (_, drive) => `${drive.toUpperCase()}:\\`)
            .replace(/\//g, '\\');
    }

    static windowsToWslPath(winPath: string): string {
        const normalized = winPath.replace(/\\/g, '/');
        return normalized.replace(/^([A-Za-z]):\//, (_, drive) =>
            `/mnt/${drive.toLowerCase()}/`
        );
    }

    /**
     * Converts Windows paths (d:\foo\bar) in the command line to WSL paths (/mnt/d/foo/bar).
     * Necessary because bash treats backslashes as escape characters: \D → D, \f → f, etc.
     */
    static convertWindowsPathsInCommand(command: string): string {
        // Matches drive letter:\path\with\backslashes (unquoted or in quotes)
        return command.replace(/([A-Za-z]):\\([^\s"'`|&;<>()\[\]{}!?*\n]+)/g, (_, drive, rest) => {
            const wslRest = rest.replace(/\\/g, '/').replace(/\/$/, '');
            return `/mnt/${drive.toLowerCase()}/${wslRest}`;
        });
    }

    /**
     * Execute shell command via WSL.
     * @param confirmFn  In-Chat confirmation (undefined = autoApply)
     */
    async run(
        command: string,
        workDir: string,
        timeoutMs = 30_000,
        confirmFn?: ConfirmFn,
        shellKind: ShellKind = 'auto'
    ): Promise<ShellResult> {
        const config = vscode.workspace.getConfiguration('aiAssistant');
        const allowShell = config.get<boolean>('allowShellCommands', true);

        if (!allowShell) {
            return {
                stdout: '', stderr: 'Shell-Befehle deaktiviert.',
                exitCode: -1, command, timedOut: false
            };
        }

        const shell = ShellRunner.resolveShell(shellKind, config);

        if (shell === 'powershell' && !config.get<boolean>('allowPowerShell', true)) {
            return {
                stdout: '',
                stderr: 'PowerShell is switched off (aiAssistant.allowPowerShell). '
                    + 'Use WSL, or ask the user to change the setting.',
                exitCode: -1, command, timedOut: false
            };
        }

        // Catch cat/head/tail: read directly instead of starting a process.
        // Applies to both shells – Node reads the file faster anyway.
        const fileReadResult = ShellRunner.interceptFileReadCommand(command, workDir, this.logger);
        if (fileReadResult) {
            return fileReadResult;
        }

        const patterns = shell === 'powershell' ? DANGEROUS_PS_PATTERNS : DANGEROUS_PATTERNS;
        const isDangerous = patterns.some(p => p.test(command));
        const confirmDangerous = config.get<boolean>('confirmDangerousOps', true);

        // Always confirm dangerous commands
        if (isDangerous && confirmDangerous && confirmFn) {
            const choice = await confirmFn(
                `⚠ Potentially dangerous command detected:\n\`${command}\``,
                ['Run', 'Reject']
            );
            if (choice !== 'Run') {
                return {
                    stdout: '', stderr: 'Befehl durch Benutzer abgebrochen.',
                    exitCode: -1, command, timedOut: false
                };
            }
        }

        const useWsl = shell === 'wsl';

        // In PowerShell, the Windows path remains as is – the
        // WSL conversion would render it unusable there.
        const shellWorkDir = useWsl ? ShellRunner.windowsToWslPath(workDir) : workDir;
        // Convert Windows paths in the command itself (e.g., cd d:\foo → cd /mnt/d/foo)
        const convertedCommand = useWsl
            ? ShellRunner.convertWindowsPathsInCommand(command)
            : command;

        const fullCommand = shell === 'powershell'
            // Use Set-Location instead of cd, and the command follows after `;`: PowerShell 5.1
            // does not know `&&`. An `if ($?)` would be wrong, because a failed
            // Set-Location should abort the job – that is handled by -ErrorAction Stop.
            ? `Set-Location -LiteralPath ${ShellRunner.escapePsArg(shellWorkDir)} -ErrorAction Stop; ${convertedCommand}`
            : `cd ${ShellRunner.escapeShellArg(shellWorkDir)} && ${convertedCommand}`;

        if (convertedCommand !== command) {
            this.logger.info(`Shell: Windows-Pfade konvertiert: ${command} → ${convertedCommand}`);
        }
        this.logger.info(`Shell (${shell}): ${convertedCommand}  [in ${shellWorkDir}]`);

        return new Promise<ShellResult>((resolve) => {
            let timedOut = false;

            const [exe, args] = ShellRunner.spawnArgs(shell, fullCommand);

            const proc = cp.spawn(exe as string, args as string[], {
                shell: false,
                windowsHide: true
            });

            let stdout = '';
            let stderr = '';

            proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
            proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

            const timer = setTimeout(() => {
                timedOut = true;
                proc.kill('SIGTERM');
                this.logger.warn(`Shell-Timeout (${timeoutMs}ms): ${command}`);
            }, timeoutMs);

            proc.on('close', (code) => {
                clearTimeout(timer);
                const exitCode = code ?? -1;
                this.logger.shell(command, stdout + stderr, exitCode);
                resolve({ stdout, stderr, exitCode, command, timedOut });
            });

            proc.on('error', (err) => {
                clearTimeout(timer);
                const msg = err.message.includes('ENOENT')
                    ? (shell === 'wsl'
                        ? 'WSL not found. Please install it (wsl --install).'
                        : shell === 'powershell'
                            ? 'PowerShell not found (powershell.exe is not on PATH).'
                            : 'bash not found.')
                    : err.message;
                this.logger.error('Shell process error', err);
                resolve({ stdout: '', stderr: msg, exitCode: -1, command, timedOut: false });
            });
        });
    }

    /**
     * What this machine actually offers.
     *
     * Not just the platform – whether the program is really there. Windows
     * without WSL is an ordinary case (a fresh machine, a locked-down one), and
     * on Linux there is usually no PowerShell. Both used to end the same way:
     * the assistant sent a command, `wsl` or `powershell.exe` was missing,
     * ENOENT, and the round was gone.
     *
     * Checked once and remembered. The answer cannot change while the window is
     * open, and a file test per command would be wasted work.
     */
    static environment(): ShellEnvironment {
        if (ShellRunner.envCache) return ShellRunner.envCache;

        const platform: ShellEnvironment['platform'] =
            process.platform === 'win32' ? 'windows'
                : process.platform === 'darwin' ? 'macos' : 'linux';

        const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
        const exists = (p: string): boolean => {
            try { return fs.existsSync(p); } catch { return false; }
        };

        const env: ShellEnvironment = platform === 'windows'
            ? {
                platform,
                // System32 only – wsl.exe in SysWOW64 is the 32-bit stub.
                wsl: exists(path.join(sysRoot, 'System32', 'wsl.exe')),
                powershell: exists(path.join(sysRoot, 'System32', 'WindowsPowerShell',
                    'v1.0', 'powershell.exe')),
                bash: false
            }
            : {
                platform,
                wsl: false,
                powershell: false,
                bash: exists('/bin/bash') || exists('/usr/bin/bash')
            };

        ShellRunner.envCache = env;
        return env;
    }

    /** Only for the tests: forget what was detected. */
    static resetEnvironment(): void {
        ShellRunner.envCache = undefined;
    }

    private static envCache?: ShellEnvironment;

    /**
     * Which shell it ends up being.
     *
     * `auto` means the setting decides, and its default follows the operating
     * system. But a request is only honoured where it can actually run: on
     * Linux and macOS there is no WSL – `wsl` used to be hard-wired there and
     * EVERY command failed, even `echo test`. The same hole was still open for
     * `powershell`: a block with `shell: powershell` was honoured verbatim on
     * Linux, and the model lost a round to ENOENT.
     *
     * On Windows without WSL the fallback runs the other way: PowerShell is
     * there, so the command goes there rather than nowhere.
     */
    static resolveShell(
        requested: ShellKind,
        config: { get<T>(key: string, fallback: T): T }
    ): 'wsl' | 'powershell' | 'bash' {
        const env = ShellRunner.environment();
        const onWindows = env.platform === 'windows';

        // What is left when a wish cannot be met.
        const posix = (): 'wsl' | 'bash' => (onWindows && env.wsl) ? 'wsl' : 'bash';
        const fallback = (): 'wsl' | 'powershell' | 'bash' =>
            (onWindows && !env.wsl && env.powershell) ? 'powershell' : posix();

        if (requested === 'powershell') return onWindows ? 'powershell' : posix();
        if (requested === 'wsl') return fallback();
        if (requested === 'bash') return fallback();

        const preferred = config.get<string>('shell', 'auto');
        if (preferred === 'powershell') return onWindows ? 'powershell' : posix();
        if (preferred === 'wsl' || preferred === 'bash') return fallback();

        // auto: WSL under Windows, because that is where build and test commands
        // belong – unless it is not installed, then PowerShell is what there is.
        return fallback();
    }

    /** Program and arguments for the selected shell. */
    static spawnArgs(
        shell: 'wsl' | 'powershell' | 'bash',
        fullCommand: string
    ): [string, string[]] {
        if (shell === 'wsl') return ['wsl', ['bash', '-c', fullCommand]];
        if (shell === 'bash') return ['bash', ['-c', fullCommand]];
        // -NonInteractive, so that a Read-Host does not wait until the timeout triggers.
        // -NoProfile, so that the user's profile does not distort the result.
        return ['powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-Command', fullCommand
        ]];
    }

    /** Arguments for the PowerShell quotes: double single quotes. */
    static escapePsArg(arg: string): string {
        return `'${arg.replace(/'/g, "''")}'`;
    }

    openTerminal(workDir: string): vscode.Terminal {
        if (this.terminal && !this.terminal.exitStatus) {
            this.terminal.show();
            return this.terminal;
        }
        const wslWorkDir = ShellRunner.windowsToWslPath(workDir);
        this.terminal = vscode.window.createTerminal({
            name: 'AI Assistant (WSL)',
            shellPath: 'wsl.exe',
            shellArgs: ['bash', '-c', `cd ${ShellRunner.escapeShellArg(wslWorkDir)} && exec bash`]
        });
        this.terminal.show();
        return this.terminal;
    }

    private static escapeShellArg(arg: string): string {
        return `'${arg.replace(/'/g, "'\\''")}'`;
    }

    /**
     * Intercepts file read commands (cat, head, tail) and reads the file directly
     * via Node.js — no WSL process needed, no path issues.
     * Returns null if the command is not a file read command.
     *
     * Public static so that aiEngine.ts can be called before the Confirm dialog.
     */
    static interceptFileReadCommand(command: string, workDir: string, logger?: Logger): ShellResult | null {
        const trimmed = command.trim();
        // Matcht: cat file, head -n 20 file, tail -n 50 file
        const match = trimmed.match(/^(cat|head|tail)(?:\s+-n\s*(\d+))?\s+["']?([^"'|&;<>\n]+?)["']?\s*$/);
        if (!match) return null;

        const [, cmd, linesArg, rawPath] = match;
        const filePath = rawPath.trim();

        // Resolve path: WSL, absolute or relative to workDir
        let absPath: string;
        if (filePath.startsWith('/mnt/')) {
            absPath = ShellRunner.wslPathToWindows(filePath);
        } else if (path.isAbsolute(filePath)) {
            absPath = filePath;
        } else {
            absPath = path.join(workDir, filePath);
        }

        try {
            let content = fs.readFileSync(absPath, 'utf-8');
            if ((cmd === 'head' || cmd === 'tail') && linesArg) {
                const n = parseInt(linesArg, 10);
                const lines = content.split('\n');
                content = (cmd === 'head' ? lines.slice(0, n) : lines.slice(-n)).join('\n');
            }
            (logger ?? Logger.getInstance()).info(`[cat intercepted] ${absPath} (${content.length} Zeichen)`);
            return { stdout: content, stderr: '', exitCode: 0, command: trimmed, timedOut: false };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { stdout: '', stderr: `${cmd}: ${filePath}: ${msg}`, exitCode: 1, command: trimmed, timedOut: false };
        }
    }

    dispose(): void {
        this.terminal?.dispose();
    }
}
