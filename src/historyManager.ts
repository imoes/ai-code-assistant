import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';

export interface HistoryAction {
    type: string;
    description: string;
    success: boolean;
    output?: string;
}

export interface HistoryMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: string;
    actions?: HistoryAction[];
    reasoning?: string;  // AI-Prompt-formatierte Zusammenfassung des Reasoning
}

export interface HistorySession {
    id: string;
    startedAt: string;
    messages: HistoryMessage[];
}

export interface HistoryFile {
    version: 1;
    lastUpdated: string;
    sessions: HistorySession[];
}

const MAX_SESSIONS = 50;        // Maximale Anzahl gespeicherter Sessions
const MAX_MESSAGES = 200;       // Maximale Nachrichten pro Session

/**
 * HistoryManager: Speichert den Konversationsverlauf als
 * `ai-code-assistant.json` im Workspace-Root.
 *
 * - Neue Sessions werden beim ersten Aufruf von `startSession()` angelegt
 * - Jede Nachricht wird direkt nach dem Empfang gespeichert
 * - Älteste Sessions werden gelöscht wenn MAX_SESSIONS überschritten wird
 */
export class HistoryManager {
    private historyPath: string;
    private currentSessionId: string;
    private data: HistoryFile;
    private logger = Logger.getInstance();

    constructor(workspaceRoot: string) {
        this.historyPath = path.join(workspaceRoot, 'ai-code-assistant.json');
        this.currentSessionId = this.generateSessionId();
        this.data = this.load();
        this.startSession();
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Public API
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Gesamten Verlauf löschen – Datei und Speicher.
     *
     * Die Datei wird nicht gelöscht, sondern geleert: der Pfad steht in
     * Log-Meldungen und ist im Explorer sichtbar, eine plötzlich fehlende
     * Datei wirkt wie ein Fehler.
     *
     * @returns Anzahl der entfernten Sessions
     */
    clearAll(): number {
        const removed = this.data.sessions.length;
        this.data = { version: 1, lastUpdated: new Date().toISOString(), sessions: [] };
        this.currentSessionId = this.generateSessionId();
        this.startSession();
        this.logger.info(`Verlauf gelöscht: ${removed} Session(s) entfernt.`);
        return removed;
    }

    /** Neue Session beginnen */
    startSession(): void {
        const session: HistorySession = {
            id: this.currentSessionId,
            startedAt: new Date().toISOString(),
            messages: []
        };
        this.data.sessions.push(session);

        // Älteste Sessions trimmen
        if (this.data.sessions.length > MAX_SESSIONS) {
            this.data.sessions = this.data.sessions.slice(-MAX_SESSIONS);
        }

        this.save();
        this.logger.info(`History-Session gestartet: ${this.currentSessionId}`);
    }

    /** Benutzer-Nachricht speichern */
    addUserMessage(content: string): void {
        this.addMessage({ role: 'user', content, timestamp: new Date().toISOString() });
    }

    /** KI-Antwort speichern (inkl. ausgeführter Aktionen und Reasoning-Zusammenfassung) */
    addAssistantMessage(content: string, actions?: HistoryAction[], reasoning?: string): void {
        this.addMessage({
            role: 'assistant',
            content,
            timestamp: new Date().toISOString(),
            actions,
            reasoning
        });
    }

    /** Aktuelle Session-ID */
    getSessionId(): string {
        return this.currentSessionId;
    }

    /** Alle Sessions (neueste zuerst) */
    getSessions(): HistorySession[] {
        return [...this.data.sessions].reverse();
    }

    /** Nachrichten der aktuellen Session */
    getCurrentSessionMessages(): HistoryMessage[] {
        return this.currentSession()?.messages ?? [];
    }

    /**
     * Kurzfassung der letzten Sitzung als Hintergrund-Notiz.
     *
     * Ersetzt das frühere `getLastSessionMessages()`, das die alten Runden als
     * echte Gesprächsrunden zurückgab – mit zwei Folgen. Erstens hängte es die
     * Reasoning-Zusammenfassung als `[Vorheriges Reasoning] … [Antwort] …` vor
     * den Assistenten-Text; das Modell sah diese Marker in seinen eigenen Turns
     * und ahmte sie nach, sodass sie sichtbar in der Antwort im Chat standen.
     *
     * Zweitens hielt das Modell die damalige Aufgabe für die laufende: beobachtet wurde
     * ein Lauf, in dem es eine Webseite abrufen sollte und stattdessen die
     * Testreparatur der Vorsitzung fortsetzte, `npm test` eingeschlossen –
     * obwohl der Auftrag „ändere keine Dateien" lautete. Als einzelne, klar
     * als abgeschlossen markierte Notiz bleibt das Wissen verfügbar, ohne die
     * neue Aufgabe zu verdrängen.
     */
    getLastSessionDigest(maxChars = 1200): string | null {
        const lastSession = this.lastFinishedSession();
        if (!lastSession) return null;

        const lines: string[] = [];
        for (const m of lastSession.messages.slice(-12)) {
            const text = String(m.content ?? '').replace(/\s+/g, ' ').trim();
            if (!text) continue;
            const who = m.role === 'user' ? 'Auftrag' : 'Ergebnis';
            lines.push(`- ${who}: ${text.slice(0, 220)}`);
        }
        if (lines.length === 0) return null;

        // Von hinten auffüllen: das Zuletzt-Passierte ist das Wichtigste.
        const kept: string[] = [];
        let used = 0;
        for (const line of lines.reverse()) {
            if (used + line.length > maxChars) break;
            kept.unshift(line);
            used += line.length + 1;
        }
        return kept.join('\n');
    }

    /**
     * Die letzte Session, die nicht die laufende ist UND Nachrichten enthält.
     *
     * Jedes Neuladen des Fensters legt eine Session an, auch wenn danach nichts
     * gefragt wird. Ohne die Inhaltsprüfung verdeckt so eine leere Session die
     * letzte echte Sitzung, und der Verlauf wirkt nach zwei Reloads verloren.
     */
    private lastFinishedSession(): HistorySession | null {
        for (let i = this.data.sessions.length - 1; i >= 0; i--) {
            const s = this.data.sessions[i];
            if (s.id !== this.currentSessionId && s.messages.length > 0) return s;
        }
        return null;
    }

    /** Verlaufs-Datei-Pfad */
    getHistoryPath(): string {
        return this.historyPath;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Intern
    // ──────────────────────────────────────────────────────────────────────────

    private addMessage(msg: HistoryMessage): void {
        const session = this.currentSession();
        if (!session) return;

        session.messages.push(msg);

        // Nachrichten-Limit einhalten
        if (session.messages.length > MAX_MESSAGES) {
            session.messages = session.messages.slice(-MAX_MESSAGES);
        }

        this.save();
    }

    private currentSession(): HistorySession | undefined {
        return this.data.sessions.find(s => s.id === this.currentSessionId);
    }

    private load(): HistoryFile {
        try {
            if (fs.existsSync(this.historyPath)) {
                const raw = fs.readFileSync(this.historyPath, 'utf-8');
                const parsed = JSON.parse(raw) as HistoryFile;
                if (parsed.version === 1 && Array.isArray(parsed.sessions)) {
                    this.logger.info(`History geladen: ${parsed.sessions.length} Sessions`);
                    return parsed;
                }
            }
        } catch (err) {
            this.logger.warn(`History-Datei konnte nicht geladen werden: ${(err as Error).message}`);
        }
        return { version: 1, lastUpdated: new Date().toISOString(), sessions: [] };
    }

    private save(): void {
        try {
            this.data.lastUpdated = new Date().toISOString();
            fs.writeFileSync(
                this.historyPath,
                JSON.stringify(this.data, null, 2),
                'utf-8'
            );
            const session = this.currentSession();
            this.logger.info(`History gespeichert: ${this.historyPath} (${session?.messages.length ?? 0} Nachrichten in aktueller Session)`);
        } catch (err) {
            this.logger.warn(`History konnte nicht gespeichert werden: ${this.historyPath} — ${(err as Error).message}`);
        }
    }

    /**
     * Session-Kennung – auf die Millisekunde plus Zufallsanhang.
     *
     * Mit Sekundenauflösung bekamen zwei Sitzungen, die in derselben Sekunde
     * beginnen, dieselbe Kennung. Dann findet `currentSession()` die ALTE
     * Sitzung und schreibt in sie hinein, und `lastFinishedSession()` hält sie
     * für die laufende – der Verlauf der Vorsitzung verschwindet also genau
     * dann, wenn man das Fenster schnell neu lädt.
     */
    private generateSessionId(): string {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const suffix = Math.random().toString(36).slice(2, 6);
        return `${stamp}-${suffix}`;
    }
}
