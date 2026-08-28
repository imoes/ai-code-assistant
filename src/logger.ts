import * as vscode from 'vscode';

/**
 * Logger class: Writes all actions to a dedicated output channel.
 * The channel is visible in the "Output" panel under "AI Code Assistant".
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

    /** Info message (green in the log) */
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

    /** Log AI action (for undo tracking) */
    action(type: string, detail: string): void {
        const timestamp = new Date().toISOString();
        this.outputChannel.appendLine(`[${timestamp}] [ACTION:${type.toUpperCase()}] ${detail}`);
    }

    /** Log shell command — automatically opens the output channel */
    shell(cmd: string, output: string, exitCode: number): void {
        const timestamp = new Date().toISOString();
        this.outputChannel.appendLine(`[${timestamp}] [SHELL] $ ${cmd}`);
        if (output.trim()) {
            output.split('\n').forEach(line =>
                this.outputChannel.appendLine(`           │ ${line}`)
            );
        }
        this.outputChannel.appendLine(`           └─ Exit: ${exitCode}`);
        // automatically show the Output-Channel so the user can see the result
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
