import * as vscode from 'vscode';

/**
 * Logger-Klasse: Schreibt alle Aktionen in einen dedizierten Output-Channel.
 * Der Channel ist im "Output"-Panel unter "AI Code Assistant" sichtbar.
 */
export class Logger {
    private static instance: Logger;
    private outputChannel: vscode.OutputChannel;

    private constructor() {
        this.outputChannel = vscode.window.createOutputChannel('AI Code Assistant');
    }

    static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    /** Info-Nachricht (grün im Log) */
    info(message: string): void {
        const timestamp = new Date().toISOString();
        this.outputChannel.appendLine(`[${timestamp}] [INFO]  ${message}`);
    }

    /** Warnung */
    warn(message: string): void {
        const timestamp = new Date().toISOString();
        this.outputChannel.appendLine(`[${timestamp}] [WARN]  ${message}`);
    }

    /** Fehler */
    error(message: string, err?: unknown): void {
        const timestamp = new Date().toISOString();
        const errMsg = err instanceof Error ? ` — ${err.message}` : '';
        this.outputChannel.appendLine(`[${timestamp}] [ERROR] ${message}${errMsg}`);
    }

    /** KI-Aktion loggen (für Undo-Nachverfolgung) */
    action(type: string, detail: string): void {
        const timestamp = new Date().toISOString();
        this.outputChannel.appendLine(`[${timestamp}] [ACTION:${type.toUpperCase()}] ${detail}`);
    }

    /** Shell-Befehl loggen — öffnet den Output-Channel automatisch */
    shell(cmd: string, output: string, exitCode: number): void {
        const timestamp = new Date().toISOString();
        this.outputChannel.appendLine(`[${timestamp}] [SHELL] $ ${cmd}`);
        if (output.trim()) {
            output.split('\n').forEach(line =>
                this.outputChannel.appendLine(`           │ ${line}`)
            );
        }
        this.outputChannel.appendLine(`           └─ Exit: ${exitCode}`);
        // Output-Channel automatisch einblenden damit der User das Ergebnis sieht
        this.outputChannel.show(true);   // preserveFocus = true → Fokus bleibt im Editor
    }

    /** Log-Panel einblenden */
    show(): void {
        this.outputChannel.show(true);
    }

    /** Channel freigeben */
    dispose(): void {
        this.outputChannel.dispose();
    }
}
