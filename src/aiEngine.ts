import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MCPClient, ChatMessage, StreamCallback } from './mcpClient';
import { FileManager } from './fileManager';
import { ShellRunner } from './shellRunner';
import { HistoryManager } from './historyManager';
import { Logger } from './logger';
import { ConfirmFn, autoConfirmFn } from './confirm';

export interface AIResponse {
    text: string;
    actions: ExecutedAction[];
    contextWarning?: string;    // gesetzt wenn Kontext-Limit naht
    iterations: number;         // Anzahl Repair-Iterationen
}

export interface ExecutedAction {
    type: 'file_create' | 'file_edit' | 'file_delete' | 'shell' | 'info';
    description: string;
    success: boolean;
    output?: string;
}

/** Callback der pro Repair-Iteration aufgerufen wird */
export type IterationCallback = (iteration: number, reason: string) => void;

/**
 * AIEngine: Verarbeitet Prompts, führt Aktionen aus, schreibt History.
 *
 * Features:
 *  - command.md: Liest workspace/command.md als permanente KI-Anweisung
 *  - Shell-Feedback-Loop: Bei fehlgeschlagenen Befehlen wird die Ausgabe
 *    automatisch zurück an die KI gegeben (max. 3 Iterationen)
 *  - History: Jede Konversation wird in ai-code-assistant.json gespeichert
 *  - Kontext-Warnung: Warnt wenn das Kontext-Limit des Modells naht
 */
export class AIEngine {
    private static instance: AIEngine;
    private mcpClient = MCPClient.getInstance();
    private fileManager = FileManager.getInstance();
    private shellRunner = ShellRunner.getInstance();
    private logger = Logger.getInstance();

    /** Konversationsverlauf (In-Memory, wird auch in History gespeichert) */
    private conversationHistory: ChatMessage[] = [];

    /** HistoryManager: wird lazy initialisiert wenn Workspace bekannt */
    private historyManager: HistoryManager | null = null;

    private constructor() {}

    static getInstance(): AIEngine {
        if (!AIEngine.instance) {
            AIEngine.instance = new AIEngine();
        }
        return AIEngine.instance;
    }

    resetConversation(): void {
        this.conversationHistory = [];
        this.logger.info('Konversationsverlauf zurückgesetzt.');
    }

    /** Laufende KI-Generierung abbrechen. */
    cancel(): void {
        this.mcpClient.cancel();
        this.logger.info('KI-Generierung vom Benutzer abgebrochen.');
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Haupt-Methode
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Benutzer-Prompt verarbeiten.
     *
     * @param userPrompt     Eingabe des Benutzers
     * @param onStream       Token-Streaming-Callback
     * @param confirmFn      In-Chat-Bestätigungsfunktion
     * @param onIteration    Callback wenn eine Repair-Iteration startet
     * @param _depth         Interne Rekursionstiefe (0 = erste Anfrage)
     */
    async process(
        userPrompt: string,
        onStream?: StreamCallback,
        confirmFn?: ConfirmFn,
        onIteration?: IterationCallback,
        _depth = 0
    ): Promise<AIResponse> {
        const config = vscode.workspace.getConfiguration('aiAssistant');
        const autoApply = config.get<boolean>('autoApply', false);
        const systemPromptBase = config.get<string>(
            'systemPrompt',
            'Du bist ein erfahrener Software-Entwickler und AI Code Assistant.'
        );

        const confirm: ConfirmFn = autoApply
            ? autoConfirmFn
            : (confirmFn ?? autoConfirmFn);

        // ── History-Manager initialisieren ──────────────────────────────────
        this.ensureHistoryManager();

        // ── command.md lesen ────────────────────────────────────────────────
        const commandMdContent = this.readCommandMd();

        // ── Workspace-Kontext aufbauen ───────────────────────────────────────
        let workspaceContext = '';
        try {
            const root = this.fileManager.getWorkspaceRoot();
            const tree = this.fileManager.getWorkspaceTree(80);
            workspaceContext = `\n\nAktueller Workspace: ${root}\n\nDateistruktur:\n${tree}`;

            // Aktive Editor-Datei einbinden (mit Zeilennummern für replace_lines)
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const relPath = path.relative(root, editor.document.uri.fsPath);
                const content = editor.document.getText();
                workspaceContext += `\n\nAktuell geöffnete Datei (${relPath}):\n\`\`\`\n${this.addLineNumbers(content, 300)}\n\`\`\``;
            }

            // Weitere im Prompt erwähnte Dateien automatisch einlesen
            const allFiles = this.fileManager.listFiles();
            const relFiles = allFiles.map(f => path.relative(root, f));
            const mentionedFiles = relFiles.filter(rel => {
                const filename = path.basename(rel);
                return userPrompt.includes(filename) || userPrompt.includes(rel);
            });

            for (const rel of mentionedFiles.slice(0, 3)) {
                const absPath = path.join(root, rel);
                if (editor && editor.document.uri.fsPath === absPath) continue;
                try {
                    const content = require('fs').readFileSync(absPath, 'utf-8');
                    workspaceContext += `\n\nErwähnte Datei (${rel}):\n\`\`\`\n${this.addLineNumbers(content, 250)}\n\`\`\``;
                } catch { /* ignorieren */ }
            }
        } catch {
            workspaceContext = '\n\n(Kein Workspace geöffnet)';
        }

        // ── Auto-Test-Instruktion ────────────────────────────────────────────
        const autoTest = config.get<boolean>('autoTest', false);
        const testInstruction = autoTest ? `

AUTO-TEST AKTIVIERT: Nach Dateiänderungen erkenne den passenden Test-Befehl anhand der
Projektstruktur (package.json→npm test, Cargo.toml→cargo test, pytest.ini→pytest,
go.mod→go test ./..., pom.xml→mvn test, build.gradle→./gradlew test, *.csproj→dotnet test)
und füge ihn als letzten action:shell Block an.` : '';

        // ── System-Prompt zusammenbauen ──────────────────────────────────────
        const fullSystemPrompt = [
            systemPromptBase,
            commandMdContent ? `\n\n## Permanente Anweisungen (command.md)\n${commandMdContent}` : '',
            workspaceContext,
            `\n\nDu kannst folgende Aktions-Blöcke in deiner Antwort verwenden:\n\n` +
            `Neue Datei erstellen:\n\`\`\`action:create_file\npath: pfad/zur/datei.ts\n---\n<VOLLSTÄNDIGER Dateiinhalt>\n\`\`\`\n\n` +
            `Bestehende Datei bearbeiten (IMMER vollständigen Inhalt angeben!):\n\`\`\`action:edit_file\npath: pfad/zur/datei.ts\n---\n<VOLLSTÄNDIGER neuer Dateiinhalt – ALLE bestehenden Zeilen müssen enthalten sein!>\n\`\`\`\n\n` +
            `Gezielte Zeilen ersetzen (optional, wenn Zeilennummern bekannt):\n\`\`\`action:replace_lines\npath: pfad/zur/datei.ts\nstart_line: 10\nend_line: 20\n---\n<neuer Code für genau diese Zeilen>\n\`\`\`\n\n` +
            `Datei löschen:\n\`\`\`action:delete_file\npath: pfad/zur/datei.ts\n\`\`\`\n\n` +
            `Shell-Befehl (WSL/Linux):\n\`\`\`action:shell\n<Befehl>\n\`\`\`\n\n` +
            `WICHTIG für edit_file: Schreibe IMMER den kompletten Dateiinhalt. Niemals nur den geänderten Teil – das würde den Rest der Datei löschen!\n` +
            `WICHTIG: Nutze KEINE Shell-Befehle wie cat, head, tail oder grep zum Lesen von Dateien – Dateiinhalte werden dir direkt im Kontext bereitgestellt.\n\n` +
            `Erkläre kurz was du tust.`,
            testInstruction
        ].join('');

        // ── Kontext-Größe schätzen ────────────────────────────────────────────
        const contextWarning = this.checkContextSize(fullSystemPrompt, userPrompt);

        // ── Nachrichten zusammenbauen ─────────────────────────────────────────
        const messages: ChatMessage[] = [
            { role: 'system', content: fullSystemPrompt },
            ...this.conversationHistory,
            { role: 'user', content: userPrompt }
        ];

        this.logger.info(`KI-Anfrage [depth=${_depth}]: "${userPrompt.slice(0, 80)}"`);

        // ── KI-Anfrage senden ─────────────────────────────────────────────────
        let rawResponse = '';
        try {
            const result = await this.mcpClient.complete(messages, {}, onStream);
            rawResponse = result.content;
        } catch (err) {
            this.logger.error('KI-Anfrage fehlgeschlagen', err);
            throw new Error(`KI nicht erreichbar: ${(err as Error).message}`);
        }

        // ── Konversationsverlauf pflegen ──────────────────────────────────────
        this.conversationHistory.push({ role: 'user', content: userPrompt });
        this.conversationHistory.push({ role: 'assistant', content: rawResponse });
        if (this.conversationHistory.length > 30) {
            this.conversationHistory = this.conversationHistory.slice(-30);
        }

        // ── Aktionen ausführen ────────────────────────────────────────────────
        const actions = await this.parseAndExecuteActions(rawResponse, confirm);
        const cleanText = this.stripActionBlocks(rawResponse);

        // ── History speichern ─────────────────────────────────────────────────
        if (_depth === 0) {
            this.historyManager?.addUserMessage(userPrompt);
        }
        this.historyManager?.addAssistantMessage(cleanText, actions.map(a => ({
            type: a.type,
            description: a.description,
            success: a.success,
            output: a.output
        })));

        // ── Shell-Feedback-Loop ───────────────────────────────────────────────
        const maxIterations = config.get<number>('autoFixIterations', 3);
        const autoFix = config.get<boolean>('autoFixOnError', true);

        const failedShells = actions.filter(
            a => a.type === 'shell' && !a.success && a.output?.trim()
        );

        if (failedShells.length > 0 && autoFix && _depth < maxIterations) {
            const shellContext = failedShells
                .map(a => `**Befehl:** \`${a.description.replace('Shell: ', '')}\`\n**Ausgabe:**\n\`\`\`\n${a.output}\n\`\`\``)
                .join('\n\n');

            const repairPrompt =
                `Folgende Shell-Befehle schlugen fehl. Analysiere die Ausgabe und ` +
                `korrigiere den Code entsprechend:\n\n${shellContext}`;

            this.logger.info(`Shell-Feedback-Loop Iteration ${_depth + 1}: ${failedShells.length} Fehler`);
            onIteration?.(_depth + 1, `${failedShells.length} Fehler gefunden – analysiere...`);

            const repairResult = await this.process(
                repairPrompt,
                onStream,
                confirmFn,
                onIteration,
                _depth + 1
            );

            return {
                text: cleanText,
                actions: [...actions, ...repairResult.actions],
                contextWarning,
                iterations: repairResult.iterations + 1
            };
        }

        return { text: cleanText, actions, contextWarning, iterations: _depth };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // command.md lesen
    // ──────────────────────────────────────────────────────────────────────────

    private readCommandMd(): string {
        try {
            const root = this.fileManager.getWorkspaceRoot();
            const cmdPath = path.join(root, 'command.md');
            if (fs.existsSync(cmdPath)) {
                const content = fs.readFileSync(cmdPath, 'utf-8').trim();
                if (content) {
                    this.logger.info(`command.md geladen (${content.length} Zeichen)`);
                    return content;
                }
            }
        } catch {
            // kein Workspace oder kein Zugriff
        }
        return '';
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Kontext-Größe prüfen
    // ──────────────────────────────────────────────────────────────────────────

    private checkContextSize(systemPrompt: string, userPrompt: string): string | undefined {
        const config = vscode.workspace.getConfiguration('aiAssistant');
        const maxTokens = config.get<number>('maxTokens', 2048);
        const warnThreshold = config.get<number>('contextWarningThreshold', 6000);

        // Grobe Token-Schätzung: 1 Token ≈ 4 Zeichen
        const historyChars = this.conversationHistory
            .reduce((sum, m) => sum + m.content.length, 0);
        const totalChars = systemPrompt.length + historyChars + userPrompt.length;
        const estimatedTokens = Math.round(totalChars / 4);

        this.logger.info(`Kontext-Schätzung: ~${estimatedTokens} Tokens (History: ${this.conversationHistory.length} Nachrichten)`);

        if (estimatedTokens > warnThreshold) {
            const percent = Math.round((estimatedTokens / warnThreshold) * 100);
            return `⚠ Kontext-Limit: ~${estimatedTokens} Tokens geschätzt (${percent}% des Schwellenwerts ${warnThreshold}). ` +
                   `Erwäge die Konversation zurückzusetzen (🔄 Neu) um Qualität zu erhalten.`;
        }
        return undefined;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Aktionen parsen & ausführen
    // ──────────────────────────────────────────────────────────────────────────

    private async parseAndExecuteActions(response: string, confirm: ConfirmFn): Promise<ExecutedAction[]> {
        const executed: ExecutedAction[] = [];
        // [^\n]* erlaubt trailing spaces/tabs nach dem Aktionstyp (Modelle fügen die oft hinzu)
        const blockPattern = /```action:(\w+)[^\n]*\n([\s\S]*?)```/g;
        let match: RegExpExecArray | null;

        // Debug: gefundene Blöcke loggen
        const allMatches: string[] = [];
        const debugPattern = /```action:(\w+)[^\n]*\n/g;
        let dbg: RegExpExecArray | null;
        while ((dbg = debugPattern.exec(response)) !== null) {
            allMatches.push(dbg[1]);
        }
        this.logger.info(`Aktions-Parser: ${allMatches.length} Block(e) gefunden: [${allMatches.join(', ')}]`);
        if (allMatches.length === 0) {
            // Ersten 400 Zeichen der Antwort loggen damit man sieht was das Modell ausgegeben hat
            this.logger.info(`Rohantwort (Anfang): ${response.slice(0, 400).replace(/\n/g, '↵')}`);
        }

        while ((match = blockPattern.exec(response)) !== null) {
            const actionType = match[1];
            const blockContent = match[2].trim();
            try {
                switch (actionType) {
                    case 'create_file':
                    case 'edit_file':
                        executed.push(await this.handleFileAction(actionType, blockContent, confirm));
                        break;
                    case 'replace_lines':
                        executed.push(await this.handleReplaceLinesAction(blockContent, confirm));
                        break;
                    case 'patch_file':
                        executed.push(await this.handlePatchAction(blockContent, confirm));
                        break;
                    case 'delete_file':
                        executed.push(await this.handleDeleteAction(blockContent, confirm));
                        break;
                    case 'shell':
                        executed.push(await this.handleShellAction(blockContent, confirm));
                        break;
                    default:
                        this.logger.warn(`Unbekannter Aktionstyp: ${actionType}`);
                }
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                this.logger.error(`Aktion '${actionType}' fehlgeschlagen: ${errMsg}`);
                executed.push({
                    type: 'info',
                    description: `Fehler bei Aktion '${actionType}': ${errMsg}`,
                    success: false,
                    output: errMsg
                });
            }
        }
        return executed;
    }

    private async handleFileAction(type: 'create_file' | 'edit_file', content: string, confirm: ConfirmFn): Promise<ExecutedAction> {
        // Separator-Suche: akzeptiert '---', '--- ', '---\r\n', '---\n', auch ohne Newline am Ende
        const sepMatch = content.match(/^---[ \t]*(\r?\n|$)/m);
        if (!sepMatch || sepMatch.index === undefined) throw new Error('Kein "---" Trenner im Aktionsblock gefunden');
        const pathMatch = content.slice(0, sepMatch.index).match(/^path:\s*(.+)$/m);
        if (!pathMatch) throw new Error('Kein "path:" gefunden');
        const filePath = pathMatch[1].trim();
        const fileContent = content.slice(sepMatch.index + sepMatch[0].length);

        // Smart-Merge bei edit_file: KI liefert oft nur einen Teil der Datei.
        // Wenn die neue Version deutlich kürzer ist → Smart-Merge statt vollem Replace.
        if (type === 'edit_file') {
            const existing = this.fileManager.readFile(filePath);
            if (existing && existing.length > 0) {
                const existingLines = existing.split('\n').length;
                const newLines = fileContent.split('\n').length;
                if (newLines < existingLines * 0.50 && existingLines > 20) {
                    this.logger.warn(
                        `edit_file: Neue Version hat ${newLines} Zeilen, Original hat ${existingLines}. ` +
                        `Starte Smart-Merge um ungewollte Löschungen zu verhindern.`
                    );
                    const ok = await this.fileManager.smartMergeEdit(filePath, fileContent, confirm);
                    return {
                        type: 'file_edit',
                        description: `${ok ? 'Smart-Merge' : 'Abgelehnt'}: ${filePath}`,
                        success: ok
                    };
                }
            }
        }

        // Fallback: Modelle verwechseln create_file/edit_file.
        // Wenn edit_file auf eine nicht-existierende Datei trifft → erstellen statt werfen.
        const fileExists = !!this.fileManager.readFile(filePath);
        let actualType = type;
        if (type === 'edit_file' && !fileExists) {
            this.logger.warn(`edit_file auf nicht-existierende Datei "${filePath}" – erstelle stattdessen.`);
            actualType = 'create_file';
        }

        const ok = actualType === 'create_file'
            ? await this.fileManager.createFile(filePath, fileContent, { overwrite: true, confirmFn: confirm })
            : await this.fileManager.editFile(filePath, fileContent, confirm);

        const verb = ok
            ? (actualType === 'create_file' ? 'Erstellt' : 'Bearbeitet')
            : 'Abgelehnt';
        return {
            type: actualType === 'create_file' ? 'file_create' : 'file_edit',
            description: `${verb}: ${filePath}`,
            success: ok
        };
    }

    private async handleReplaceLinesAction(content: string, confirm: ConfirmFn): Promise<ExecutedAction> {
        const sepMatch2 = content.match(/^---[ \t]*(\r?\n|$)/m);
        if (!sepMatch2 || sepMatch2.index === undefined) throw new Error('Kein "---" Trenner gefunden');

        const header = content.slice(0, sepMatch2.index);
        const pathMatch      = header.match(/^path:\s*(.+)$/m);
        const startLineMatch = header.match(/^start_line:\s*(\d+)$/m);
        const endLineMatch   = header.match(/^end_line:\s*(\d+)$/m);

        if (!pathMatch) throw new Error('Kein "path:" gefunden');

        const filePath   = pathMatch[1].trim();
        const newContent = content.slice(sepMatch2.index + sepMatch2[0].length);

        // Fallback: Datei existiert nicht → erstellen
        if (!this.fileManager.readFile(filePath)) {
            this.logger.warn(`replace_lines auf nicht-existierende Datei "${filePath}" – erstelle stattdessen.`);
            const ok = await this.fileManager.createFile(filePath, newContent, { overwrite: false, confirmFn: confirm });
            return { type: 'file_create', description: `${ok ? 'Erstellt' : 'Abgelehnt'}: ${filePath}`, success: ok };
        }

        if (!startLineMatch) throw new Error('Kein "start_line:" gefunden');
        if (!endLineMatch)   throw new Error('Kein "end_line:" gefunden');

        const startLine = parseInt(startLineMatch[1], 10);
        const endLine   = parseInt(endLineMatch[1], 10);

        if (isNaN(startLine) || isNaN(endLine) || startLine < 1 || endLine < startLine) {
            throw new Error(`Ungültige Zeilennummern: start=${startLine}, end=${endLine}`);
        }

        const ok = await this.fileManager.replaceLines(filePath, startLine, endLine, newContent, confirm);
        return {
            type: 'file_edit',
            description: `${ok ? 'Ersetzt' : 'Abgelehnt'} L${startLine}-${endLine}: ${filePath}`,
            success: ok
        };
    }

    private async handlePatchAction(content: string, confirm: ConfirmFn): Promise<ExecutedAction> {
        const sepMatch3 = content.match(/^---[ \t]*(\r?\n|$)/m);
        if (!sepMatch3 || sepMatch3.index === undefined) throw new Error('Kein "---" Trenner gefunden');
        const pathMatch = content.slice(0, sepMatch3.index).match(/^path:\s*(.+)$/m);
        if (!pathMatch) throw new Error('Kein "path:" gefunden');
        const filePath = pathMatch[1].trim();
        const patchBody = content.slice(sepMatch3.index + sepMatch3[0].length);

        // SEARCH/REPLACE-Blöcke parsen (mehrere pro Block möglich)
        // Marker akzeptieren auch trailing whitespace: <<<SEARCH>>> , <<<SEARCH>>>\r\n usw.
        const patchPattern = /<<<SEARCH>>>[ \t]*\r?\n([\s\S]*?)<<<REPLACE>>>[ \t]*\r?\n([\s\S]*?)<<<END>>>[ \t]*/g;
        let patchMatch: RegExpExecArray | null;
        const patches: { search: string; replace: string }[] = [];

        while ((patchMatch = patchPattern.exec(patchBody)) !== null) {
            patches.push({
                search: patchMatch[1],
                replace: patchMatch[2]
            });
        }

        if (patches.length === 0) {
            throw new Error('Keine gültigen <<<SEARCH>>>...<<<REPLACE>>>...<<<END>>> Blöcke gefunden');
        }

        let allSuccess = true;
        const errors: string[] = [];

        for (const patch of patches) {
            const result = await this.fileManager.patchFile(filePath, patch.search, patch.replace, confirm);
            if (!result.success) {
                allSuccess = false;
                if (result.error) errors.push(result.error);
            }
        }

        return {
            type: 'file_edit',
            description: `${allSuccess ? 'Gepacht' : 'Patch fehlgeschlagen'}: ${filePath} (${patches.length} Änderung${patches.length > 1 ? 'en' : ''})`,
            success: allSuccess,
            output: errors.length > 0 ? errors.join('\n') : undefined
        };
    }

    private async handleDeleteAction(content: string, confirm: ConfirmFn): Promise<ExecutedAction> {
        const pathMatch = content.match(/^path:\s*(.+)$/m);
        if (!pathMatch) throw new Error('Kein "path:" gefunden');
        const ok = await this.fileManager.deleteFile(pathMatch[1].trim(), confirm);
        return {
            type: 'file_delete',
            description: `${ok ? 'Gelöscht' : 'Abgelehnt'}: ${pathMatch[1].trim()}`,
            success: ok
        };
    }

    private async handleShellAction(command: string, confirm: ConfirmFn): Promise<ExecutedAction> {
        const config = vscode.workspace.getConfiguration('aiAssistant');
        if (!config.get<boolean>('allowShellCommands', true)) {
            return { type: 'shell', description: 'Shell deaktiviert', success: false, output: 'Shell-Befehle sind deaktiviert.' };
        }

        const trimmed = command.trim();
        const choice = await confirm(
            `Shell-Befehl ausführen (WSL):\n\`${trimmed}\``,
            ['Ausführen', 'Ablehnen']
        );
        if (choice !== 'Ausführen') {
            return { type: 'shell', description: `Abgelehnt: ${trimmed}`, success: false };
        }

        let workDir: string;
        try { workDir = this.fileManager.getWorkspaceRoot(); }
        catch { return { type: 'shell', description: 'Kein Workspace', success: false }; }

        const result = await this.shellRunner.run(trimmed, workDir, 120_000, confirm);
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 4000);
        return {
            type: 'shell',
            description: `Shell: ${trimmed.slice(0, 60)}`,
            success: result.exitCode === 0,
            output: output || '(keine Ausgabe)'
        };
    }

    /**
     * Fügt Zeilennummern zu Dateiinhalt hinzu (für den KI-Kontext).
     * Format: "   1 | erste Zeile"
     * Kürzt bei maxLines auf die ersten N Zeilen.
     */
    private addLineNumbers(content: string, maxLines = 300): string {
        const lines = content.split('\n');
        const truncated = lines.length > maxLines;
        const displayLines = truncated ? lines.slice(0, maxLines) : lines;
        const width = String(displayLines.length).length;
        const numbered = displayLines
            .map((l, i) => `${String(i + 1).padStart(width)} | ${l}`)
            .join('\n');
        return truncated
            ? numbered + `\n... [${lines.length - maxLines} weitere Zeilen gekürzt]`
            : numbered;
    }

    private stripActionBlocks(text: string): string {
        return text
            .replace(/<think>[\s\S]*?<\/think>/gi, '')   // Reasoning-Blöcke entfernen
            .replace(/```action:\w+\n[\s\S]*?```\n?/g, '')
            .trim();
    }

    // ──────────────────────────────────────────────────────────────────────────
    // History-Manager
    // ──────────────────────────────────────────────────────────────────────────

    private ensureHistoryManager(): void {
        if (this.historyManager) return;
        try {
            const root = this.fileManager.getWorkspaceRoot();
            this.historyManager = new HistoryManager(root);
        } catch {
            // kein Workspace → kein History
        }
    }

    getHistoryManager(): HistoryManager | null {
        return this.historyManager;
    }

    guessLanguage(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        const map: Record<string, string> = {
            '.ts': 'typescript', '.tsx': 'typescriptreact',
            '.js': 'javascript', '.jsx': 'javascriptreact',
            '.py': 'python', '.rs': 'rust', '.go': 'go',
            '.java': 'java', '.cs': 'csharp', '.cpp': 'cpp', '.c': 'c',
            '.sh': 'shellscript', '.md': 'markdown',
            '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
            '.html': 'html', '.css': 'css'
        };
        return map[ext] ?? 'plaintext';
    }
}
