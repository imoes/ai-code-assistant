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
 * ShellRunner: Führt Shell-Befehle sicher über WSL aus.
 * Bestätigungen werden über ConfirmFn als In-Chat-Karte angezeigt.
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

    /** Konvertiert WSL-Pfad (/mnt/d/foo) zurück zu Windows-Pfad (D:\foo) */
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
     * Konvertiert Windows-Pfade (d:\foo\bar) im Befehlsstring zu WSL-Pfaden (/mnt/d/foo/bar).
     * Nötig weil bash Backslashes als Escape-Zeichen behandelt: \D → D, \f → f usw.
     */
    static convertWindowsPathsInCommand(command: string): string {
        // Matcht Laufwerksbuchstabe:\Pfad\mit\Backslashes (unquoted oder in Anführungszeichen)
        return command.replace(/([A-Za-z]):\\([^\s"'`|&;<>()\[\]{}!?*\n]+)/g, (_, drive, rest) => {
            const wslRest = rest.replace(/\\/g, '/').replace(/\/$/, '');
            return `/mnt/${drive.toLowerCase()}/${wslRest}`;
        });
    }

    /**
     * Shell-Befehl über WSL ausführen.
     * @param confirmFn  In-Chat-Bestätigung (undefined = autoApply)
     */
    async run(
        command: string,
        workDir: string,
        timeoutMs = 30_000,
        confirmFn?: ConfirmFn
    ): Promise<ShellResult> {
        const config = vscode.workspace.getConfiguration('aiAssistant');
        const allowShell = config.get<boolean>('allowShellCommands', true);

        if (!allowShell) {
            return {
                stdout: '', stderr: 'Shell-Befehle deaktiviert.',
                exitCode: -1, command, timedOut: false
            };
        }

        // cat/head/tail abfangen: direkt einlesen statt WSL-Befehl ausführen
        const fileReadResult = ShellRunner.interceptFileReadCommand(command, workDir, this.logger);
        if (fileReadResult) {
            return fileReadResult;
        }

        const isDangerous = DANGEROUS_PATTERNS.some(p => p.test(command));
        const confirmDangerous = config.get<boolean>('confirmDangerousOps', true);

        // Gefährliche Befehle immer bestätigen lassen
        if (isDangerous && confirmDangerous && confirmFn) {
            const choice = await confirmFn(
                `⚠ Potenziell gefährlicher Befehl erkannt:\n\`${command}\``,
                ['Ausführen', 'Ablehnen']
            );
            if (choice !== 'Ausführen') {
                return {
                    stdout: '', stderr: 'Befehl durch Benutzer abgebrochen.',
                    exitCode: -1, command, timedOut: false
                };
            }
        }

        // Unter Windows läuft die Shell über WSL, sonst direkt über bash.
        // Vorher war `wsl` hart verdrahtet – auf Linux und macOS scheiterte
        // damit JEDER Befehl, auch `echo test`.
        const useWsl = process.platform === 'win32';

        const shellWorkDir = useWsl
            ? ShellRunner.windowsToWslPath(workDir)
            : workDir;
        // Windows-Pfade im Befehl selbst konvertieren (z.B. cd d:\foo → cd /mnt/d/foo)
        const convertedCommand = useWsl
            ? ShellRunner.convertWindowsPathsInCommand(command)
            : command;
        const fullCommand = `cd ${ShellRunner.escapeShellArg(shellWorkDir)} && ${convertedCommand}`;

        if (convertedCommand !== command) {
            this.logger.info(`Shell: Windows-Pfade konvertiert: ${command} → ${convertedCommand}`);
        }
        this.logger.info(
            `Shell (${useWsl ? 'WSL' : process.platform}): ${convertedCommand}  [in ${shellWorkDir}]`
        );

        return new Promise<ShellResult>((resolve) => {
            let timedOut = false;

            const [exe, args] = useWsl
                ? ['wsl', ['bash', '-c', fullCommand]]
                : ['bash', ['-c', fullCommand]] as [string, string[]];

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
                    ? 'WSL nicht gefunden. Bitte WSL installieren (wsl --install).'
                    : err.message;
                this.logger.error('Shell-Prozess Fehler', err);
                resolve({ stdout: '', stderr: msg, exitCode: -1, command, timedOut: false });
            });
        });
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
     * Fängt Dateilese-Befehle ab (cat, head, tail) und liest die Datei direkt
     * über Node.js ein — kein WSL-Prozess nötig, keine Pfadprobleme.
     * Gibt null zurück wenn der Befehl kein Dateilese-Befehl ist.
     *
     * Public static damit aiEngine.ts es vor dem Confirm-Dialog aufrufen kann.
     */
    static interceptFileReadCommand(command: string, workDir: string, logger?: Logger): ShellResult | null {
        const trimmed = command.trim();
        // Matcht: cat file, head -n 20 file, tail -n 50 file
        const match = trimmed.match(/^(cat|head|tail)(?:\s+-n\s*(\d+))?\s+["']?([^"'|&;<>\n]+?)["']?\s*$/);
        if (!match) return null;

        const [, cmd, linesArg, rawPath] = match;
        const filePath = rawPath.trim();

        // Pfad auflösen: WSL, absolut oder relativ zum workDir
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
