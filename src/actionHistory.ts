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
    /** Absolute path to the affected file */
    filePath: string;
    /** Content before the action (for Undo) – undefined for newly created files */
    previousContent?: string;
    /** New path on rename */
    newFilePath?: string;
}

/**
 * ActionHistory manages all AI-generated file changes.
 * Enables targeted or complete undo.
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

    /** Register new action (call before execution!) */
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

    /** Get last action from history (without removing) */
    getLast(): AIAction | undefined {
        return this.history[this.history.length - 1];
    }

    /** Alle Aktionen in umgekehrter Reihenfolge */
    getAll(): AIAction[] {
        return [...this.history].reverse();
    }

    /**
     * Undo the last AI action.
     * Returns whether successful.
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
     * Undo all AI actions in reverse order.
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
                    // Delete created file
                    if (fs.existsSync(action.filePath)) {
                        fs.unlinkSync(action.filePath);
                        this.logger.info(`UNDO: Datei gelöscht: ${action.filePath}`);
                    }
                    break;

                case 'file_edit':
                    // Reset file to previous content
                    if (action.previousContent !== undefined) {
                        fs.writeFileSync(action.filePath, action.previousContent, 'utf-8');
                        this.logger.info(`UNDO: Dateiinhalt wiederhergestellt: ${action.filePath}`);
                    }
                    break;

                case 'file_delete':
                    // Restore deleted file
                    if (action.previousContent !== undefined) {
                        const dir = path.dirname(action.filePath);
                        fs.mkdirSync(dir, { recursive: true });
                        fs.writeFileSync(action.filePath, action.previousContent, 'utf-8');
                        this.logger.info(`UNDO: Datei wiederhergestellt: ${action.filePath}`);
                    }
                    break;

                case 'file_rename':
                    // Rename renamed file back
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
