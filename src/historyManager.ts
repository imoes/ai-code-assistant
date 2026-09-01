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
    /**
     * The standing goal (`/goal`) – deliberately BESIDE the sessions, not inside one.
     *
     * The goal outlives the session: someone who sets out to get "all tests green"
     * still means it tomorrow. Inside a session it would be gone after the next
     * window reload – exactly when a long piece of work is starting.
     */
    goal?: string;
}

const MAX_SESSIONS = 50;        // Maximale Anzahl gespeicherter Sessions
const MAX_MESSAGES = 200;       // Maximale Nachrichten pro Session

/**
 * HistoryManager: Stores the conversation history as
 * `ai-code-assistant.json` in the workspace root.
 *
 * - New sessions are created on the first call to `startSession()`
 * - Every message is saved immediately after receipt
 * - Oldest sessions are deleted when MAX_SESSIONS is exceeded
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
     * Clear entire history – file and memory.
     *
     * The file is not deleted, but emptied: the path is in
     * Log messages and is visible in the Explorer, a suddenly missing
     * File appears to be an error.
     *
     * @returns Number of removed sessions
     */
    clearAll(): number {
        const removed = this.data.sessions.length;
        // The goal remains: "clear history" refers to the conversation, not the
        // intention. To drop it, use `/goal löschen`.
        const goal = this.data.goal;
        this.data = { version: 1, lastUpdated: new Date().toISOString(), sessions: [], goal };
        this.currentSessionId = this.generateSessionId();
        this.startSession();
        this.logger.info(`History cleared: ${removed} session(s) removed.`);
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

        // Trim oldest sessions
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

    /** Save AI response (incl. executed actions and reasoning summary) */
    addAssistantMessage(content: string, actions?: HistoryAction[], reasoning?: string): void {
        this.addMessage({
            role: 'assistant',
            content,
            timestamp: new Date().toISOString(),
            actions,
            reasoning
        });
    }

    /** Read the standing goal (empty = none set). */
    getGoal(): string {
        return this.data.goal ?? '';
    }

    /** Set the standing goal; empty text clears it. */
    setGoal(text: string): void {
        const clean = text.trim();
        if (clean) this.data.goal = clean;
        else delete this.data.goal;
        this.save();
    }

    /** Aktuelle Session-ID */
    getSessionId(): string {
        return this.currentSessionId;
    }

    /** Alle Sessions (neueste zuerst) */
    getSessions(): HistorySession[] {
        return [...this.data.sessions].reverse();
    }

    /** Messages of the current session */
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

        // Fill from the end: the most recent events are the most important.
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
     * The last session that is not the current one AND contains messages.
     *
     * Every window reload creates a session, even if nothing happens afterwards.
     * is requested. Without content validation, such an empty session hides the
     * last real session, and the history seems lost after two reloads.
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
            this.logger.warn(`Could not load the history file: ${(err as Error).message}`);
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
            this.logger.warn(`Could not save the history: ${this.historyPath} — ${(err as Error).message}`);
        }
    }

    /**
     * Session ID – down to the millisecond plus random suffix.
     *
     * With second resolution, two sessions that occurred in the same second
     * begin, the same identifier. Then `currentSession()` finds the OLD
     * Session and writes into it, and `lastFinishedSession()` keeps it
     * for the ongoing – the history of the chairing thus disappears exactly
     * then, if you quickly reload the window.
     */
    private generateSessionId(): string {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const suffix = Math.random().toString(36).slice(2, 6);
        return `${stamp}-${suffix}`;
    }
}
