import * as vscode from 'vscode';

/**
 * AgentConsole – a real terminal where you can follow along with what the assistant does.
 *
 * Why a terminal and not the output channel: the channel is a log for
 * Diagnostics, with timestamps and internals. When watching, you want what a
 * developer at the console would see – the command, its output, the result.
 *
 * It is a pseudo-terminal (no shell process): nothing is executed here,
 * only displayed. The commands continue to run via the ShellRunner, whose
 * Output that the AI also needs – running it a second time would be wrong.
 */
export class AgentConsole {
    private static instance: AgentConsole;

    private terminal?: vscode.Terminal;
    private writer = new vscode.EventEmitter<string>();
    /** Buffer lines that occur before opening so that nothing is lost */
    private buffer: string[] = [];
    private opened = false;

    static getInstance(): AgentConsole {
        if (!AgentConsole.instance) {
            AgentConsole.instance = new AgentConsole();
        }
        return AgentConsole.instance;
    }

    // ANSI colors. A terminal without color is a wall of text.
    private static readonly C = {
        reset: '\x1b[0m',
        dim: '\x1b[2m',
        bold: '\x1b[1m',
        red: '\x1b[31m',
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        blue: '\x1b[34m',
        magenta: '\x1b[35m',
        cyan: '\x1b[36m',
        gray: '\x1b[90m'
    };

    /**
     * Terminal anlegen bzw. anzeigen.
     * @param reveal  true = bring to the foreground
     */
    show(reveal = true): void {
        this.ensureTerminal();
        if (reveal) this.terminal?.show(true);
    }

    private ensureTerminal(): void {
        if (this.terminal) return;

        const pty: vscode.Pseudoterminal = {
            onDidWrite: this.writer.event,
            open: () => {
                this.opened = true;
                this.raw(`${AgentConsole.C.dim}AI Assistant – Arbeitsprotokoll. ` +
                    `This only displays; nothing runs here.${AgentConsole.C.reset}\r\n`);
                // Gepufferte Zeilen nachliefern
                const pending = this.buffer;
                this.buffer = [];
                for (const line of pending) this.raw(line);
            },
            close: () => {
                this.opened = false;
                this.terminal = undefined;
            },
            // Ignore inputs: there is no shell behind it
            handleInput: () => { /* absichtlich leer */ }
        };

        this.terminal = vscode.window.createTerminal({
            name: 'AI Assistant',
            pty,
            iconPath: new vscode.ThemeIcon('robot')
        });
    }

    /** Write raw text – apply line breaks for the terminal. */
    private raw(text: string): void {
        const crlf = text.replace(/\r?\n/g, '\r\n');
        if (this.opened) {
            this.writer.fire(crlf);
        } else {
            // Terminal not yet open → buffer (max. 500 lines)
            this.buffer.push(crlf);
            if (this.buffer.length > 500) this.buffer.shift();
        }
    }

    private line(text = ''): void {
        this.raw(text + '\r\n');
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Protokoll-Bausteine
    // ──────────────────────────────────────────────────────────────────────────

    /** New user task – visually resets the protocol. */
    task(prompt: string, mode: string): void {
        const C = AgentConsole.C;
        this.ensureTerminal();
        this.line();
        this.line(`${C.bold}${C.cyan}${'═'.repeat(72)}${C.reset}`);
        this.line(`${C.bold}${C.cyan}  TASK${C.reset}  ${C.dim}(mode: ${mode})${C.reset}`);
        this.line(`${C.cyan}${'═'.repeat(72)}${C.reset}`);
        for (const l of prompt.split('\n')) this.line('  ' + l);
        this.line();
    }

    /** Start of a step in the agent loop. */
    step(n: number, reason: string): void {
        const C = AgentConsole.C;
        this.line();
        this.line(`${C.bold}${C.blue}── Step ${n} ${'─'.repeat(Math.max(0, 58 - String(n).length))}${C.reset}`);
        this.line(`${C.blue}   ${reason}${C.reset}`);
    }

    /** The assistant has created or updated a plan. */
    plan(steps: { text: string; status: string }[]): void {
        const C = AgentConsole.C;
        const done = steps.filter(s => s.status === 'done').length;
        this.line();
        this.line(`${C.bold}${C.magenta}   Plan (${done}/${steps.length})${C.reset}`);
        for (const s of steps) {
            const mark = s.status === 'done' ? `${C.green}[x]${C.reset}`
                : s.status === 'doing' ? `${C.yellow}[>]${C.reset}`
                : `${C.gray}[ ]${C.reset}`;
            const text = s.status === 'done' ? `${C.dim}${s.text}${C.reset}` : s.text;
            this.line(`   ${mark} ${text}`);
        }
    }

    /**
     * What the assistant itself says about this step.
     *
     * Intentionally placed BEFORE the actions: this way the intent is read first and then,
     * what resulted from it – like a developer thinking out loud.
     */
    narration(text: string): void {
        const C = AgentConsole.C;
        const clean = text.trim();
        if (!clean) return;
        this.line();
        for (const l of clean.split('\n')) {
            this.line(`   ${C.bold}${l}${C.reset}`);
        }
    }

    /** An executed action with its output. */
    action(description: string, output?: string, success = true): void {
        const C = AgentConsole.C;
        const icon = success ? `${C.green}✔${C.reset}` : `${C.red}✖${C.reset}`;
        this.line(`   ${icon} ${description}`);

        if (!output) return;
        // Output indented and dimmed so that it remains readable as output
        const lines = output.replace(/\s+$/, '').split('\n');
        const shown = lines.slice(0, 40);
        for (const l of shown) {
            this.line(`     ${C.dim}${l}${C.reset}`);
        }
        if (lines.length > shown.length) {
            this.line(`     ${C.gray}… ${lines.length - shown.length} weitere Zeilen${C.reset}`);
        }
    }

    /** A shell command, as on the console. */
    command(cmd: string): void {
        const C = AgentConsole.C;
        this.line(`   ${C.bold}$ ${cmd}${C.reset}`);
    }

    /** Applied file change with line count. */
    change(path: string, kind: string, removed: number, added: number): void {
        const C = AgentConsole.C;
        this.line(`   ${C.green}✔${C.reset} ${kind}: ${C.bold}${path}${C.reset}  ` +
            `${C.red}−${removed}${C.reset} ${C.green}+${added}${C.reset}`);
    }

    /** Abschluss einer Aufgabe. */
    finish(steps: number, actions: number, seconds: number): void {
        const C = AgentConsole.C;
        this.line();
        this.line(`${C.bold}${C.cyan}── Fertig ${'─'.repeat(58)}${C.reset}`);
        this.line(`${C.dim}   ${steps} step(s), ${actions} action(s), ${seconds}s${C.reset}`);
        this.line();
    }

    /** Warning or error. */
    problem(text: string): void {
        const C = AgentConsole.C;
        this.line(`   ${C.red}⚠ ${text}${C.reset}`);
    }

    dispose(): void {
        this.terminal?.dispose();
        this.terminal = undefined;
        this.writer.dispose();
    }
}
