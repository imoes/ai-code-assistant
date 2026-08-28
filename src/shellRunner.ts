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
 * Welche Shell einen Befehl ausführt.
 *
 * `auto` folgt der Einstellung `aiAssistant.shell`; das Modell kann pro Befehl
 * davon abweichen, weil manche Aufgaben nur in einer der beiden gehen: `npm
 * test` gehört unter WSL, ein `Get-Service` oder das Ansprechen eines
 * Windows-Programms nur in die PowerShell.
 */
export type ShellKind = 'auto' | 'wsl' | 'powershell' | 'bash';

/** Gefährliche PowerShell-Muster – das Gegenstück zu DANGEROUS_PATTERNS. */
const DANGEROUS_PS_PATTERNS = [
    /Remove-Item\s+.*-Recurse.*-Force/i,
    /Format-Volume/i,
    /Clear-Disk/i,
    /Stop-Computer|Restart-Computer/i,
    /Set-ExecutionPolicy\s+Unrestricted/i,
    /iex\s*\(|Invoke-Expression\s*\(/i,       // Download-und-ausführen
    /Invoke-WebRequest.*\|\s*iex/i,
    /reg\s+delete/i,
    /Remove-ItemProperty\s+.*HKLM/i,
];

/**
 * ShellRunner: Führt Shell-Befehle sicher aus – über WSL/bash oder PowerShell.
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
                stderr: 'PowerShell ist abgeschaltet (aiAssistant.allowPowerShell). '
                    + 'Nutze WSL oder bitte den Benutzer, die Einstellung zu ändern.',
                exitCode: -1, command, timedOut: false
            };
        }

        // cat/head/tail abfangen: direkt einlesen statt einen Prozess zu starten.
        // Gilt für beide Shells – die Datei liest Node ohnehin schneller.
        const fileReadResult = ShellRunner.interceptFileReadCommand(command, workDir, this.logger);
        if (fileReadResult) {
            return fileReadResult;
        }

        const patterns = shell === 'powershell' ? DANGEROUS_PS_PATTERNS : DANGEROUS_PATTERNS;
        const isDangerous = patterns.some(p => p.test(command));
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

        const useWsl = shell === 'wsl';

        // In der PowerShell bleibt der Windows-Pfad, wie er ist – die
        // WSL-Umschreibung würde ihn dort unbrauchbar machen.
        const shellWorkDir = useWsl ? ShellRunner.windowsToWslPath(workDir) : workDir;
        // Windows-Pfade im Befehl selbst konvertieren (z.B. cd d:\foo → cd /mnt/d/foo)
        const convertedCommand = useWsl
            ? ShellRunner.convertWindowsPathsInCommand(command)
            : command;

        const fullCommand = shell === 'powershell'
            // Set-Location statt cd, und der Befehl folgt nach `;`: PowerShell 5.1
            // kennt kein `&&`. Ein `if ($?)` wäre falsch, denn ein fehlgeschlagenes
            // Set-Location soll den Job abbrechen – das erledigt -ErrorAction Stop.
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
                        ? 'WSL nicht gefunden. Bitte WSL installieren (wsl --install).'
                        : shell === 'powershell'
                            ? 'PowerShell nicht gefunden (powershell.exe fehlt im PATH).'
                            : 'bash nicht gefunden.')
                    : err.message;
                this.logger.error('Shell-Prozess Fehler', err);
                resolve({ stdout: '', stderr: msg, exitCode: -1, command, timedOut: false });
            });
        });
    }

    /**
     * Welche Shell es am Ende wird.
     *
     * `auto` heißt: die Einstellung entscheidet, und deren Standard richtet sich
     * nach dem Betriebssystem. Auf Linux und macOS gibt es kein WSL – dort war
     * `wsl` früher fest verdrahtet und JEDER Befehl scheiterte, auch `echo test`.
     */
    static resolveShell(
        requested: ShellKind,
        config: { get<T>(key: string, fallback: T): T }
    ): 'wsl' | 'powershell' | 'bash' {
        const onWindows = process.platform === 'win32';

        if (requested === 'powershell') return 'powershell';
        if (requested === 'wsl') return onWindows ? 'wsl' : 'bash';
        if (requested === 'bash') return onWindows ? 'wsl' : 'bash';

        const preferred = config.get<string>('shell', 'auto');
        if (preferred === 'powershell') return onWindows ? 'powershell' : 'bash';
        if (preferred === 'wsl' || preferred === 'bash') return onWindows ? 'wsl' : 'bash';

        // auto: unter Windows WSL, weil Build- und Testbefehle dort hingehören
        return onWindows ? 'wsl' : 'bash';
    }

    /** Programm und Argumente für die gewählte Shell. */
    static spawnArgs(
        shell: 'wsl' | 'powershell' | 'bash',
        fullCommand: string
    ): [string, string[]] {
        if (shell === 'wsl') return ['wsl', ['bash', '-c', fullCommand]];
        if (shell === 'bash') return ['bash', ['-c', fullCommand]];
        // -NonInteractive, damit ein Read-Host nicht wartet, bis der Timeout greift.
        // -NoProfile, damit das Profil des Benutzers das Ergebnis nicht verfälscht.
        return ['powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-Command', fullCommand
        ]];
    }

    /** Argument für die PowerShell quoten: einfache Anführungszeichen verdoppeln. */
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
