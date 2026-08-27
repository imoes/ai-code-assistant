import * as vscode from 'vscode';

/**
 * AgentConsole – ein echtes Terminal, in dem mitläuft, was der Assistent tut.
 *
 * Warum ein Terminal und nicht der Ausgabekanal: der Kanal ist ein Log für
 * Diagnose, mit Zeitstempeln und Interna. Beim Zusehen will man das, was ein
 * Entwickler an der Konsole sähe – den Befehl, seine Ausgabe, das Ergebnis.
 *
 * Es ist ein Pseudo-Terminal (kein Shell-Prozess): hier wird nichts ausgeführt,
 * nur dargestellt. Die Befehle laufen weiter über den ShellRunner, dessen
 * Ausgabe die KI auch braucht – ein zweites Mal ausführen wäre falsch.
 */
export class AgentConsole {
    private static instance: AgentConsole;

    private terminal?: vscode.Terminal;
    private writer = new vscode.EventEmitter<string>();
    /** Vor dem Öffnen anfallende Zeilen puffern, damit nichts verloren geht */
    private buffer: string[] = [];
    private opened = false;

    static getInstance(): AgentConsole {
        if (!AgentConsole.instance) {
            AgentConsole.instance = new AgentConsole();
        }
        return AgentConsole.instance;
    }

    // ANSI-Farben. Ein Terminal ohne Farbe ist eine Wand aus Text.
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
     * @param reveal  true = in den Vordergrund holen
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
                    `Hier wird nur angezeigt, nichts ausgeführt.${AgentConsole.C.reset}\r\n`);
                // Gepufferte Zeilen nachliefern
                const pending = this.buffer;
                this.buffer = [];
                for (const line of pending) this.raw(line);
            },
            close: () => {
                this.opened = false;
                this.terminal = undefined;
            },
            // Eingaben ignorieren: es gibt keine Shell dahinter
            handleInput: () => { /* absichtlich leer */ }
        };

        this.terminal = vscode.window.createTerminal({
            name: 'AI Assistant',
            pty,
            iconPath: new vscode.ThemeIcon('robot')
        });
    }

    /** Rohtext schreiben – Zeilenumbrüche für das Terminal umsetzen. */
    private raw(text: string): void {
        const crlf = text.replace(/\r?\n/g, '\r\n');
        if (this.opened) {
            this.writer.fire(crlf);
        } else {
            // Terminal noch nicht offen → puffern (max. 500 Zeilen)
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

    /** Neue Benutzeraufgabe – setzt das Protokoll optisch ab. */
    task(prompt: string, mode: string): void {
        const C = AgentConsole.C;
        this.ensureTerminal();
        this.line();
        this.line(`${C.bold}${C.cyan}${'═'.repeat(72)}${C.reset}`);
        this.line(`${C.bold}${C.cyan}  AUFGABE${C.reset}  ${C.dim}(Modus: ${mode})${C.reset}`);
        this.line(`${C.cyan}${'═'.repeat(72)}${C.reset}`);
        for (const l of prompt.split('\n')) this.line('  ' + l);
        this.line();
    }

    /** Beginn eines Schrittes der Agenten-Schleife. */
    step(n: number, reason: string): void {
        const C = AgentConsole.C;
        this.line();
        this.line(`${C.bold}${C.blue}── Schritt ${n} ${'─'.repeat(Math.max(0, 56 - String(n).length))}${C.reset}`);
        this.line(`${C.blue}   ${reason}${C.reset}`);
    }

    /** Der Assistent hat einen Plan angelegt oder aktualisiert. */
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
     * Was der Assistent selbst zu diesem Schritt sagt.
     *
     * Steht bewusst VOR den Aktionen: so liest man erst die Absicht und dann,
     * was daraus wurde – wie bei einem Entwickler, der laut mitdenkt.
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

    /** Eine ausgeführte Aktion mit ihrer Ausgabe. */
    action(description: string, output?: string, success = true): void {
        const C = AgentConsole.C;
        const icon = success ? `${C.green}✔${C.reset}` : `${C.red}✖${C.reset}`;
        this.line(`   ${icon} ${description}`);

        if (!output) return;
        // Ausgabe eingerückt und gedimmt, damit sie als Ausgabe lesbar bleibt
        const lines = output.replace(/\s+$/, '').split('\n');
        const shown = lines.slice(0, 40);
        for (const l of shown) {
            this.line(`     ${C.dim}${l}${C.reset}`);
        }
        if (lines.length > shown.length) {
            this.line(`     ${C.gray}… ${lines.length - shown.length} weitere Zeilen${C.reset}`);
        }
    }

    /** Ein Shell-Befehl, wie an der Konsole. */
    command(cmd: string): void {
        const C = AgentConsole.C;
        this.line(`   ${C.bold}$ ${cmd}${C.reset}`);
    }

    /** Angewandte Dateiänderung mit Zeilenbilanz. */
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
        this.line(`${C.dim}   ${steps} Schritt(e), ${actions} Aktion(en), ${seconds}s${C.reset}`);
        this.line();
    }

    /** Warnung oder Fehler. */
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
