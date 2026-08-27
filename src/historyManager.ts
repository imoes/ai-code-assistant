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
     * Nachrichten der letzten abgeschlossenen Session (nicht die aktuelle).
     * Wird beim Start geladen um den Konversationsverlauf wiederherzustellen.
     * Gibt max. `limit` Nachrichten zurück (neueste zuerst, dann umgekehrt).
     */
    getLastSessionMessages(limit = 20): HistoryMessage[] {
        const previous = this.data.sessions
            .filter(s => s.id !== this.currentSessionId);
        if (previous.length === 0) return [];
        const lastSession = previous[previous.length - 1];
        const msgs = lastSession.messages;
        const relevant = msgs.filter(m => m.role === 'user' || m.role === 'assistant');
        const sliced = relevant.slice(-limit);

        // Reasoning als Prefix in den assistant-Content einbetten,
        // damit es im nächsten Konversations-Kontext sichtbar ist.
        return sliced.map(m => {
            if (m.role === 'assistant' && m.reasoning) {
                return {
                    ...m,
                    content: `[Vorheriges Reasoning]\n${m.reasoning}\n\n[Antwort]\n${m.content}`
                };
            }
            return m;
        });
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

    private generateSessionId(): string {
        return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    }
}
