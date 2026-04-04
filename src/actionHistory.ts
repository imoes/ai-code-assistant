import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';

export type ActionType =
    | 'file_create'
    | 'file_edit'
    | 'file_delete'
    | 'file_rename';

export interface AIAction {
    id: string;
    type: ActionType;
    timestamp: Date;
    description: string;
    /** Absoluter Pfad zur betroffenen Datei */
    filePath: string;
    /** Inhalt vor der Aktion (für Undo) – undefined bei neu erstellten Dateien */
    previousContent?: string;
    /** Neuer Pfad bei Umbenennung */
    newFilePath?: string;
}

/**
 * ActionHistory verwaltet alle KI-generierten Dateiänderungen.
 * Ermöglicht gezieltes oder vollständiges Rückgängigmachen.
 */
export class ActionHistory {
    private static instance: ActionHistory;
    private history: AIAction[] = [];
    private logger = Logger.getInstance();

    private constructor() {}

    static getInstance(): ActionHistory {
        if (!ActionHistory.instance) {
            ActionHistory.instance = new ActionHistory();
        }
        return ActionHistory.instance;
    }

    /** Neue Aktion registrieren (vor der Ausführung aufrufen!) */
    record(action: Omit<AIAction, 'id' | 'timestamp'>): AIAction {
        const entry: AIAction = {
            ...action,
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date()
        };
        this.history.push(entry);
        this.logger.action(entry.type, `${entry.description} → ${entry.filePath}`);
        return entry;
    }

    /** Letzte Aktion aus dem Verlauf holen (ohne Entfernen) */
    getLast(): AIAction | undefined {
        return this.history[this.history.length - 1];
    }

    /** Alle Aktionen in umgekehrter Reihenfolge */
    getAll(): AIAction[] {
        return [...this.history].reverse();
    }

    /**
     * Letzte KI-Aktion rückgängig machen.
     * Gibt zurück ob erfolgreich.
     */
    async undoLast(): Promise<boolean> {
        const action = this.history.pop();
        if (!action) {
            vscode.window.showInformationMessage('Kein KI-Verlauf zum Rückgängigmachen.');
            return false;
        }
        return this.revertAction(action);
    }

    /**
     * Alle KI-Aktionen in umgekehrter Reihenfolge rückgängig machen.
     */
    async undoAll(): Promise<void> {
        const toRevert = [...this.history].reverse();
        this.history = [];
        let successCount = 0;
        for (const action of toRevert) {
            const ok = await this.revertAction(action);
            if (ok) successCount++;
        }
        vscode.window.showInformationMessage(
            `${successCount} von ${toRevert.length} KI-Aktionen rückgängig gemacht.`
        );
    }

    private async revertAction(action: AIAction): Promise<boolean> {
        try {
            switch (action.type) {
                case 'file_create':
                    // Erstellte Datei löschen
                    if (fs.existsSync(action.filePath)) {
                        fs.unlinkSync(action.filePath);
                        this.logger.info(`UNDO: Datei gelöscht: ${action.filePath}`);
                    }
                    break;

                case 'file_edit':
                    // Datei auf vorherigen Inhalt zurücksetzen
                    if (action.previousContent !== undefined) {
                        fs.writeFileSync(action.filePath, action.previousContent, 'utf-8');
                        this.logger.info(`UNDO: Dateiinhalt wiederhergestellt: ${action.filePath}`);
                    }
                    break;

                case 'file_delete':
                    // Gelöschte Datei wiederherstellen
                    if (action.previousContent !== undefined) {
                        const dir = path.dirname(action.filePath);
                        fs.mkdirSync(dir, { recursive: true });
                        fs.writeFileSync(action.filePath, action.previousContent, 'utf-8');
                        this.logger.info(`UNDO: Datei wiederhergestellt: ${action.filePath}`);
                    }
                    break;

                case 'file_rename':
                    // Umbenannte Datei zurückbenennen
                    if (action.newFilePath && fs.existsSync(action.newFilePath)) {
                        fs.renameSync(action.newFilePath, action.filePath);
                        this.logger.info(`UNDO: Datei zurückbenannt: ${action.newFilePath} → ${action.filePath}`);
                    }
                    break;
            }
            return true;
        } catch (err) {
            this.logger.error(`UNDO fehlgeschlagen für ${action.filePath}`, err);
            return false;
        }
    }

    /** Verlauf leeren */
    clear(): void {
        this.history = [];
    }
}
