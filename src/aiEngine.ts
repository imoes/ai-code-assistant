import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MCPClient, ChatMessage, StreamCallback, GenerationStats } from './mcpClient';
import { FileManager } from './fileManager';
import { ShellRunner } from './shellRunner';
import { HistoryManager } from './historyManager';
import { Logger } from './logger';
import { ConfirmFn, autoConfirmFn } from './confirm';
import { WebSearcher } from './webSearch';
import { CodeAnalyzer } from './codeAnalyzer';
import { AgentConsole } from './agentConsole';
import {
    toolsForMode,
    READ_ONLY_ACTIONS,
    toolCallsToActionBlocks,
    normalizeToolCalls,
    stripToolCallMarkup,
    stripToolMarkupFromCode,
    toolCallsToActions
} from './toolCallParser';

/** Arbeitsmodus des Assistenten. */
export type AssistantMode = 'ask' | 'auto' | 'plan';

/**
 * Aktuellen Arbeitsmodus lesen.
 *
 * `aiAssistant.mode` ist die Quelle der Wahrheit. Nur solange niemand sie
 * gesetzt hat, gilt das alte `autoApply` weiter – damit bestehende Installationen
 * nach dem Update nicht plötzlich im falschen Modus laufen.
 */
export function getAssistantMode(): AssistantMode {
    const config = vscode.workspace.getConfiguration('aiAssistant');
    const inspected = config.inspect<string>('mode');
    const explicit = inspected?.globalValue
        ?? inspected?.workspaceValue
        ?? inspected?.workspaceFolderValue;

    if (explicit === 'ask' || explicit === 'auto' || explicit === 'plan') {
        return explicit;
    }
    return config.get<boolean>('autoApply', false) ? 'auto' : 'ask';
}

export interface AIResponse {
    text: string;
    actions: ExecutedAction[];
    contextWarning?: string;    // gesetzt wenn Kontext-Limit naht
    iterations: number;         // Anzahl Repair-Iterationen
}

export interface ExecutedAction {
    type: 'file_create' | 'file_edit' | 'file_delete' | 'shell' | 'web_search'
        | 'analysis' | 'plan' | 'info';
    description: string;
    success: boolean;
    output?: string;
}

/** Ein Schritt im Arbeitsplan des Assistenten. */
export interface PlanStep {
    text: string;
    status: 'todo' | 'doing' | 'done';
}

/** Callback wenn der Assistent seinen Plan erstellt oder aktualisiert. */
export type PlanCallback = (steps: PlanStep[]) => void;

/** Callback der pro Repair-Iteration aufgerufen wird */
export type IterationCallback = (iteration: number, reason: string) => void;

/** Callback für laufende Aktionen (Shell-Output, Suche, …) */
export type ActionProgressCallback = (description: string, output: string) => void;

/** Callback für laufende Kennzahlen (Prompt-Fortschritt, Tokens, Tokens/s) */
export type StatsProgressCallback = (stats: GenerationStats) => void;

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
    private analyzer = CodeAnalyzer.getInstance();
    private console = AgentConsole.getInstance();
    private logger = Logger.getInstance();

    /** Aktueller Arbeitsplan (Todo-Liste) der laufenden Aufgabe */
    private plan: PlanStep[] = [];

    /** Callback um den Plan im Chat anzuzeigen */
    private onPlanUpdate?: PlanCallback;

    /** Callback für laufende Kennzahlen (Fortschritt, Tokens/Sekunde) */
    private onStats?: StatsProgressCallback;

    /** Von der KI gesetztes Signal, dass die Aufgabe abgeschlossen ist */
    private taskComplete = false;

    /** Plan-Modus: nur lesen und planen, keine Änderungen */
    private planModeActive = false;

    /** Fingerabdruck der Aktionen der letzten Runde – erkennt Kreisläufe */
    private lastActionSignature = '';

    /** Wie oft dieselbe Runde in Folge auftrat */
    private repeatCount = 0;

    /** Konversationsverlauf (In-Memory, wird auch in History gespeichert) */
    private conversationHistory: ChatMessage[] = [];

    /** HistoryManager: wird lazy initialisiert wenn Workspace bekannt */
    private historyManager: HistoryManager | null = null;

    /** Verhindert doppeltes Laden der History */
    private historyLoaded = false;

    private constructor() {}

    static getInstance(): AIEngine {
        if (!AIEngine.instance) {
            AIEngine.instance = new AIEngine();
        }
        return AIEngine.instance;
    }

    resetConversation(): void {
        this.conversationHistory = [];
        this.plan = [];
        this.taskComplete = false;
        this.historyLoaded = true; // Kein erneutes Laden nach Reset
        this.historyManager?.startSession(); // Neue Session beginnen
        this.logger.info('Konversationsverlauf zurückgesetzt.');
    }

    /** Callback registrieren, über den Planänderungen in den Chat gemeldet werden. */
    setPlanCallback(cb: PlanCallback | undefined): void {
        this.onPlanUpdate = cb;
    }

    /** Callback registrieren, über den Kennzahlen in den Chat gemeldet werden. */
    setStatsCallback(cb: StatsProgressCallback | undefined): void {
        this.onStats = cb;
    }

    /** Aktuellen Arbeitsplan abfragen. */
    getPlan(): PlanStep[] {
        return this.plan.map(s => ({ ...s }));
    }

    /**
     * Gesamten gespeicherten Verlauf löschen – Datei und laufende Konversation.
     *
     * @returns Anzahl der entfernten Sessions
     */
    clearHistory(): number {
        this.ensureHistoryManager();
        const removed = this.historyManager?.clearAll() ?? 0;
        this.conversationHistory = [];
        this.plan = [];
        this.taskComplete = false;
        this.historyLoaded = true;
        return removed;
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
        _depth = 0,
        onActionProgress?: ActionProgressCallback
    ): Promise<AIResponse> {
        const config = vscode.workspace.getConfiguration('aiAssistant');
        const mode = getAssistantMode();
        const autoApply = mode === 'auto';
        const systemPromptBase = config.get<string>(
            'systemPrompt',
            'Du bist ein erfahrener Software-Entwickler und AI Code Assistant.'
        );

        const confirm: ConfirmFn = autoApply
            ? autoConfirmFn
            : (confirmFn ?? autoConfirmFn);

        // Neue Benutzer-Aufgabe → Abschluss-Signal und alten Plan verwerfen
        if (_depth === 0) {
            this.taskComplete = false;
            this.plan = [];
            this.lastActionSignature = '';
            this.repeatCount = 0;
            this.logger.info(`Arbeitsmodus: ${mode}`);

            // Arbeitsprotokoll im Terminal beginnen, wenn gewünscht
            if (config.get<boolean>('showConsole', true)) {
                this.console.task(userPrompt, mode);
                this.console.show(false);   // anlegen, aber nicht den Fokus klauen
            }
        }

        // Im Plan-Modus sind Änderungen gesperrt – auch dann, wenn das Modell
        // sie trotzdem versucht (siehe blockedInPlanMode).
        this.planModeActive = mode === 'plan';

        // ── History-Manager initialisieren ──────────────────────────────────
        this.ensureHistoryManager();

        // ── Projekt-Anweisungen lesen (AGENTS.md, CLAUDE.md, command.md …) ──
        const commandMdContent = this.readInstructionFiles();

        // ── Workspace-Kontext aufbauen ───────────────────────────────────────
        let workspaceContext = '';
        try {
            const root = this.fileManager.getWorkspaceRoot();
            const allFilesList = this.fileManager.listFiles();
            this.logger.info(`Workspace-Scan: ${allFilesList.length} Datei(en) in ${root}`);
            workspaceContext = `\n\n## Projekt\n${this.analyzer.projectOverview()}`;

            // Aktive Editor-Datei und im Prompt erwähnte Dateien vorab einbinden.
            // Bewusst auf 600 Zeilen begrenzt: den Rest holt sich der Assistent
            // gezielt mit read_file, statt den Kontext blind vollzuschreiben.
            const PRELOAD_LINES = 600;

            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const relPath = path.relative(root, editor.document.uri.fsPath);
                const content = editor.document.getText();
                workspaceContext += `\n\n## Aktuell geöffnete Datei (${relPath})\n` +
                    `\`\`\`\n${this.addLineNumbers(content, PRELOAD_LINES)}\n\`\`\``;
            }

            // Weitere im Prompt erwähnte Dateien automatisch einlesen
            const relFiles = allFilesList.map(f => path.relative(root, f));
            const mentionedFiles = relFiles.filter(rel => {
                const filename = path.basename(rel);
                return userPrompt.includes(filename) || userPrompt.includes(rel);
            });

            for (const rel of mentionedFiles.slice(0, 3)) {
                const absPath = path.join(root, rel);
                if (editor && editor.document.uri.fsPath === absPath) continue;
                try {
                    const content = fs.readFileSync(absPath, 'utf-8');
                    workspaceContext += `\n\n## Erwähnte Datei (${rel})\n` +
                        `\`\`\`\n${this.addLineNumbers(content, PRELOAD_LINES)}\n\`\`\``;
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
        // Reihenfolge: STABIL zuerst, VERÄNDERLICH zuletzt.
        // llama.cpp cacht den gemeinsamen Prompt-Präfix zwischen Anfragen. In einer
        // Agenten-Schleife mit 12 Runden ist das der Unterschied zwischen einmaliger
        // und zwölffacher Prompt-Auswertung. Alles, was sich pro Runde ändert
        // (Dateiinhalte, Plan), muss daher ans ENDE – sonst ist der Cache ab dort
        // wertlos und das große Werkzeug-Handbuch wird jede Runde neu ausgewertet.
        const fullSystemPrompt = [
            systemPromptBase,
            commandMdContent ? `\n\n## Permanente Projekt-Anweisungen\n${commandMdContent}` : '',
            this.buildToolManual(),
            testInstruction,
            workspaceContext,
            this.buildPlanContext()
        ].join('');

        // ── Kontext-Größe schätzen ────────────────────────────────────────────
        // Verlauf komprimieren, BEVOR die Anfrage rausgeht – sonst platzt sie.
        const compactNote = await this.compactHistoryIfNeeded(fullSystemPrompt);
        if (compactNote) {
            onActionProgress?.('🗜 Verlauf komprimiert', compactNote);
        }

        const contextWarning = this.checkContextSize(fullSystemPrompt, userPrompt);

        // ── Automatische Web-Suche bei Schlüsselwörtern ───────────────────────
        let searchContext = '';
        if (_depth === 0 && this.detectSearchIntent(userPrompt)) {
            onActionProgress?.('🔍 Suchbegriff wird optimiert…', userPrompt.slice(0, 80));
            const searchQuery = await this.extractSearchQuery(userPrompt);
            onActionProgress?.('🔍 Web-Suche läuft…', searchQuery);
            try {
                const searcher = WebSearcher.getInstance();
                const searchResult = await searcher.search(searchQuery, 5);
                searchContext = '\n\n' + searcher.formatForAI(searchResult);
                onActionProgress?.('🔍 Web-Suche abgeschlossen', `${searchResult.results.length} Ergebnis(se) für "${searchQuery}"`);
                this.logger.info(`Auto-Suche: "${searchQuery}" → ${searchResult.results.length} Ergebnis(se)`);
            } catch (err) {
                this.logger.warn(`Auto-Suche fehlgeschlagen: ${(err as Error).message}`);
            }
        }

        // ── Nachrichten zusammenbauen ─────────────────────────────────────────
        const effectivePrompt = searchContext
            ? `${userPrompt}\n\n${searchContext}`
            : userPrompt;

        const messages: ChatMessage[] = [
            { role: 'system', content: fullSystemPrompt },
            ...this.conversationHistory,
            { role: 'user', content: effectivePrompt }
        ];

        this.logger.info(`KI-Anfrage [depth=${_depth}]: "${userPrompt.slice(0, 80)}"`);

        // ── KI-Anfrage senden ─────────────────────────────────────────────────
        // Werkzeuge im OpenAI-Schema mitsenden, wenn aktiviert. llama.cpp rendert
        // sie ins Format des Modells und parst die Antwort zurück – deshalb
        // funktioniert das mit Qwen, Gemma, Kimi, laguna, DeepSeek gleichermaßen.
        const useNativeTools = config.get<boolean>('nativeToolCalls', true);

        let rawResponse = '';
        let nativeCalls = '';
        /** Ansagen aus den Werkzeugaufrufen (`absicht`) – siehe unten */
        let toolIntents: string[] = [];
        try {
            const result = await this.mcpClient.complete(
                messages,
                {
                    ...(useNativeTools ? { tools: toolsForMode(mode) } : {}),
                    ...(this.onStats ? { onStats: this.onStats } : {})
                },
                onStream
            );
            rawResponse = result.content;

            if (result.toolCalls?.length) {
                const converted = toolCallsToActions(result.toolCalls, this.logger);
                nativeCalls = converted.blocks;
                toolIntents = converted.intents;
            }
        } catch (err) {
            this.logger.error('KI-Anfrage fehlgeschlagen', err);
            throw new Error(`KI nicht erreichbar: ${(err as Error).message}`);
        }

        // Reasoning-Modelle (laguna, DeepSeek R1, Qwen …) entwerfen im <think>-Block
        // oft Aktions-Blöcke, die sie danach verwerfen oder anders ausführen. Die
        // dürfen NICHT ausgeführt werden – nur die eigentliche Antwort zählt.
        //
        // Hat der Server Werkzeugaufrufe geliefert, sind DIE die Wahrheit: der
        // Antworttext ist dann Prosa. Sonst wird der Text geparst – als Rückfall
        // für Server ohne --jinja und Modelle, die die Werkzeuge ignorieren und
        // ihr Format trotzdem in den Text schreiben. (Die Textnormalisierung
        // passiert in parseAndExecuteActions.)
        const actionSource = nativeCalls || this.stripReasoning(rawResponse);

        // ── Konversationsverlauf pflegen ──────────────────────────────────────
        // Ohne Reasoning: der Denkteil ist für die nächste Runde wertlos, würde
        // aber den Kontext volllaufen lassen (bei Reasoning-Modellen oft das
        // Mehrfache der eigentlichen Antwort).
        this.conversationHistory.push({ role: 'user', content: userPrompt });
        this.conversationHistory.push({ role: 'assistant', content: actionSource.trim() || rawResponse });
        if (this.conversationHistory.length > 30) {
            this.conversationHistory = this.conversationHistory.slice(-30);
        }
        // Ansage des Assistenten VOR den Aktionen – sonst stehen die Aktionen
        // ohne Begründung da.
        //
        // Bei nativen Werkzeugaufrufen liefern Modelle `content: null`: sie
        // stecken alles in den Aufruf und schreiben keine Prosa. Deshalb tragen
        // die Werkzeuge ein Feld `absicht`, das hier einspringt.
        const prose = this.cleanForDisplay(rawResponse);
        const cleanText = prose || toolIntents.join('\n');
        this.console.narration(cleanText);

        const actions = await this.parseAndExecuteActions(actionSource, confirm, onActionProgress);
        const thinkingBlock = this.extractThinkingBlock(rawResponse);

        // ── Beispiel-Erkennung: KI hat nur Beispiel gezeigt statt zu handeln ──
        if (_depth === 0 && actions.length === 0 && config.get<boolean>('autoFixOnError', true)) {
            const hasCodeBlock = /```[\w\s]*\n[\s\S]+?```/.test(actionSource);
            const looksLikeExample = hasCodeBlock && /beispiel|example|so könnte|hier ist wie|du kannst|you can|hier ein|so würde/i.test(actionSource);
            if (looksLikeExample) {
                this.logger.info('Beispiel-Erkennung: KI hat Beispiel ohne Aktion gegeben → Korrektur-Prompt');
                onIteration?.(1, 'Beispiel erkannt – fordere direkte Umsetzung…');
                const correctionPrompt =
                    `Du hast nur ein Beispiel gezeigt ohne den Code direkt zu ändern.\n` +
                    `Setze die Aufgabe JETZT mit Aktions-Blöcken um (action:edit_file oder action:create_file).\n` +
                    `Falls etwas unklar ist, stelle EINE konkrete Frage statt ein Beispiel zu zeigen.`;
                const correctionResult = await this.process(
                    correctionPrompt, onStream, confirmFn, onIteration, 1, onActionProgress
                );
                return {
                    text: cleanText,
                    actions: [...actions, ...correctionResult.actions],
                    contextWarning,
                    iterations: correctionResult.iterations + 1
                };
            }
        }

        // ── History speichern ─────────────────────────────────────────────────
        if (!this.historyManager) {
            this.logger.warn('History: HistoryManager ist null – kein Eintrag gespeichert.');
        } else {
            if (_depth === 0) {
                this.historyManager.addUserMessage(userPrompt);
            }
            const reasoning = this.buildReasoningSummary(userPrompt, thinkingBlock, actions);
            this.historyManager.addAssistantMessage(cleanText, actions.map(a => ({
                type: a.type,
                description: a.description,
                success: a.success,
                output: a.output
            })), reasoning);
        }

        // ── Agenten-Schleife ──────────────────────────────────────────────────
        const step = this.planNextStep(actions, _depth, config);

        if (step) {
            this.logger.info(`Agenten-Schleife Schritt ${_depth + 1}: ${step.reason}`);
            this.console.step(_depth + 1, step.reason);
            onIteration?.(_depth + 1, step.reason);

            const nextResult = await this.process(
                step.prompt,
                onStream,
                confirmFn,
                onIteration,
                _depth + 1,
                onActionProgress
            );

            return {
                text: cleanText,
                actions: [...actions, ...nextResult.actions],
                contextWarning,
                iterations: nextResult.iterations + 1
            };
        }

        return { text: cleanText, actions, contextWarning, iterations: _depth };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Agenten-Schleife: entscheidet, ob und wie weitergearbeitet wird
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Nächsten Schritt der Agenten-Schleife bestimmen.
     *
     * Weitergearbeitet wird, wenn nach dieser Runde noch etwas offen ist:
     *  - Analyse-Ergebnisse liegen vor  → die KI muss sie jetzt verwerten
     *  - Shell-Befehl ist fehlgeschlagen → Fehler analysieren und beheben
     *  - Befehlsausgabe ohne Codeänderung → auf Basis der Ausgabe handeln
     *  - Der Plan hat noch offene Schritte → nächsten Schritt abarbeiten
     *
     * Abgebrochen wird bei action:done, bei erreichtem Schrittlimit oder wenn
     * nichts mehr offen ist.
     *
     * @returns Prompt + Begründung für die nächste Runde, oder null zum Beenden
     */
    private planNextStep(
        actions: ExecutedAction[],
        depth: number,
        config: vscode.WorkspaceConfiguration
    ): { prompt: string; reason: string } | null {
        const agentLoop = config.get<boolean>('agentLoop', true);
        const autoFix = config.get<boolean>('autoFixOnError', true);
        const maxSteps = agentLoop
            ? config.get<number>('maxAgentSteps', 12)
            : config.get<number>('autoFixIterations', 3);

        // Die KI hat die Aufgabe selbst als fertig gemeldet
        if (this.taskComplete) {
            this.logger.info('Agenten-Schleife beendet: action:done erhalten.');
            return null;
        }

        if (depth >= maxSteps) {
            this.logger.warn(`Agenten-Schleife beendet: Schrittlimit ${maxSteps} erreicht.`);
            return null;
        }

        const analyses = actions.filter(a => a.type === 'analysis' && a.output?.trim());
        const failedShells = actions.filter(a => a.type === 'shell' && !a.success && a.output?.trim());

        // Fehlgeschlagene Änderungen (Patch griff nicht, Datei fehlt, abgelehnt).
        // Die MÜSSEN zurückgemeldet werden: sonst wiederholt das Modell denselben
        // Patch endlos, weil es nie erfährt, dass er nicht gegriffen hat.
        const isFileAction = (t: ExecutedAction['type']) =>
            t === 'file_create' || t === 'file_edit' || t === 'file_delete';
        const failedFileActions = actions.filter(
            a => (isFileAction(a.type) || a.type === 'info') && !a.success && a.output?.trim()
        );

        // Nur ERFOLGREICHE Änderungen zählen als getane Arbeit. Vorher galt auch
        // ein gescheiterter Patch als Dateiänderung – dadurch wurden die
        // Befehlsausgaben unterdrückt und die Schleife lief blind weiter.
        const hasFileActions = actions.some(a => isFileAction(a.type) && a.success);

        // ── Wiederholung erkennen ─────────────────────────────────────────────
        // Liefert eine Runde exakt dasselbe Ergebnis wie die vorherige, bringt
        // Weitermachen nichts: das Modell dreht sich im Kreis.
        const signature = actions
            .map(a => `${a.success ? '+' : '-'}${a.type}:${a.description}`)
            .join('|');
        if (signature && signature === this.lastActionSignature) {
            this.repeatCount++;
        } else {
            this.repeatCount = 0;
            this.lastActionSignature = signature;
        }
        if (this.repeatCount >= 2) {
            this.logger.warn(
                `Agenten-Schleife beendet: dieselbe Runde ${this.repeatCount + 1}× wiederholt ` +
                `(${signature.slice(0, 160)}). Das Modell kommt nicht weiter.`
            );
            return null;
        }
        // Erfolgreiche Ausgaben nur weiterleiten wenn KEINE Dateiänderung stattfand
        // (= die KI hat nur Infos gesammelt, aber noch nichts umgesetzt)
        const successfulWithOutput = !hasFileActions
            ? actions.filter(a =>
                (a.type === 'shell' || a.type === 'web_search') && a.success && a.output?.trim()
                && !a.description.startsWith('Datei gelesen:'))
            : [];

        // ── 1. Fehlgeschlagene Shell-Befehle: Fehler beheben ──────────────────
        if (failedShells.length > 0 && autoFix) {
            const userInstruction = failedShells.find(a => a.output?.startsWith('Benutzer-Anweisung:'));
            const ctx = this.formatOutputs(failedShells);

            if (userInstruction) {
                return {
                    reason: 'Benutzer-Anweisung erhalten – setze um…',
                    prompt: `Der Benutzer hat folgende Anweisung gegeben:\n\n${ctx}\n\n` +
                        `Setze die Anweisung sofort mit Aktions-Blöcken um.`
                };
            }
            return {
                reason: `${failedShells.length} Fehler gefunden – analysiere…`,
                prompt:
                    `FEHLER-ANALYSE ERFORDERLICH:\n\n${ctx}\n\n` +
                    `Analysiere die Fehlerausgabe genau. Was ist die Ursache? ` +
                    `Falls du dafür Code sehen musst: nutze read_file oder grep. ` +
                    `Korrigiere den Fehler dann mit den passenden Aktions-Blöcken. ` +
                    `Antworte NICHT mit "okay" oder einer Erklärung ohne Aktion.`
            };
        }

        // ── 1b. Änderung ist nicht durchgegangen: Ursache zurückmelden ────────
        if (failedFileActions.length > 0 && autoFix) {
            return {
                reason: `${failedFileActions.length} Änderung(en) nicht angewendet – korrigiere…`,
                prompt:
                    `EINE ÄNDERUNG WURDE NICHT ANGEWENDET:\n\n` +
                    `${this.formatOutputs(failedFileActions)}\n\n` +
                    `Lies die Begründung genau. Wiederhole NICHT denselben Aufruf.\n` +
                    `- Ist die Änderung laut Meldung schon vorhanden: gehe zum nächsten Punkt weiter.\n` +
                    `- Passt der Suchtext nicht: lies die Datei mit read_file neu und patche gegen ` +
                    `den tatsächlichen Inhalt, oder nutze replace_lines mit Zeilennummern.\n` +
                    `- Ist alles erledigt: schließe mit action:done ab.`
            };
        }

        // ── 2. Analyse-Ergebnisse liegen vor: jetzt verwerten ─────────────────
        if (analyses.length > 0 && agentLoop) {
            const ctx = this.formatOutputs(analyses);
            const labels = analyses.map(a => a.description).join(', ');
            return {
                reason: `Analyse ausgewertet (${labels.slice(0, 90)}) – arbeite weiter…`,
                prompt:
                    `ERGEBNISSE DEINER CODE-ANALYSE:\n\n${ctx}\n\n` +
                    `Du hast den Code jetzt gesehen. Arbeite an der ursprünglichen Aufgabe weiter:\n` +
                    `- Brauchst du noch mehr Kontext? → weitere read_file / grep Aktionen\n` +
                    `- Weißt du genug? → setze die Änderung jetzt um (patch_file / replace_lines / create_file)\n` +
                    `- Ist alles erledigt? → \`\`\`action:done\nzusammenfassung: …\n\`\`\`\n` +
                    `Wiederhole NICHT die gleiche Analyse-Aktion.`
            };
        }

        // ── 3. Befehlsausgabe ohne Codeänderung: darauf reagieren ─────────────
        if (successfulWithOutput.length > 0 && autoFix) {
            return {
                reason: 'Ausgaben empfangen – analysiere…',
                prompt:
                    `BEFEHLSAUSGABE – ANALYSE UND HANDLUNG ERFORDERLICH:\n\n` +
                    `${this.formatOutputs(successfulWithOutput)}\n\n` +
                    `Analysiere diese Ausgabe im Kontext der ursprünglichen Aufgabe und führe sofort ` +
                    `die nächsten notwendigen Schritte aus (Aktions-Blöcke). ` +
                    `Ist die Aufgabe damit erledigt, schließe mit action:done ab.`
            };
        }

        // ── 4. Plan hat offene Schritte: weiterarbeiten ───────────────────────
        const openSteps = this.plan.filter(s => s.status !== 'done');
        if (agentLoop && config.get<boolean>('planningEnabled', true)
            && this.plan.length > 0 && openSteps.length > 0 && actions.length > 0) {
            const next = openSteps[0];
            return {
                reason: `Plan: ${this.plan.length - openSteps.length}/${this.plan.length} erledigt – nächster Schritt…`,
                prompt:
                    `PLAN FORTSETZEN. Noch offen:\n` +
                    openSteps.map(s => `- [${s.status === 'doing' ? '>' : ' '}] ${s.text}`).join('\n') +
                    `\n\nArbeite jetzt den nächsten Schritt ab: "${next.text}"\n` +
                    `Aktualisiere danach den Plan mit action:plan (vollständige Liste). ` +
                    `Sind alle Schritte erledigt, schließe mit action:done ab.`
            };
        }

        return null;
    }

    /** Aktions-Ausgaben als Kontext-Block für die nächste Runde formatieren. */
    private formatOutputs(actions: ExecutedAction[]): string {
        return actions.map(a => {
            if (a.output?.startsWith('Benutzer-Anweisung:')) {
                return `**${a.output}**`;
            }
            const status = a.success ? '✅' : '❌';
            return `${status} ${a.description}\n\`\`\`\n${a.output}\n\`\`\``;
        }).join('\n\n');
    }

    // ──────────────────────────────────────────────────────────────────────────
    // command.md lesen
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Werkzeug-Handbuch für den System-Prompt: alle Aktions-Blöcke + Arbeitsweise.
     *
     * Bewusst zweigeteilt: erst LESEN/ANALYSIEREN, dann SCHREIBEN. Der Assistent
     * soll den bestehenden Code verstehen, bevor er ihn anfasst.
     */
    private buildToolManual(): string {
        const config = vscode.workspace.getConfiguration('aiAssistant');
        const planning = config.get<boolean>('planningEnabled', true);
        const analyze = config.get<boolean>('autoAnalyze', true);
        const agentLoop = config.get<boolean>('agentLoop', true);
        const maxSteps = config.get<number>('maxAgentSteps', 12);
        const mode = getAssistantMode();

        const parts: string[] = [];

        parts.push(
            `\n\n## Deine Rolle\n` +
            `Du bist ein autonomer Code-Assistent mit direktem Zugriff auf diesen Workspace. ` +
            `Du analysierst, planst, schreibst und testest Code selbständig – wie ein erfahrener Entwickler, ` +
            `der die Aufgabe komplett zu Ende bringt.\n`
        );

        // ── Plan-Modus: nur untersuchen und planen ───────────────────────────
        if (mode === 'plan') {
            parts.push(
                `\n## PLAN-MODUS AKTIV – keine Änderungen\n` +
                `Der Benutzer will erst einen Plan sehen, bevor etwas angefasst wird.\n` +
                `ERLAUBT: read_file, grep, glob, list_dir, web_search, plan, done\n` +
                `GESPERRT: create_file, edit_file, patch_file, replace_lines, delete_file, shell\n` +
                `Untersuche die Aufgabe gründlich, lege einen konkreten Plan an (action:plan) und ` +
                `schließe mit action:done ab. Versuche KEINE Änderung – sie würde abgelehnt.\n` +
                `Nenne im Abschlusstext, welche Dateien betroffen wären und welche Risiken du siehst.\n\n` +
                `## Analyse-Werkzeuge (nur lesen)\n\n` +
                `\`\`\`action:read_file\npath: src/datei.ts\n\`\`\`\n` +
                `\`\`\`action:grep\npattern: class\\s+\\w+\nglob: **/*.ts\n\`\`\`\n` +
                `\`\`\`action:glob\npattern: **/*.test.ts\n\`\`\`\n` +
                `\`\`\`action:list_dir\npath: src\n\`\`\`\n\n` +
                `## Plan\n\n` +
                `\`\`\`action:plan\n- [ ] Erster Schritt\n- [ ] Zweiter Schritt\n\`\`\`\n\n` +
                `## Abschluss\n\n` +
                `\`\`\`action:done\nzusammenfassung: <Plan in zwei Sätzen>\n\`\`\`\n`
            );
            return parts.join('');
        }

        if (mode === 'ask') {
            parts.push(
                `\nHinweis: Jede Änderung und jeder Shell-Befehl wird dem Benutzer zur Bestätigung ` +
                `vorgelegt. Halte deine Änderungen klein und nachvollziehbar.\n`
            );
        }

        // ── Arbeitsweise / Agenten-Schleife ──────────────────────────────────
        if (agentLoop) {
            parts.push(
                `\n## Arbeitsweise (Agenten-Schleife, max. ${maxSteps} Schritte)\n` +
                `Du arbeitest in Runden. Pro Runde: Aktions-Blöcke ausgeben → System führt sie aus → ` +
                `du bekommst die Ergebnisse → nächste Runde. Die Schleife läuft weiter, solange du Aktionen ausgibst.\n` +
                `1. **VERSTEHEN** – bestehenden Code lesen (read_file, grep, glob, list_dir)\n` +
                (planning ? `2. **PLANEN** – bei mehrschrittigen Aufgaben einen Plan (action:plan) anlegen\n` : '') +
                `${planning ? '3' : '2'}. **UMSETZEN** – Dateien ändern (patch_file, edit_file, create_file)\n` +
                `${planning ? '4' : '3'}. **PRÜFEN** – Build/Tests per action:shell ausführen\n` +
                `${planning ? '5' : '4'}. **KORRIGIEREN** – Fehlerausgaben analysieren und beheben\n` +
                `${planning ? '6' : '5'}. **ABSCHLIESSEN** – wenn alles erledigt ist: \`\`\`action:done\nzusammenfassung: <was erledigt wurde>\n\`\`\`\n` +
                `Gib \`action:done\` NUR aus, wenn wirklich nichts mehr zu tun ist. Solange etwas offen ist: weiterarbeiten.\n`
            );
        }

        // ── Analyse-Werkzeuge ────────────────────────────────────────────────
        parts.push(
            `\n## Analyse-Werkzeuge (nur lesen, keine Bestätigung nötig – nutze sie großzügig)\n\n` +
            `Datei mit Zeilennummern lesen:\n` +
            `\`\`\`action:read_file\npath: src/datei.ts\n\`\`\`\n` +
            `Nur einen Abschnitt lesen (bei großen Dateien):\n` +
            `\`\`\`action:read_file\npath: src/datei.ts\noffset: 200\nlimit: 150\n\`\`\`\n\n` +
            `Im gesamten Projekt suchen (Regex, wie ripgrep):\n` +
            `\`\`\`action:grep\npattern: class\\s+\\w+Service\nglob: **/*.ts\n\`\`\`\n` +
            `Optional: \`path: src\` (Unterordner), \`ignore_case: true\`\n\n` +
            `Dateien nach Muster finden:\n` +
            `\`\`\`action:glob\npattern: **/*.test.ts\n\`\`\`\n\n` +
            `Verzeichnis auflisten:\n` +
            `\`\`\`action:list_dir\npath: src\n\`\`\`\n`
        );

        // ── Planungs-Werkzeug ────────────────────────────────────────────────
        if (planning) {
            parts.push(
                `\n## Planungs-Werkzeug\n\n` +
                `Bei Aufgaben mit mehr als 2 Schritten legst du ZUERST einen Plan an:\n` +
                `\`\`\`action:plan\n- [ ] Bestehende Auth-Logik in src/auth analysieren\n- [ ] Token-Refresh in authService.ts ergänzen\n- [ ] Tests in auth.test.ts erweitern\n- [ ] npm test ausführen\n\`\`\`\n\n` +
                `Fortschritt markieren – \`[x]\` erledigt, \`[>]\` in Arbeit, \`[ ]\` offen:\n` +
                `\`\`\`action:plan\n- [x] Bestehende Auth-Logik analysiert\n- [>] Token-Refresh ergänzen\n- [ ] Tests erweitern\n- [ ] npm test ausführen\n\`\`\`\n\n` +
                `Gib bei jeder Plan-Aktualisierung die VOLLSTÄNDIGE Liste aus (nicht nur die geänderte Zeile).\n`
            );
        }

        // ── Schreib-Werkzeuge ────────────────────────────────────────────────
        parts.push(
            `\n## Schreib-Werkzeuge\n\n` +
            `Gezielte Änderung (BEVORZUGT – sicher und sparsam):\n` +
            `\`\`\`action:patch_file\npath: src/datei.ts\n---\n<<<SEARCH\n<exakter bestehender Code>\n>>>REPLACE\n<neuer Code>\n\`\`\`\n` +
            `WICHTIG: Innerhalb des Blocks KEINE weiteren Backticks. Der Suchtext steht direkt ` +
            `nach \`<<<SEARCH\`, der neue Text direkt nach \`>>>REPLACE\` – ohne eigenen Code-Block ` +
            `drumherum. Der einzige schließende Zaun ist der des Aktionsblocks.\n` +
            `Mehrere Änderungen in einer Datei: weitere \`<<<SEARCH … >>>REPLACE …\` Paare direkt anhängen.\n\n` +
            `Zeilenbereich ersetzen (Zeilennummern aus read_file):\n` +
            `\`\`\`action:replace_lines\npath: src/datei.ts\nstart_line: 42\nend_line: 58\n---\n<neuer Code für diesen Bereich>\n\`\`\`\n\n` +
            `Neue Datei erstellen:\n` +
            `\`\`\`action:create_file\npath: src/neu.ts\n---\n<vollständiger Dateiinhalt>\n\`\`\`\n\n` +
            `Ganze Datei ersetzen (nur wenn nötig – IMMER vollständiger Inhalt):\n` +
            `\`\`\`action:edit_file\npath: src/datei.ts\n---\n<VOLLSTÄNDIGER neuer Dateiinhalt>\n\`\`\`\n\n` +
            `Datei löschen:\n\`\`\`action:delete_file\npath: src/alt.ts\n\`\`\`\n\n` +
            `Shell-Befehl (WSL/Linux, für Build & Tests):\n\`\`\`action:shell\nnpm test\n\`\`\`\n\n` +
            `Web-Suche:\n\`\`\`action:web_search\nquery: suchbegriff\n\`\`\`\n`
        );

        // ── Ansage vor jeder Aktion ──────────────────────────────────────────
        // Ohne diese Anweisung führt das Modell Werkzeuge stumm aus und der
        // Benutzer sieht nur eine Liste von Aktionen, ohne zu wissen, warum.
        parts.push(
            `\n## Sage an, was du tust – vor jeder Aktion\n` +
            `Schreibe vor jedem Werkzeugaufruf EINEN kurzen Satz in der Ich-Form: was du ` +
            `jetzt tust und warum. Danach die Aktion. Keine Aufzählung vorab, keine ` +
            `Wiederholung hinterher.\n\n` +
            `So:\n` +
            `  Ich schaue mir zuerst den Tokenizer an, weil die Zahlen-Tests fehlschlagen.\n` +
            `  → read_file src/tokenizer.js\n\n` +
            `  Der Tokenizer liest nur eine Ziffer. Ich sammle die Ziffern in einer Schleife.\n` +
            `  → patch_file src/tokenizer.js\n\n` +
            `  Jetzt prüfe ich, ob die Tests durchlaufen.\n` +
            `  → shell npm test\n\n` +
            `Nicht so: "Ich werde die Dateien analysieren, dann den Plan erstellen, dann ` +
            `die Fehler beheben und dann testen." – das sagt nichts über den aktuellen Schritt.\n` +
            `Wenn ein Schritt fehlschlägt, sage in einem Satz, was du daraus schließt, bevor ` +
            `du es anders versuchst.\n`
        );

        // ── Regeln ───────────────────────────────────────────────────────────
        parts.push(
            `\n## Regeln\n` +
            (analyze
                ? `- **Erst lesen, dann schreiben.** Bevor du eine bestehende Datei änderst, hast du sie mit read_file gelesen oder mit grep gefunden. Ändere nie Code, den du nicht gesehen hast.\n`
                : '') +
            `- Nutze **patch_file** statt edit_file, wenn du nur einen Teil änderst.\n` +
            `- Bei **edit_file**: VOLLSTÄNDIGER Dateiinhalt, alle bestehenden Zeilen enthalten. NIEMALS Platzhalter wie \`// ... bestehender Code ...\`, \`# rest unchanged\`, \`...\`.\n` +
            `- Verwende Aktions-Blöcke IMMER mit drei Backticks – niemals \`<tags>\` oder \`[tags]\`.\n` +
            `- Zum Lesen von Dateien nutze **read_file/grep/glob**, NICHT die Shell (cat, head, grep).\n` +
            `- Halte dich an Stil, Namensgebung und Struktur des vorhandenen Codes.\n` +
            `- Keine Code-Beispiele im Text ("So könnte man…", "Hier ist ein Beispiel:"). Setze die Änderung als Aktion um.\n` +
            `- Ist die Aufgabe wirklich unklar: stelle genau EINE konkrete Frage.\n` +
            `- Höchstens 3 Aktionen pro Runde. Lieber kleine Schritte mit Ansage als ein ` +
            `großer Block – nach jeder Runde siehst du die Ergebnisse und kannst nachsteuern.\n`
        );

        return parts.join('');
    }

    /** Aktuellen Plan als Kontext-Block (damit die KI weiß, wo sie steht). */
    private buildPlanContext(): string {
        if (this.plan.length === 0) return '';
        const marks = { done: '[x]', doing: '[>]', todo: '[ ]' };
        const list = this.plan.map(s => `- ${marks[s.status]} ${s.text}`).join('\n');
        const open = this.plan.filter(s => s.status !== 'done').length;
        return `\n\n## Aktueller Arbeitsplan (${this.plan.length - open}/${this.plan.length} erledigt)\n${list}\n` +
            (open > 0
                ? `Arbeite den nächsten offenen Schritt ab und aktualisiere den Plan mit action:plan.`
                : `Alle Schritte erledigt – prüfe das Ergebnis und schließe mit action:done ab.`);
    }

    /**
     * Projekt-Anweisungsdateien laden (AGENTS.md, CLAUDE.md, command.md, …).
     *
     * Diese Dateien sind der "Projektvertrag": Konventionen, Build-Befehle,
     * Verbote. Sie werden bei JEDER Anfrage als permanente Regeln mitgegeben –
     * genau wie Claude Code CLAUDE.md liest.
     */
    private readInstructionFiles(): string {
        const config = vscode.workspace.getConfiguration('aiAssistant');
        const names = config.get<string[]>('instructionFiles',
            ['AGENTS.md', 'CLAUDE.md', 'command.md', '.github/copilot-instructions.md']);

        let root: string;
        try { root = this.fileManager.getWorkspaceRoot(); }
        catch { return ''; }

        const blocks: string[] = [];
        for (const name of names) {
            try {
                const p = path.join(root, name);
                if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
                const content = fs.readFileSync(p, 'utf-8').trim();
                if (!content) continue;
                // Sehr große Anweisungsdateien kürzen, damit der Kontext nicht platzt
                const clipped = content.length > 8000
                    ? content.slice(0, 8000) + '\n… [gekürzt]'
                    : content;
                blocks.push(`### ${name}\n${clipped}`);
                this.logger.info(`Projekt-Anweisungen geladen: ${name} (${content.length} Zeichen)`);
            } catch { /* Datei nicht lesbar → überspringen */ }
        }
        return blocks.join('\n\n');
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Verlauf komprimieren
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Verlauf zusammenfassen, wenn er den Kontext zu füllen droht.
     *
     * Bei einer Agenten-Schleife über viele Runden wächst der Verlauf schnell:
     * jede gelesene Datei und jede Testausgabe bleibt darin stehen. Läuft der
     * Kontext über, bricht die Anfrage ab oder das Modell verliert den Anfang.
     *
     * Komprimiert wird die ältere Hälfte: sie wird vom Modell in eine kompakte
     * Notiz zusammengefasst, die neueren Nachrichten bleiben wörtlich erhalten –
     * dort steht der aktuelle Arbeitsstand.
     *
     * @param systemPrompt  aktueller System-Prompt (zählt zum Kontext)
     * @returns Meldung für den Chat, oder undefined wenn nichts zu tun war
     */
    private async compactHistoryIfNeeded(systemPrompt: string): Promise<string | undefined> {
        const config = vscode.workspace.getConfiguration('aiAssistant');
        if (!config.get<boolean>('autoCompact', true)) return undefined;
        if (this.conversationHistory.length < 6) return undefined;

        const percent = config.get<number>('compactThresholdPercent', 89);
        const ctx = await this.mcpClient.getContextSize()
            ?? config.get<number>('contextWarningThreshold', 6000);
        const limit = Math.floor(ctx * (percent / 100));

        // Grobe Schätzung: 1 Token ≈ 4 Zeichen
        const chars = systemPrompt.length
            + this.conversationHistory.reduce((sum, m) => sum + m.content.length, 0);
        const estimated = Math.round(chars / 4);

        if (estimated < limit) return undefined;

        const before = this.conversationHistory.length;
        // Die letzten vier Nachrichten sind der aktuelle Arbeitsstand – die
        // bleiben wörtlich, damit der Assistent nicht den Faden verliert.
        const keep = this.conversationHistory.slice(-4);
        const fold = this.conversationHistory.slice(0, -4);
        if (fold.length === 0) return undefined;

        this.logger.info(
            `Verlauf wird komprimiert: ~${estimated} von ${ctx} Tokens (${percent}%-Grenze: ${limit}), ` +
            `${fold.length} Nachricht(en) werden zusammengefasst.`
        );

        const transcript = fold
            .map(m => `[${m.role}] ${m.content}`)
            .join('\n\n')
            .slice(0, 60_000);   // Die Zusammenfassung selbst muss in den Kontext passen

        let summary: string;
        try {
            const result = await this.mcpClient.complete([
                {
                    role: 'system',
                    content: 'Du fasst den Verlauf einer Programmier-Sitzung zusammen, '
                        + 'damit die Arbeit mit weniger Kontext weitergehen kann. '
                        + 'Antworte NUR mit der Zusammenfassung, ohne Vorrede.'
                },
                {
                    role: 'user',
                    content: `Fasse zusammen, was in dieser Sitzung passiert ist. Nenne knapp:\n`
                        + `1. Die Aufgabe des Benutzers\n`
                        + `2. Welche Dateien gelesen und welche geändert wurden (mit Pfaden)\n`
                        + `3. Welche Erkenntnisse für die weitere Arbeit wichtig sind\n`
                        + `4. Was noch offen ist\n\n`
                        + `Maximal 25 Zeilen. Konkret, keine Floskeln.\n\n`
                        + `--- VERLAUF ---\n${transcript}`
                }
            ], { maxTokens: 1500 });
            summary = this.stripReasoning(result.content).trim();
        } catch (err) {
            // Zusammenfassen fehlgeschlagen → hart kürzen statt die Anfrage
            // scheitern zu lassen. Ein verkürzter Verlauf ist besser als keiner.
            this.logger.warn(`Komprimieren fehlgeschlagen (${(err as Error).message}) – kürze hart.`);
            this.conversationHistory = keep;
            return `⚠ Verlauf gekürzt: ${before - keep.length} Nachricht(en) entfernt `
                + `(Zusammenfassung nicht möglich).`;
        }

        if (!summary) {
            this.conversationHistory = keep;
            return `⚠ Verlauf gekürzt: ${before - keep.length} Nachricht(en) entfernt.`;
        }

        this.conversationHistory = [
            { role: 'assistant', content: `## Zusammenfassung des bisherigen Verlaufs\n${summary}` },
            ...keep
        ];

        const afterChars = systemPrompt.length
            + this.conversationHistory.reduce((sum, m) => sum + m.content.length, 0);
        const afterTokens = Math.round(afterChars / 4);

        this.logger.info(`Verlauf komprimiert: ~${estimated} → ~${afterTokens} Tokens.`);
        return `🗜 Verlauf komprimiert: ${fold.length} Nachricht(en) zusammengefasst `
            + `(~${estimated} → ~${afterTokens} Tokens, Grenze ${percent}% von ${ctx}).`;
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


    /**
     * Überzählige Backtick-Zäune in SEARCH/REPLACE-Patches entfernen.
     *
     * Modelle schreiben den Suchtext häufig als eigenen Code-Block:
     *
     *     ```action:patch_file
     *     path: x.ts
     *     ---
     *     <<<SEARCH
     *     alter Code
     *     ```            ← genau hier endet der Aktionsblock zu früh
     *     >>>REPLACE
     *     neuer Code
     *     ```
     *
     * Der Parser sieht dann einen Patch ohne REPLACE-Teil und lehnt ihn ab.
     * Ein Zaun, der direkt an einer SEARCH/REPLACE-Marke klebt, ist immer so ein
     * Versehen – nie gewollter Inhalt. Also weg damit.
     */
    private normalizePatchFences(text: string): string {
        if (!text.includes('SEARCH')) return text;

        const cleaned = text
            // Zaun direkt VOR >>>REPLACE
            .replace(/\r?\n[ \t]*```[ \t]*(?=\r?\n[ \t]*>>>+REPLACE)/g, '')
            // Zaun direkt NACH <<<SEARCH
            .replace(/(<<<+SEARCH>*[ \t]*\r?\n)[ \t]*```[\w-]*[ \t]*\r?\n/g, '$1')
            // Zaun direkt NACH >>>REPLACE
            .replace(/(>>>+REPLACE>*[ \t]*\r?\n)[ \t]*```[\w-]*[ \t]*\r?\n/g, '$1');

        if (cleaned !== text) {
            this.logger.info('Patch-Parser: überzählige Backtick-Zäune im SEARCH/REPLACE-Block entfernt.');
        }
        return cleaned;
    }

    private async parseAndExecuteActions(response: string, confirm: ConfirmFn, onActionProgress?: ActionProgressCallback): Promise<ExecutedAction[]> {
        const executed: ExecutedAction[] = [];

        // Normalisierung: <action:shell>...</action:shell> → ```action:shell\n...\n```
        // Manche Modelle (Gemma, Qwen) schreiben XML-Tags statt Backtick-Blöcke
        const normalized = this.normalizePatchFences(
            normalizeToolCalls(
                response
                    .replace(/<action:(\w+)>([\s\S]*?)<\/action:\1>/g, '```action:$1\n$2\n```')
                    .replace(/\[action:(\w+)\]([\s\S]*?)\[\/action:\1\]/g, '```action:$1\n$2\n```'),
                this.logger
            )
        );

        // [^\n]* erlaubt trailing spaces/tabs nach dem Aktionstyp
        const blockPattern = /```action:(\w+)[^\n]*\n([\s\S]*?)```/g;
        let match: RegExpExecArray | null;

        // Debug: gefundene Blöcke loggen
        const allMatches: string[] = [];
        const debugPattern = /```action:(\w+)[^\n]*\n/g;
        let dbg: RegExpExecArray | null;
        while ((dbg = debugPattern.exec(normalized)) !== null) {
            allMatches.push(dbg[1]);
        }
        this.logger.info(`Aktions-Parser: ${allMatches.length} Block(e) gefunden: [${allMatches.join(', ')}]`);
        if (allMatches.length === 0) {
            this.logger.info(`Rohantwort (Anfang): ${response.slice(0, 400).replace(/\n/g, '↵')}`);
        }

        while ((match = blockPattern.exec(normalized)) !== null) {
            const actionType = match[1];
            const blockContent = match[2].trim();

            // Plan-Modus: nur lesen und planen. Modelle versuchen trotz
            // gefiltertem Werkzeugkatalog gelegentlich zu schreiben – hier ist
            // die harte Grenze, nicht im Prompt.
            if (this.planModeActive && !READ_ONLY_ACTIONS.has(actionType)) {
                this.logger.warn(`Plan-Modus: Aktion '${actionType}' blockiert.`);
                executed.push({
                    type: 'info',
                    description: `🔒 Plan-Modus: '${actionType}' nicht ausgeführt`,
                    success: false,
                    output: `Im Plan-Modus sind Änderungen gesperrt. Erstelle den Plan fertig `
                        + `(action:plan) und schließe mit action:done ab. Der Benutzer wechselt `
                        + `dann selbst in den Modus "auto" oder "ask", um ihn umzusetzen.`
                });
                continue;
            }

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
                        executed.push(await this.handleShellAction(blockContent, confirm, onActionProgress));
                        break;
                    case 'web_search':
                        executed.push(await this.handleWebSearchAction(blockContent, onActionProgress));
                        break;
                    case 'read_file':
                    case 'grep':
                    case 'glob':
                    case 'list_dir':
                        executed.push(this.handleAnalysisAction(actionType, blockContent, onActionProgress));
                        break;
                    case 'plan':
                    case 'todo':
                        executed.push(this.handlePlanAction(blockContent));
                        break;
                    case 'done':
                    case 'finish':
                        executed.push(this.handleDoneAction(blockContent));
                        break;
                    default:
                        this.logger.warn(`Unbekannter Aktionstyp: ${actionType}`);
                        break;
                }

                // Jede Aktion samt Ausgabe ins Arbeitsprotokoll
                const last = executed[executed.length - 1];
                if (last) {
                    if (actionType === 'shell') this.console.command(blockContent.trim());
                    this.console.action(last.description, last.output, last.success);
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
                this.console.problem(`Aktion '${actionType}': ${errMsg}`);
            }
        }
        return executed;
    }

    /**
     * Code säubern, bevor er in eine Datei geht.
     *
     * Modelle lassen manchmal Reste ihrer Tool-Call-Serialisierung im Inhalt
     * stehen (beobachtet: eine Zeile `</arg_value>` mitten im Quellcode, die
     * die Datei unbrauchbar machte). Das wird hier abgefangen – und geloggt,
     * weil es auf ein Modell- oder Serverproblem hindeutet.
     */
    private cleanCodeForWrite(content: string, where: string): string {
        const { code, removed } = stripToolMarkupFromCode(content);
        if (removed.length > 0) {
            this.logger.warn(
                `${where}: ${removed.length} Zeile(n) Tool-Call-Markup aus dem Dateiinhalt ` +
                `entfernt: ${removed.slice(0, 3).join(', ')}`
            );
            this.console.problem(
                `Markup-Reste im Inhalt entfernt (${removed.slice(0, 2).join(', ')})`
            );
        }
        return code;
    }

    private async handleFileAction(type: 'create_file' | 'edit_file', content: string, confirm: ConfirmFn): Promise<ExecutedAction> {
        // Separator-Suche: akzeptiert '---', '--- ', '---\r\n', '---\n', auch ohne Newline am Ende
        const sepMatch = content.match(/^---[ \t]*(\r?\n|$)/m);
        if (!sepMatch || sepMatch.index === undefined) throw new Error('Kein "---" Trenner im Aktionsblock gefunden');
        const pathMatch = content.slice(0, sepMatch.index).match(/^path:\s*(.+)$/m);
        if (!pathMatch) throw new Error('Kein "path:" gefunden');
        const filePath = pathMatch[1].trim();
        const fileContent = this.cleanCodeForWrite(
            content.slice(sepMatch.index + sepMatch[0].length), `${type}`);

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
        const newContent = this.cleanCodeForWrite(
            content.slice(sepMatch2.index + sepMatch2[0].length), 'replace_lines');

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

        // SEARCH/REPLACE-Blöcke parsen: <<<SEARCH\n...\n>>>REPLACE\n...\n (Ende = nächster Block oder EOF)
        // Akzeptiert auch altes Format <<<SEARCH>>> für Rückwärtskompatibilität
        // Git-Konflikt-/Aider-Schreibweise auf unsere Marker bringen. Viele
        // Modelle sind darauf trainiert und schreiben sie auch hier.
        const markerBody = patchBody
            .replace(/^[ \t]*<{5,}[ \t]*SEARCH[ \t]*$/gim, '<<<SEARCH')
            .replace(/^[ \t]*={5,}[ \t]*$/gm, '>>>REPLACE')
            .replace(/^[ \t]*>{5,}[ \t]*REPLACE[ \t]*$/gim, '');

        const patchPattern = /<<<+SEARCH>*[ \t]*\r?\n([\s\S]*?)>>>+REPLACE>*[ \t]*\r?\n([\s\S]*?)(?=<<<+SEARCH|$)/g;
        let patchMatch: RegExpExecArray | null;
        const patches: { search: string; replace: string }[] = [];

        while ((patchMatch = patchPattern.exec(markerBody)) !== null) {
            const search = this.stripPatchTerminator(patchMatch[1]);
            const replace = this.cleanCodeForWrite(this.stripPatchTerminator(patchMatch[2]), 'patch_file');
            if (search) {
                patches.push({ search, replace });
            }
        }

        if (patches.length === 0) {
            throw new Error('Keine gültigen <<<SEARCH...>>>REPLACE Blöcke gefunden');
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

    /**
     * Abschluss-Marker vom Ende eines SEARCH- oder REPLACE-Textes entfernen.
     *
     * Modelle setzen hinter den neuen Code gern noch eine Markierungszeile –
     * `>>>`, `<<<END>>>`, `>>>>>>> REPLACE`, `=======`. Bleibt die stehen,
     * landet sie mitten im Quellcode und macht die Datei kaputt. (Genau so
     * passiert: laguna schrieb `>>>` in tokenizer.js.)
     *
     * Nur Zeilen, die AUSSCHLIESSLICH aus Markerzeichen bestehen, werden
     * entfernt – Code wie `if (a >>> b)` bleibt unangetastet.
     */
    private stripPatchTerminator(text: string): string {
        return text
            .replace(/\r?\n[ \t]*[<>=]{3,}[ \t]*(?:END|REPLACE|SEARCH)?[<>=]*[ \t]*\r?\n?[ \t]*$/i, '')
            .replace(/^[ \t]*[<>=]{3,}[ \t]*(?:END|REPLACE|SEARCH)?[<>=]*[ \t]*\r?\n?$/i, '')
            .trimEnd();
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

    private async handleShellAction(command: string, confirm: ConfirmFn, onActionProgress?: ActionProgressCallback): Promise<ExecutedAction> {
        const config = vscode.workspace.getConfiguration('aiAssistant');
        if (!config.get<boolean>('allowShellCommands', true)) {
            return { type: 'shell', description: 'Shell deaktiviert', success: false, output: 'Shell-Befehle sind deaktiviert.' };
        }

        const trimmed = command.trim();

        // cat/head/tail: VOR dem Confirm-Dialog abfangen und direkt lesen
        let workDirEarly: string;
        try { workDirEarly = this.fileManager.getWorkspaceRoot(); } catch { workDirEarly = ''; }
        if (workDirEarly) {
            const intercepted = ShellRunner.interceptFileReadCommand(trimmed, workDirEarly, this.logger);
            if (intercepted) {
                this.logger.info(`Dateilese-Befehl abgefangen (kein WSL): ${trimmed}`);
                return {
                    type: 'shell',
                    description: `Datei gelesen: ${trimmed}`,
                    success: intercepted.exitCode === 0,
                    output: intercepted.stdout || intercepted.stderr
                };
            }
        }

        const choice = await confirm(
            `Shell-Befehl ausführen (WSL):\n\`${trimmed}\``,
            ['Ausführen', 'Etwas anderes', 'Ablehnen']
        );

        let commandToRun = trimmed;

        if (choice === 'Etwas anderes') {
            const userInstruction = await vscode.window.showInputBox({
                prompt: 'Anweisung an die KI eingeben',
                placeHolder: 'z.B. Nutze stattdessen npm ci',
                ignoreFocusOut: true
            });
            if (!userInstruction?.trim()) {
                return { type: 'shell', description: `Abgelehnt: ${trimmed}`, success: false };
            }
            this.logger.info(`Shell: Benutzer-Anweisung an KI: ${userInstruction.trim()}`);
            // Als fehlgeschlagene Shell-Action zurückgeben → triggert Repair-Loop mit User-Kontext
            return {
                type: 'shell',
                description: `Abgelehnt: ${trimmed}`,
                success: false,
                output: `Benutzer-Anweisung: ${userInstruction.trim()}\n\n(Der vorgeschlagene Befehl \`${trimmed}\` wurde abgelehnt.)`
            };
        } else if (choice !== 'Ausführen') {
            return { type: 'shell', description: `Abgelehnt: ${trimmed}`, success: false };
        }

        let workDir: string;
        try { workDir = this.fileManager.getWorkspaceRoot(); }
        catch { return { type: 'shell', description: 'Kein Workspace', success: false }; }

        onActionProgress?.(`⚙ Shell: \`${commandToRun.slice(0, 80)}\``, 'Wird ausgeführt…');
        const result = await this.shellRunner.run(commandToRun, workDir, 120_000, confirm);
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 4000);

        const icon = result.exitCode === 0 ? '✅' : '❌';
        onActionProgress?.(
            `${icon} Shell: \`${commandToRun.slice(0, 80)}\``,
            output || '(keine Ausgabe)'
        );

        return {
            type: 'shell',
            description: `Shell: ${commandToRun.slice(0, 60)}`,
            success: result.exitCode === 0,
            output: output || '(keine Ausgabe)'
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Analyse-Aktionen: read_file, grep, glob, list_dir
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Nur-Lese-Analyse. Läuft ohne Bestätigung, weil nichts verändert wird –
     * dadurch kann der Assistent den Code frei untersuchen.
     */
    private handleAnalysisAction(
        type: 'read_file' | 'grep' | 'glob' | 'list_dir',
        content: string,
        onActionProgress?: ActionProgressCallback
    ): ExecutedAction {
        const field = (name: string): string | undefined => {
            const m = content.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
            return m ? m[1].trim() : undefined;
        };
        const numField = (name: string): number | undefined => {
            const v = field(name);
            if (v === undefined) return undefined;
            const n = parseInt(v, 10);
            return isNaN(n) ? undefined : n;
        };
        const boolField = (name: string): boolean =>
            /^(true|ja|yes|1)$/i.test(field(name) ?? '');

        let result;
        switch (type) {
            case 'read_file': {
                // Pfad kann als "path: x" oder als nackte erste Zeile kommen
                const p = field('path') ?? field('file') ?? content.split('\n')[0].trim();
                if (!p) throw new Error('Kein "path:" im read_file Block gefunden');
                result = this.analyzer.readFile(p, numField('offset') ?? 1, numField('limit') ?? 400);
                break;
            }
            case 'grep': {
                const pattern = field('pattern') ?? field('query') ?? content.split('\n')[0].trim();
                if (!pattern) throw new Error('Kein "pattern:" im grep Block gefunden');
                result = this.analyzer.grep(
                    pattern,
                    field('glob') ?? field('include'),
                    field('path'),
                    boolField('ignore_case')
                );
                break;
            }
            case 'glob': {
                const pattern = field('pattern') ?? content.split('\n')[0].trim();
                if (!pattern) throw new Error('Kein "pattern:" im glob Block gefunden');
                result = this.analyzer.glob(pattern);
                break;
            }
            case 'list_dir': {
                result = this.analyzer.listDir(field('path') ?? (content.split('\n')[0].trim() || '.'));
                break;
            }
        }

        onActionProgress?.(`🔎 ${result.description}`, result.output.slice(0, 2000));
        return {
            type: 'analysis',
            description: result.description,
            // Analyse gilt als erfolgreich, auch wenn nichts gefunden wurde –
            // "keine Treffer" ist ein gültiges Ergebnis, kein Fehler.
            success: true,
            output: result.output
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Planung: action:plan
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Arbeitsplan der KI übernehmen. Format je Zeile:
     *   - [ ] offen   - [>] in Arbeit   - [x] erledigt
     */
    private handlePlanAction(content: string): ExecutedAction {
        const steps: PlanStep[] = [];
        for (const rawLine of content.split('\n')) {
            const line = rawLine.trim();
            if (!line) continue;
            // "- [x] Text", "* [ ] Text", "1. [>] Text" oder schlicht "- Text"
            const m = line.match(/^(?:[-*+]|\d+[.)])\s*(?:\[([ xX>~-])\]\s*)?(.+)$/);
            if (!m) continue;
            const mark = (m[1] ?? ' ').toLowerCase();
            const text = m[2].trim();
            if (!text) continue;
            steps.push({
                text,
                status: mark === 'x' ? 'done' : (mark === '>' || mark === '~') ? 'doing' : 'todo'
            });
        }

        if (steps.length === 0) {
            throw new Error('Kein gültiger Plan-Eintrag gefunden (erwartet: "- [ ] Schritt")');
        }

        this.plan = steps;
        this.onPlanUpdate?.(this.getPlan());
        this.console.plan(steps);

        const done = steps.filter(s => s.status === 'done').length;
        this.logger.info(`Plan aktualisiert: ${done}/${steps.length} erledigt`);

        const marks = { done: '[x]', doing: '[>]', todo: '[ ]' };
        return {
            type: 'plan',
            description: `Plan: ${done}/${steps.length} erledigt`,
            success: true,
            output: steps.map(s => `${marks[s.status]} ${s.text}`).join('\n')
        };
    }

    /** action:done – die KI meldet die Aufgabe als abgeschlossen. */
    private handleDoneAction(content: string): ExecutedAction {
        this.taskComplete = true;
        const summary = content.match(/^(?:zusammenfassung|summary):\s*([\s\S]+)$/mi);
        const text = (summary ? summary[1] : content).trim();
        this.logger.info('KI meldet Aufgabe abgeschlossen.');
        return {
            type: 'info',
            description: '✅ Aufgabe abgeschlossen',
            success: true,
            output: text || undefined
        };
    }

    private async handleWebSearchAction(content: string, onActionProgress?: ActionProgressCallback): Promise<ExecutedAction> {
        const queryMatch = content.match(/^query:\s*(.+)$/m);
        if (!queryMatch) throw new Error('Kein "query:" in web_search Block gefunden');
        const query = queryMatch[1].trim();

        onActionProgress?.('🔍 Web-Suche läuft…', query);
        const searcher = WebSearcher.getInstance();
        const searchResult = await searcher.search(query, 5);
        const formatted = searcher.formatForAI(searchResult);

        onActionProgress?.('🔍 Web-Suche abgeschlossen', `${searchResult.results.length} Ergebnis(se)`);
        this.logger.info(`web_search: "${query}" → ${searchResult.results.length} Ergebnis(se)`);

        return {
            type: 'web_search',
            description: `Web-Suche: "${query}"`,
            success: searchResult.results.length > 0 || !!searchResult.abstract,
            output: formatted
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

    /** Extrahiert den Inhalt des ersten <think>…</think>-Blocks (DeepSeek/Qwen). */
    private extractThinkingBlock(text: string): string | undefined {
        const match = text.match(/<think>([\s\S]*?)<\/think>/i);
        return match ? match[1].trim() : undefined;
    }

    /**
     * Baut eine AI-Prompt-formatierte Reasoning-Zusammenfassung.
     * Format: lesbare Sätze, die als Kontext in künftigen Prompts wiederverwendet werden können.
     */
    private buildReasoningSummary(userPrompt: string, thinking: string | undefined, actions: ExecutedAction[]): string {
        const parts: string[] = [];

        parts.push(`Aufgabe: "${userPrompt.slice(0, 200).replace(/\n/g, ' ')}"`);

        if (thinking) {
            // Thinking-Block auf max. 600 Zeichen kürzen um History-Größe zu kontrollieren
            const trimmed = thinking.length > 600
                ? thinking.slice(0, 600).trimEnd() + '…'
                : thinking;
            parts.push(`Reasoning: ${trimmed}`);
        }

        if (actions.length > 0) {
            const actionSummary = actions.map(a => {
                const status = a.success ? '✓' : '✗';
                return `${status} ${a.description}`;
            }).join('; ');
            parts.push(`Ausgeführte Aktionen: ${actionSummary}`);

            const failed = actions.filter(a => !a.success);
            if (failed.length > 0) {
                parts.push(`Fehlgeschlagen: ${failed.map(a => a.description).join('; ')}`);
            }
        } else {
            parts.push('Keine Datei- oder Shell-Aktionen ausgeführt (nur Antwort generiert).');
        }

        return parts.join('\n');
    }

    /**
     * Reasoning-Block entfernen, bevor Aktionen geparst werden.
     *
     * Reasoning-Modelle denken zuerst und antworten danach. Im Denkteil stehen
     * häufig verworfene Entwürfe von Aktions-Blöcken – die würden sonst
     * ausgeführt (und die endgültige Version danach ein zweites Mal).
     *
     * Ist der Block nicht geschlossen, wurde die Antwort mitten im Denken
     * abgeschnitten: dann gibt es noch keine gültige Aktion.
     */
    private stripReasoning(text: string): string {
        const closed = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
        if (closed !== text) return closed;

        const openIdx = text.search(/<think>/i);
        if (openIdx !== -1) {
            this.logger.warn(
                'Antwort endet im <think>-Block (abgeschnitten) – keine Aktionen ausgeführt. ' +
                'Erhöhe aiAssistant.maxTokens.'
            );
            return text.slice(0, openIdx);
        }
        return text;
    }

    private stripActionBlocks(text: string): string {
        return text
            .replace(/<think>[\s\S]*?<\/think>/gi, '')              // Reasoning-Blöcke
            .replace(/```action:\w+[^\n]*\n[\s\S]*?```\n?/g, '')    // Backtick-Blöcke
            .replace(/<action:\w+>[\s\S]*?<\/action:\w+>\n?/g, '')  // XML-Tags
            .replace(/\[action:\w+\][\s\S]*?\[\/action:\w+\]\n?/g, '') // Bracket-Tags
            .trim();
    }

    /** Anzeigetext: Aktions-Blöcke UND rohes Tool-Call-Markup entfernen. */
    private cleanForDisplay(text: string): string {
        // Das Markup ist bereits als Aktion ausgeführt – im Chat hat es nichts
        // zu suchen, sonst liest der Benutzer XML statt einer Antwort.
        return stripToolCallMarkup(this.stripActionBlocks(text)).trim();
    }

    // ──────────────────────────────────────────────────────────────────────────
    // History-Manager
    // ──────────────────────────────────────────────────────────────────────────

    private ensureHistoryManager(): void {
        if (this.historyManager) return;
        try {
            const root = this.fileManager.getWorkspaceRoot();
            this.historyManager = new HistoryManager(root);
            this.logger.info(`HistoryManager initialisiert: ${root}`);

            // Letzten Verlauf aus JSON in conversationHistory laden
            if (!this.historyLoaded) {
                this.historyLoaded = true;
                const previousMessages = this.historyManager.getLastSessionMessages(20);
                if (previousMessages.length > 0) {
                    this.conversationHistory = previousMessages.map(m => ({
                        role: m.role as 'user' | 'assistant',
                        content: m.content
                    }));
                    this.logger.info(`Verlauf wiederhergestellt: ${previousMessages.length} Nachrichten aus letzter Session geladen`);
                }
            }
        } catch (err) {
            this.logger.warn(`HistoryManager konnte nicht initialisiert werden: ${(err as Error).message}`);
        }
    }

    getHistoryManager(): HistoryManager | null {
        return this.historyManager;
    }

    /**
     * Erkennt ob der Benutzer eine Web-Suche möchte.
     * Gibt den Roh-Prompt zurück wenn Suche erkannt, sonst null.
     */
    private detectSearchIntent(prompt: string): boolean {
        const lower = prompt.toLowerCase();
        const searchKeywords = [
            'suche im internet', 'suche online', 'suche im web',
            'search the web', 'recherchiere', 'im internet suchen',
            'web suche', 'google das', 'google nach', 'find online',
            'look up', 'search for', 'suche nach'
        ];
        if (searchKeywords.some(kw => lower.includes(kw))) return true;

        const searchPatterns = [
            /suche?\s+(?:im\s+internet|online|im\s+web)/i,
            /recherchier(?:e|t|en?)/i,
            /google(?:n|e|t)/i,
            /search\s+(?:the\s+web|online|for)/i,
        ];
        return searchPatterns.some(p => p.test(prompt));
    }

    /**
     * Nutzt den LLM um einen optimierten Suchbegriff aus dem Benutzer-Prompt zu extrahieren.
     * Beispiel: "suche im Internet nach der API von Checkmk" → "Checkmk REST API"
     */
    private async extractSearchQuery(prompt: string): Promise<string> {
        try {
            const result = await this.mcpClient.complete(
                [
                    {
                        role: 'system',
                        content:
                            'Du bist ein Suchbegriff-Extraktor. ' +
                            'Gib NUR den optimierten Suchbegriff zurück — maximal 5 Wörter, keine Erklärung, keine Satzzeichen.\n\n' +
                            'Beispiele:\n' +
                            'Input: "suche im Internet nach der REST API von Checkmk"\n' +
                            'Output: Checkmk REST API\n\n' +
                            'Input: "recherchiere wie man in Python async/await benutzt"\n' +
                            'Output: Python async await tutorial\n\n' +
                            'Input: "suche nach der npm Dokumentation für axios und zeige mir Beispiele"\n' +
                            'Output: axios npm documentation\n\n' +
                            'Input: "google nach TypeScript generics"\n' +
                            'Output: TypeScript generics'
                    },
                    {
                        role: 'user',
                        content: `Input: "${prompt}"\nOutput:`
                    }
                ],
                { maxTokens: 20, temperature: 0.0 }
            );

            const raw = result.content
                .replace(/<think>[\s\S]*?<\/think>/gi, '')   // DeepSeek/Qwen reasoning
                .replace(/^(output:|suchbegriff:|query:)/i, '') // Präfix entfernen falls doch da
                .replace(/^["'\s]+|["'\s.!?]+$/g, '')           // Anführungszeichen/Leerzeichen
                .split('\n')[0]                                  // Nur erste Zeile
                .trim();

            // Hard-Stop bei Konjunktionen — alles dahinter ist Aufgabe, nicht Suchbegriff
            const stopWords = [' und ', ' and ', ' dann ', ' um ', ' damit ', ' mit ', '. '];
            let query = raw;
            for (const stop of stopWords) {
                const idx = query.toLowerCase().indexOf(stop);
                if (idx > 5) { query = query.slice(0, idx).trim(); break; }
            }

            if (query.length > 2 && query.length < 80) {
                this.logger.info(`Query-Optimierung: "${prompt.slice(0, 60)}" → "${query}"`);
                return query;
            }
        } catch (err) {
            this.logger.warn(`Query-Optimierung fehlgeschlagen: ${(err as Error).message}`);
        }

        // Fallback: Regex-Cleanup
        return prompt
            .replace(/suche\s+(im\s+internet|online|im\s+web)(\s+nach)?/gi, '')
            .replace(/recherchiere(\s+nach)?/gi, '')
            .replace(/search\s+(the\s+web|online|for)/gi, '')
            .replace(/google\s+(das|nach)?/gi, '')
            // Alles nach "und" / "dann" abschneiden
            .replace(/\s+(und|dann|um|damit|\.)\s+.*/i, '')
            .replace(/[?.!]+$/, '')
            .trim()
            .slice(0, 80);
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
