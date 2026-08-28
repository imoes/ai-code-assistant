import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MCPClient, ChatMessage, StreamCallback, GenerationStats } from './mcpClient';
import { FileManager } from './fileManager';
import { ShellRunner, ShellKind } from './shellRunner';
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

/**
 * Sprachregel – steht am Anfang jedes System-Prompts.
 *
 * Die Anweisungen an das Modell sind **englisch**: die Modelle folgen englischen
 * Instruktionen zuverlässiger, und die Werkzeugbeschreibungen fallen kürzer aus.
 * Die Antwort soll davon unberührt bleiben und in der Sprache des Benutzers
 * erfolgen – sonst antwortet ein Assistent mit deutschem Bedienfeld plötzlich
 * englisch. Deshalb wird die Regel ausdrücklich gesetzt und mehrfach wiederholt
 * (Ansagen, Plan-Punkte, Abschlusstext), denn genau dort fällt ein Rückfall ins
 * Englische dem Benutzer sofort auf.
 */
export const LANGUAGE_RULE =
    '## Language\n' +
    'These instructions are in English. Your ANSWER is not: always write to the user ' +
    'in the language they used in their request. That applies to everything the user ' +
    'reads – your prose, the sentence announcing each action, the plan items and the ' +
    'closing summary. Identifiers, code, file paths, shell commands and the action ' +
    'block syntax stay as they are.\n';

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

/**
 * Beschreibt eine Aktion so, dass die Anzeige sie sauber darstellen kann.
 *
 * Vorher bekam die Oberfläche nur einen fertigen String mit Emoji darin und
 * musste ihn zerlegen. Mit diesen Feldern kann sie eine kompakte Zeile
 * bauen – Werkzeugname, Ziel, Zusatz – wie in einem Terminal.
 */
export interface ActionMeta {
    /** Anzeigename des Werkzeugs: Read, Grep, Bash, … */
    tool: string;
    /** Worauf es angewendet wurde: Pfad, Suchmuster, Befehl */
    target?: string;
    /** Zusatz am Zeilenende, z.B. "L1–115" oder "12 Treffer" */
    detail?: string;
    /** Läuft der Vorgang noch? */
    running?: boolean;
    /** Ergebnis, sobald bekannt */
    ok?: boolean;
}

/** Callback für laufende Aktionen (Shell-Output, Suche, …) */
export type ActionProgressCallback = (
    description: string,
    output: string,
    meta?: ActionMeta
) => void;

/** Callback für laufende Kennzahlen (Prompt-Fortschritt, Tokens, Tokens/s) */
export type StatsProgressCallback = (stats: GenerationStats) => void;

/**
 * Callback für die Ansage des Assistenten – einmal pro Runde.
 *
 * Nötig, weil `process()` nur den Text der ERSTEN Runde zurückgibt: die
 * Ansagen der Folgerunden gingen sonst verloren und im Chat stand ab Runde 2
 * nur noch "nächster Schritt…" ohne zu sagen, was der Assistent vorhat.
 */
export type NarrationCallback = (text: string) => void;

/** Eine Antwortmöglichkeit im Entscheidungs-Dialog. */
export interface AskOption {
    label: string;
    description: string;
}

/** Eine Entscheidungsfrage an den Benutzer. */
export interface AskRequest {
    /** Kurzes Etikett, 2–3 Wörter – wie die Tab-Beschriftung bei Claude Code */
    header: string;
    question: string;
    options: AskOption[];
    /** Mehrfachauswahl (Kästchen) statt Einfachauswahl (Radio) */
    multi: boolean;
}

/**
 * Callback für den Entscheidungs-Dialog.
 *
 * Gibt die gewählten Beschriftungen zurück, bei Mehrfachauswahl mit `", "`
 * verbunden – dieselbe Form, die auch Claude Code im Webview verwendet. Ein
 * leerer String heißt: der Benutzer hat abgebrochen.
 */
export type AskCallback = (request: AskRequest) => Promise<string>;

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

    /** Callback für die Ansage pro Runde (siehe NarrationCallback) */
    private onNarration?: NarrationCallback;

    /** Callback für den Entscheidungs-Dialog (siehe AskCallback) */
    private onAsk?: AskCallback;

    /** Von der KI gesetztes Signal, dass die Aufgabe abgeschlossen ist */
    private taskComplete = false;

    /** Zusammenfassung aus `action:done` – wird als Schlussantwort angezeigt */
    private lastDoneSummary = '';

    /**
     * Der Auftrag des Benutzers aus Runde 0 – wortwörtlich.
     *
     * Die Fortsetzungs-Prompts der Schleife sprachen von „der ursprünglichen
     * Aufgabe", ohne sie zu nennen. Das Modell suchte sie im Gesprächsverlauf
     * und fand dort die Aufgabe der Vorsitzung. Wer weiterarbeiten lassen will,
     * muss den Auftrag jede Runde mitschicken.
     */
    private currentTask = '';

    /** Vom Benutzer gesetztes Abbruch-Signal – beendet auch die Schleife */
    private cancelled = false;

    /** Läuft gerade eine Aufgabe? Für "neue Aufgabe unterbricht die alte". */
    private busy = false;

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

    /** Callback registrieren, über den die Ansage jeder Runde gemeldet wird. */
    setNarrationCallback(cb: NarrationCallback | undefined): void {
        this.onNarration = cb;
    }

    /** Callback für den Entscheidungs-Dialog setzen (siehe AskCallback). */
    setAskCallback(cb: AskCallback | undefined): void {
        this.onAsk = cb;
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

    /**
     * Laufende Arbeit abbrechen – Anfrage UND Agenten-Schleife.
     *
     * Vorher wurde nur die HTTP-Anfrage beendet: die Schleife lief danach
     * weiter, parste die halbe Antwort und startete die nächste Runde. Der
     * Benutzer kam zwischen den Iterationen also nicht heraus.
     */
    cancel(): void {
        this.cancelled = true;
        this.mcpClient.cancel();
        this.logger.info('Abbruch vom Benutzer: Anfrage und Agenten-Schleife werden beendet.');
    }

    /** Läuft gerade eine Aufgabe? */
    isBusy(): boolean {
        return this.busy;
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

        // Abbruch prüfen, bevor eine neue Runde beginnt. Der Benutzer soll
        // zwischen den Iterationen herauskommen, nicht erst am Schrittlimit.
        if (this.cancelled) {
            this.logger.info('Agenten-Schleife abgebrochen (Benutzer).');
            return { text: '', actions: [], iterations: _depth };
        }

        // Neue Benutzer-Aufgabe → Abschluss-Signal und alten Plan verwerfen
        if (_depth === 0) {
            this.cancelled = false;
            this.busy = true;
            this.taskComplete = false;
            this.lastDoneSummary = '';
            this.currentTask = userPrompt.trim();
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
            workspaceContext = `\n\n## Project\n${this.analyzer.projectOverview()}`;

            // Aktive Editor-Datei und im Prompt erwähnte Dateien vorab einbinden.
            // Bewusst auf 600 Zeilen begrenzt: den Rest holt sich der Assistent
            // gezielt mit read_file, statt den Kontext blind vollzuschreiben.
            const PRELOAD_LINES = 600;

            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const relPath = path.relative(root, editor.document.uri.fsPath);
                const content = editor.document.getText();
                workspaceContext += `\n\n## Currently open file (${relPath})\n` +
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
                    workspaceContext += `\n\n## File mentioned in the request (${rel})\n` +
                        `\`\`\`\n${this.addLineNumbers(content, PRELOAD_LINES)}\n\`\`\``;
                } catch { /* ignorieren */ }
            }
        } catch {
            workspaceContext = '\n\n(No workspace open)';
        }

        // ── Auto-Test-Instruktion ────────────────────────────────────────────
        const autoTest = config.get<boolean>('autoTest', false);
        const testInstruction = autoTest ? `

AUTO-TEST ENABLED: after changing files, work out the right test command from the
project layout (package.json→npm test, Cargo.toml→cargo test, pytest.ini→pytest,
go.mod→go test ./..., pom.xml→mvn test, build.gradle→./gradlew test, *.csproj→dotnet test)
and append it as the last action:shell block.` : '';

        // ── System-Prompt zusammenbauen ──────────────────────────────────────
        // Reihenfolge: STABIL zuerst, VERÄNDERLICH zuletzt.
        // llama.cpp cacht den gemeinsamen Prompt-Präfix zwischen Anfragen. In einer
        // Agenten-Schleife mit 12 Runden ist das der Unterschied zwischen einmaliger
        // und zwölffacher Prompt-Auswertung. Alles, was sich pro Runde ändert
        // (Dateiinhalte, Plan), muss daher ans ENDE – sonst ist der Cache ab dort
        // wertlos und das große Werkzeug-Handbuch wird jede Runde neu ausgewertet.
        const fullSystemPrompt = [
            systemPromptBase,
            commandMdContent ? `\n\n## Permanent project instructions\n${commandMdContent}` : '',
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

        // Der bereinigte Text geht in JEDER Runde an die Anzeige – auch in der
        // ersten. Der Chat streamt die ROHE Antwort mit; ohne diese Nachlieferung
        // bleiben die Aktionsblöcke dort stehen, und der Benutzer liest
        // „>>>REPLACE" samt Quellcode statt einer Antwort.
        //
        // Leerer Text ist eine gültige Meldung: dann bestand die Runde nur aus
        // Werkzeugaufrufen und der gestreamte Absatz wird entfernt.
        this.onNarration?.(cleanText);

        const actions = await this.parseAndExecuteActions(actionSource, confirm, onActionProgress);
        const thinkingBlock = this.extractThinkingBlock(rawResponse);

        // Abschluss-Zusammenfassung als Nachricht nachschieben – sie ist die
        // Antwort auf die Aufgabe und gehört als Markdown in den Chat, nicht in
        // eine Werkzeugausgabe.
        if (this.lastDoneSummary && this.lastDoneSummary !== cleanText) {
            this.onNarration?.(this.lastDoneSummary);
            this.lastDoneSummary = '';
        }

        // ── Beispiel-Erkennung: KI hat nur Beispiel gezeigt statt zu handeln ──
        if (_depth === 0 && actions.length === 0 && config.get<boolean>('autoFixOnError', true)) {
            const hasCodeBlock = /```[\w\s]*\n[\s\S]+?```/.test(actionSource);
            const looksLikeExample = hasCodeBlock && /beispiel|example|so könnte|hier ist wie|du kannst|you can|hier ein|so würde/i.test(actionSource);
            if (looksLikeExample) {
                this.logger.info('Beispiel-Erkennung: KI hat Beispiel ohne Aktion gegeben → Korrektur-Prompt');
                onIteration?.(1, 'Beispiel erkannt – fordere direkte Umsetzung…');
                const correctionPrompt =
                    `You only showed an example instead of changing the code.\n` +
                    `Implement the task NOW using action blocks (action:edit_file or action:create_file).\n` +
                    `If something is unclear, ask ONE concrete question instead of showing an example.`;
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

            if (_depth === 0) this.busy = false;
            return {
                text: cleanText,
                actions: [...actions, ...nextResult.actions],
                contextWarning,
                iterations: nextResult.iterations + 1
            };
        }

        if (_depth === 0) this.busy = false;
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

        // Benutzer hat abgebrochen – nicht weitermachen
        if (this.cancelled) {
            this.logger.info('Agenten-Schleife beendet: vom Benutzer abgebrochen.');
            return null;
        }

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

        // Der Auftrag wird in JEDER Runde mitgeschickt. Ohne ihn sucht das Modell
        // sich „die ursprüngliche Aufgabe" selbst aus dem Verlauf zusammen.
        const task = this.currentTask
            ? `YOUR TASK (unchanged – this is what you are working on):\n`
                + `${this.currentTask.slice(0, 1500)}\n\n`
            : '';

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
        // Die Ausgabe eines Shell-Befehls geht IMMER zurück – auch wenn in
        // derselben Runde eine Datei geändert wurde. Vorher wurde sie dann
        // unterdrückt, und genau das ist der übliche Fall: das Modell ändert
        // und testet in einem Zug. Ein Testlauf, der mit Exit-Code 0 endet, aber
        // rote Tests meldet, erreichte das Modell so nie, und bei einer Aufgabe
        // mit mehreren Punkten endete die Schleife nach dem ersten Punkt.
        //
        // Die Endlosschleife, die diese Unterdrückung verhindern sollte, fängt
        // heute die Kreislauf-Erkennung ab – die gab es damals noch nicht.
        //
        // Suchergebnisse dagegen nur, solange nichts geändert wurde: sonst
        // bekommt das Modell nach jeder Änderung dieselbe Seite erneut vorgelegt.
        const successfulWithOutput = actions.filter(a =>
            a.success && a.output?.trim()
            && !a.description.startsWith('Datei gelesen:')
            && (a.type === 'shell' || (a.type === 'web_search' && !hasFileActions)));

        // ── 1. Fehlgeschlagene Shell-Befehle: Fehler beheben ──────────────────
        if (failedShells.length > 0 && autoFix) {
            const userInstruction = failedShells.find(a => a.output?.startsWith('Benutzer-Anweisung:'));
            const ctx = this.formatOutputs(failedShells);

            if (userInstruction) {
                return {
                    reason: 'Benutzer-Anweisung erhalten – setze um…',
                    prompt: `${task}THE USER GAVE YOU AN INSTRUCTION:\n\n${ctx}\n\n` +
                        `Carry it out right away, using action blocks.`
                };
            }
            return {
                reason: `${failedShells.length} Fehler gefunden – analysiere…`,
                prompt:
                    `${task}ERROR ANALYSIS REQUIRED:\n\n${ctx}\n\n` +
                    `Read the error output closely. What is the cause? ` +
                    `If you need to see code for that: use read_file or grep. ` +
                    `Then fix the error with the appropriate action blocks. ` +
                    `Do NOT answer with "okay" or an explanation without an action.`
            };
        }

        // ── 1b. Änderung ist nicht durchgegangen: Ursache zurückmelden ────────
        if (failedFileActions.length > 0 && autoFix) {
            return {
                reason: `${failedFileActions.length} Änderung(en) nicht angewendet – korrigiere…`,
                prompt:
                    `${task}A CHANGE WAS NOT APPLIED:\n\n` +
                    `${this.formatOutputs(failedFileActions)}\n\n` +
                    `Read the reason carefully. Do NOT repeat the same call.\n` +
                    `- If the message says the change is already there: move on to the next point.\n` +
                    `- If the search text does not match: read the file again with read_file and ` +
                    `patch against its actual content, or use replace_lines with line numbers.\n` +
                    `- If everything is done: finish with action:done.`
            };
        }

        // ── 2. Analyse-Ergebnisse liegen vor: jetzt verwerten ─────────────────
        if (analyses.length > 0 && agentLoop) {
            const ctx = this.formatOutputs(analyses);
            const labels = analyses.map(a => a.description).join(', ');
            return {
                reason: `Analyse ausgewertet (${labels.slice(0, 90)}) – arbeite weiter…`,
                prompt:
                    `${task}RESULTS OF YOUR CODE ANALYSIS:\n\n${ctx}\n\n` +
                    `You have seen the code now. Continue working on exactly the task above:\n` +
                    `- Need more context? → further read_file / grep actions\n` +
                    `- Know enough? → implement the change now (patch_file / replace_lines / create_file)\n` +
                    `- Everything done? → \`\`\`action:done\nsummary: …\n\`\`\`\n` +
                    `Do NOT repeat the same analysis action.`
            };
        }

        // ── 3. Befehlsausgabe: darauf reagieren ───────────────────────────────
        if (successfulWithOutput.length > 0 && autoFix) {
            return {
                reason: 'Ausgaben empfangen – analysiere…',
                prompt:
                    `${task}COMMAND OUTPUT – ANALYSIS AND ACTION REQUIRED:\n\n` +
                    `${this.formatOutputs(successfulWithOutput)}\n\n` +
                    `Analyse this output with regard to the task above and carry out the next ` +
                    `necessary steps right away (action blocks). ` +
                    `If the output already answers the task: write the answer now and finish ` +
                    `with action:done. Do NOT pick up a task from an earlier session.`
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
                    `${task}CONTINUE THE PLAN. Still open:\n` +
                    openSteps.map(s => `- [${s.status === 'doing' ? '>' : ' '}] ${s.text}`).join('\n') +
                    `\n\nWork on the next step now: "${next.text}"\n` +
                    `Then update the plan with action:plan (the complete list). ` +
                    `Once every step is done, finish with action:done.`
            };
        }

        // ── 5. Geändert, aber nicht geprüft: prüfen lassen ────────────────────
        // Bis hierher war eine erfolgreiche Dateiänderung das Ende der Schleife.
        // Im Fenster-Lauf hieß das: Auftrag mit fünf Punkten, der Assistent
        // patcht den Tokenizer – und hört auf. Die Auto-Test-Instruktion im
        // System-Prompt BITTET das Modell, den Testbefehl anzuhängen; tut es das
        // nicht, prüfte niemand etwas. Also wird hier gefragt.
        const changedOk = actions.some(a => isFileAction(a.type) && a.success);
        const ranShell = actions.some(a => a.type === 'shell');
        if (agentLoop && autoFix && changedOk && !ranShell
            && config.get<boolean>('autoTest', false)) {
            return {
                reason: 'Änderung noch ungeprüft – Tests anstoßen…',
                prompt:
                    `${task}YOU CHANGED SOMETHING BUT VERIFIED NOTHING:\n` +
                    `${actions.filter(a => isFileAction(a.type) && a.success)
                        .map(a => `- ${a.description}`).join('\n')}\n\n` +
                    `Run the project's tests now (action:shell; pick the command from the project ` +
                    `files: package.json → npm test, Cargo.toml → cargo test, pytest.ini → pytest, ` +
                    `go.mod → go test ./...).\n` +
                    `If points of the task are still open, do those first.\n` +
                    `Only once the tests are green AND the task is fully done: action:done.`
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
            return `${status} ${a.description}\n\`\`\`\n${this.capOutput(a.output ?? '')}\n\`\`\``;
        }).join('\n\n');
    }

    /** Obergrenze für eine einzelne Aktionsausgabe im Folge-Prompt. */
    private static readonly MAX_OUTPUT_CHARS = 6000;

    /**
     * Lange Ausgabe für den Folge-Prompt kürzen – Anfang und Ende behalten.
     *
     * Ungekürzt geht eine abgerufene Seite mit 20 000 Zeichen wortwörtlich in
     * den Prompt der nächsten Runde und von dort in den Gesprächsverlauf. Bei
     * einem Modell mit 256k Kontext fällt das nicht auf; bei 16k ist nach einem
     * einzigen `web_fetch` Schluss, und die Komprimierung wirft dann genau die
     * Arbeit weg, um die es ging.
     *
     * Anfang UND Ende, weil beide zählen: die Kopfzeilen sagen, was das für eine
     * Ausgabe ist, die Fehlermeldungen eines Testlaufs stehen am Schluss.
     */
    private capOutput(text: string): string {
        const max = AIEngine.MAX_OUTPUT_CHARS;
        if (text.length <= max) return text;

        const head = Math.floor(max * 0.6);
        const tail = max - head;
        const dropped = text.length - max;
        return text.slice(0, head)
            + `\n\n[… ${dropped} Zeichen ausgelassen. Brauchst du die Mitte: `
            + `read_file mit offset/limit, oder grep mit einem Suchmuster. …]\n\n`
            + text.slice(-tail);
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

        // Die Sprachregel steht ZUERST – sie ist der Grund, warum das Handbuch
        // überhaupt englisch sein darf.
        parts.push(LANGUAGE_RULE);

        parts.push(
            `\n\n## Your role\n` +
            `You are an autonomous coding assistant with direct access to this workspace. ` +
            `You analyse, plan, write and test code on your own – like an experienced developer ` +
            `who sees the task through to the end.\n`
        );

        // ── Plan-Modus: nur untersuchen und planen ───────────────────────────
        if (mode === 'plan') {
            parts.push(
                `\n## PLAN MODE ACTIVE – no changes\n` +
                `The user wants to see a plan before anything is touched.\n` +
                `ALLOWED: read_file, grep, glob, list_dir, web_search, plan, done\n` +
                `BLOCKED: create_file, edit_file, patch_file, replace_lines, delete_file, shell\n` +
                `Investigate the task thoroughly, write a concrete plan (action:plan) and ` +
                `finish with action:done. Do NOT attempt any change – it would be rejected.\n` +
                `In your closing text, name the files that would be affected and the risks you see.\n\n` +
                `## Analysis tools (read only)\n\n` +
                `\`\`\`action:read_file\npath: src/file.ts\n\`\`\`\n` +
                `\`\`\`action:grep\npattern: class\\s+\\w+\nglob: **/*.ts\n\`\`\`\n` +
                `\`\`\`action:glob\npattern: **/*.test.ts\n\`\`\`\n` +
                `\`\`\`action:list_dir\npath: src\n\`\`\`\n\n` +
                `## Plan\n\n` +
                `\`\`\`action:plan\n- [ ] First step\n- [ ] Second step\n\`\`\`\n\n` +
                `## Finishing\n\n` +
                `\`\`\`action:done\nsummary: <the plan in two sentences>\n\`\`\`\n`
            );
            return parts.join('');
        }

        if (mode === 'ask') {
            parts.push(
                `\nNote: every change and every shell command is shown to the user for ` +
                `confirmation. Keep your changes small and easy to follow.\n`
            );
        }

        // ── Arbeitsweise / Agenten-Schleife ──────────────────────────────────
        if (agentLoop) {
            parts.push(
                `\n## How you work (agent loop, max. ${maxSteps} steps)\n` +
                `You work in rounds. Per round: emit action blocks → the system runs them → ` +
                `you get the results → next round. The loop continues as long as you emit actions.\n` +
                `1. **UNDERSTAND** – read the existing code (read_file, grep, glob, list_dir)\n` +
                (planning ? `2. **PLAN** – for multi-step tasks, write a plan (action:plan)\n` : '') +
                `${planning ? '3' : '2'}. **IMPLEMENT** – change files (patch_file, edit_file, create_file)\n` +
                `${planning ? '4' : '3'}. **VERIFY** – run the build/tests via action:shell\n` +
                `${planning ? '5' : '4'}. **FIX** – analyse the error output and correct it\n` +
                `${planning ? '6' : '5'}. **FINISH** – when everything is done: \`\`\`action:done\nsummary: <what was done>\n\`\`\`\n` +
                `Emit \`action:done\` ONLY when there is genuinely nothing left to do. While anything is open: keep working.\n`
            );
        }

        // ── Analyse-Werkzeuge ────────────────────────────────────────────────
        parts.push(
            `\n## Analysis tools (read only, no confirmation needed – use them freely)\n\n` +
            `Read a file with line numbers:\n` +
            `\`\`\`action:read_file\npath: src/file.ts\n\`\`\`\n` +
            `Read only a section (for large files):\n` +
            `\`\`\`action:read_file\npath: src/file.ts\noffset: 200\nlimit: 150\n\`\`\`\n\n` +
            `Search the whole project (regex, like ripgrep):\n` +
            `\`\`\`action:grep\npattern: class\\s+\\w+Service\nglob: **/*.ts\n\`\`\`\n` +
            `Optional: \`path: src\` (subfolder), \`ignore_case: true\`\n\n` +
            `Find files by pattern:\n` +
            `\`\`\`action:glob\npattern: **/*.test.ts\n\`\`\`\n\n` +
            `List a directory:\n` +
            `\`\`\`action:list_dir\npath: src\n\`\`\`\n`
        );

        // ── Planungs-Werkzeug ────────────────────────────────────────────────
        if (planning) {
            parts.push(
                `\n## Planning tool\n\n` +
                `For tasks with more than 2 steps, write a plan FIRST:\n` +
                `\`\`\`action:plan\n- [ ] Analyse the existing auth logic in src/auth\n- [ ] Add token refresh to authService.ts\n- [ ] Extend the tests in auth.test.ts\n- [ ] Run npm test\n\`\`\`\n\n` +
                `Mark progress – \`[x]\` done, \`[>]\` in progress, \`[ ]\` open:\n` +
                `\`\`\`action:plan\n- [x] Analysed the existing auth logic\n- [>] Add token refresh\n- [ ] Extend the tests\n- [ ] Run npm test\n\`\`\`\n\n` +
                `Write the COMPLETE list on every plan update (not just the changed line).\n` +
                `Write the plan items in the user's language – the user reads them.\n`
            );
        }

        // ── Schreib-Werkzeuge ────────────────────────────────────────────────
        parts.push(
            `\n## Writing tools\n\n` +
            `Targeted change (PREFERRED – safe and economical):\n` +
            `\`\`\`action:patch_file\npath: src/file.ts\n---\n<<<SEARCH\n<exact existing code>\n>>>REPLACE\n<new code>\n\`\`\`\n` +
            `IMPORTANT: NO further backticks inside the block. The search text comes straight ` +
            `after \`<<<SEARCH\`, the new text straight after \`>>>REPLACE\` – with no code block ` +
            `around them. The only closing fence is the one of the action block.\n` +
            `Several changes in one file: append further \`<<<SEARCH … >>>REPLACE …\` pairs directly.\n\n` +
            `Replace a line range (line numbers from read_file):\n` +
            `\`\`\`action:replace_lines\npath: src/file.ts\nstart_line: 42\nend_line: 58\n---\n<new code for that range>\n\`\`\`\n\n` +
            `Create a new file:\n` +
            `\`\`\`action:create_file\npath: src/new.ts\n---\n<complete file content>\n\`\`\`\n\n` +
            `Replace a whole file (only when necessary – ALWAYS the complete content):\n` +
            `\`\`\`action:edit_file\npath: src/file.ts\n---\n<COMPLETE new file content>\n\`\`\`\n\n` +
            `Delete a file:\n\`\`\`action:delete_file\npath: src/old.ts\n\`\`\`\n\n` +
            `Shell command – WSL/bash by default, for build, tests and git:\n` +
            `\`\`\`action:shell\nnpm test\n\`\`\`\n` +
            `Windows PowerShell when the command genuinely needs Windows (services, ` +
            `registry, drivers, WinGet, Windows-only executables, COM). Mind the ` +
            `syntax: no \`&&\`, use \`;\` – and \`Get-ChildItem\`, not \`ls\`:\n` +
            `\`\`\`action:shell\nshell: powershell\n---\nGet-Service -Name Spooler | Select-Object Status, Name\n\`\`\`\n` +
            `Prefer WSL. Only reach for PowerShell when WSL cannot do the job.\n\n` +
            `Web search (returns title, address and a short excerpt):\n` +
            `\`\`\`action:web_search\nquery: search terms\n\`\`\`\n\n` +
            `Fetch and read a page – almost always needed after a search, because the\n` +
            `result list alone answers no question:\n` +
            `\`\`\`action:web_fetch\nurl: https://example.com/docs\n\`\`\`\n`
        );

        // ── Rückfrage an den Benutzer ────────────────────────────────────────
        parts.push(
            `\n## Asking the user to decide\n` +
            `When the task allows several defensible routes and the choice is the ` +
            `user's to make, ask – with concrete options instead of an open question:\n` +
            `\`\`\`action:ask_user\nheader: Library\n` +
            `question: Which date library should the project use?\nmulti: false\noptions:\n` +
            `date-fns — small, modular, the usual choice for new projects\n` +
            `Luxon — time zones built in, larger bundle\n` +
            `Neither — write the two helpers we need by hand\n\`\`\`\n` +
            `The answer comes back as the result of the action; carry on with it and ` +
            `do not ask the same thing twice. Put your recommendation first.\n\n` +
            `Do NOT ask when:\n` +
            `- you can find the answer by reading the code (then read it),\n` +
            `- it is a detail the user does not care about (then decide, say what you ` +
            `assumed in one sentence and carry on),\n` +
            `- you only want permission to keep working (you have it – keep working).\n`
        );

        // ── Ansage vor jeder Aktion ──────────────────────────────────────────
        // Ohne diese Anweisung führt das Modell Werkzeuge stumm aus und der
        // Benutzer sieht nur eine Liste von Aktionen, ohne zu wissen, warum.
        parts.push(
            `\n## Say what you are doing – before every action\n` +
            `Before each tool call, write ONE short sentence in the first person: what you ` +
            `are doing now and why. Then the action. No list up front, no repetition ` +
            `afterwards. **Write this sentence in the user's language.**\n\n` +
            `Like this:\n` +
            `  I'll look at the tokenizer first, because the number tests are failing.\n` +
            `  → read_file src/tokenizer.js\n\n` +
            `  The tokenizer only reads a single digit. I'll collect the digits in a loop.\n` +
            `  → patch_file src/tokenizer.js\n\n` +
            `  Now I'll check whether the tests pass.\n` +
            `  → shell npm test\n\n` +
            `Not like this: "I will analyse the files, then create the plan, then fix the ` +
            `errors and then test." – that says nothing about the current step.\n` +
            `If a step fails, say in one sentence what you conclude from it before you try ` +
            `something else.\n`
        );

        // ── Regeln ───────────────────────────────────────────────────────────
        parts.push(
            `\n## Rules\n` +
            (analyze
                ? `- **Read before you write.** Before you change an existing file, you have read it with read_file or found it with grep. Never change code you have not seen.\n`
                : '') +
            `- Use **patch_file** instead of edit_file when you only change part of a file.\n` +
            `- With **edit_file**: the COMPLETE file content, including every existing line. NEVER placeholders like \`// ... existing code ...\`, \`# rest unchanged\`, \`...\`.\n` +
            `- ALWAYS write action blocks with three backticks – never \`<tags>\` or \`[tags]\`.\n` +
            `- To read files use **read_file/grep/glob**, NOT the shell (cat, head, grep).\n` +
            `- Follow the style, naming and structure of the existing code.\n` +
            `- No code examples in prose ("one could…", "here is an example:"). Implement the change as an action.\n` +
            `- If the task is genuinely unclear: ask exactly ONE concrete question.\n` +
            `- At most 3 actions per round. Small steps with an announcement beat one big ` +
            `block – after each round you see the results and can adjust.\n`
        );

        return parts.join('');
    }
    /** Aktuellen Plan als Kontext-Block (damit die KI weiß, wo sie steht). */
    private buildPlanContext(): string {
        if (this.plan.length === 0) return '';
        const marks = { done: '[x]', doing: '[>]', todo: '[ ]' };
        const list = this.plan.map(s => `- ${marks[s.status]} ${s.text}`).join('\n');
        const open = this.plan.filter(s => s.status !== 'done').length;
        return `\n\n## Current work plan (${this.plan.length - open}/${this.plan.length} done)\n${list}\n` +
            (open > 0
                ? `Work on the next open step and update the plan with action:plan.`
                : `Every step is done – verify the result and finish with action:done.`);
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
                    content: 'You summarise the transcript of a coding session so the work '
                        + 'can continue with less context. Answer with the summary ONLY, '
                        + 'no preamble. Write it in the language of the transcript.'
                },
                {
                    role: 'user',
                    content: `Summarise what happened in this session. State briefly:\n`
                        + `1. The user's task\n`
                        + `2. Which files were read and which were changed (with paths)\n`
                        + `3. Which findings matter for the remaining work\n`
                        + `4. What is still open\n\n`
                        + `At most 25 lines. Concrete, no filler.\n\n`
                        + `--- TRANSCRIPT ---\n${transcript}`
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
            { role: 'assistant', content: `## Summary of the conversation so far\n${summary}` },
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

    /**
     * Zaunlose Aktions-Kopfzeilen einzäunen.
     *
     * Beobachtet im Fenster-Lauf: das Modell beendete seine Antwort mit
     *
     *     action:done
     *     zusammenfassung: Die drei Fragen wurden beantwortet.
     *
     * ohne Backticks. Damit wurde der Block weder ausgeführt – die Schleife
     * erfuhr also nicht, dass die Aufgabe fertig ist – noch aus der Anzeige
     * entfernt: der Benutzer las „action:done" als Teil der Antwort.
     *
     * Umgewandelt werden nur Aktionen, deren Inhalt aus `schlüssel: wert`-Zeilen
     * oder Plan-Punkten besteht. Für `create_file` und Verwandte wäre das
     * gefährlich: dort ist der Inhalt beliebiger Quellcode, und wo er endet,
     * verrät ohne Zaun nichts.
     */
    private normalizeBareActionHeaders(text: string): string {
        const SAFE = new Set([
            'done', 'finish', 'plan', 'todo',
            'read_file', 'grep', 'glob', 'list_dir', 'delete_file',
            'web_search', 'web_fetch'
        ]);
        const lines = text.split('\n');
        const out: string[] = [];
        let inFence = false;
        let changed = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (/^\s*```/.test(line)) { inFence = !inFence; out.push(line); continue; }

            const bare = inFence ? null : /^\s*action:(\w+)\s*$/.exec(line);
            if (!bare || !SAFE.has(bare[1])) { out.push(line); continue; }

            // Inhalt sind die folgenden Zeilen, solange sie wie Argumente
            // aussehen. Prosa danach bleibt Prosa.
            const body: string[] = [];
            let j = i + 1;
            while (j < lines.length) {
                const l = lines[j];
                if (/^\s*$/.test(l) && body.length > 0) break;
                if (/^\s*```/.test(l) || /^\s*action:\w+\s*$/.test(l)) break;
                const looksLikeArg = /^\s*\w+:\s*/.test(l) || /^\s*-\s*\[.\]/.test(l);
                // Fortsetzungszeile eines mehrzeiligen Werts nur zulassen,
                // wenn schon ein Argument dasteht.
                if (!looksLikeArg && body.length === 0) break;
                if (!looksLikeArg && !/^\s{2,}\S/.test(l)) break;
                body.push(l);
                j++;
            }
            if (body.length === 0) { out.push(line); continue; }

            out.push('```action:' + bare[1]);
            out.push(...body);
            out.push('```');
            i = j - 1;
            changed = true;
        }

        if (changed) {
            this.logger.info('Aktions-Parser: zaunlose Aktions-Kopfzeile eingezäunt.');
            return out.join('\n');
        }
        return text;
    }

    /**
     * Alle Schreibweisen des Modells auf `\`\`\`action:name … \`\`\`` bringen.
     *
     * **Diese Methode ist die einzige Normalisierung – Parser UND Anzeige
     * benutzen sie.** Vorher hatte der Parser eine Stufe mehr als die Anzeige,
     * und das Ergebnis stand im Fenster: ein `patch_file`-Block mit verrutschten
     * Zäunen wurde ausgeführt (der Parser konnte ihn geradeziehen), blieb aber
     * als Text im Chat stehen – der Benutzer las `>>>REPLACE` und den
     * Quellcode statt einer Antwort. Wer hier eine Stufe ergänzt, ergänzt sie
     * damit automatisch für beide Wege.
     *
     * Umgewandelt werden: XML-Tags (Gemma, Qwen), Klammer-Tags, die nativen
     * Tool-Call-Formate aller Modellfamilien, zaunlose Kopfzeilen und
     * überzählige oder fehlende Zäune in Patch-Blöcken.
     */
    private normalizeActionMarkup(text: string): string {
        return this.closeUnterminatedActionFences(
            this.normalizePatchFences(
                this.normalizeBareActionHeaders(
                    normalizeToolCalls(
                        text
                            .replace(/<action:(\w+)>([\s\S]*?)<\/action:\1>/g, '```action:$1\n$2\n```')
                            .replace(/\[action:(\w+)\]([\s\S]*?)\[\/action:\1\]/g, '```action:$1\n$2\n```'),
                        this.logger
                    )
                )
            )
        );
    }

    /**
     * Fehlende Schluss-Zäune ergänzen.
     *
     * Beobachtet im Fenster: das Modell schrieb zwei Blöcke hintereinander und
     * ließ den Zaun dazwischen weg.
     *
     *     ```action:list_dir
     *     path: src
     *     ```action:list_dir
     *     path: test
     *     ```
     *
     * Das Blockmuster endet dann am Zaun der ZWEITEN Kopfzeile: der erste Block
     * wird ausgeführt, der Rest bleibt als Text übrig – und stand so im Chat.
     * Ein neuer Kopf innerhalb eines Blocks bedeutet: der vorige ist zu Ende.
     *
     * Läuft nach `normalizePatchFences`, denn in einem Patch-Rumpf sind Zäune
     * erlaubt; die räumt jene Stufe vorher auf.
     */
    private closeUnterminatedActionFences(text: string): string {
        const lines = text.split('\n');
        const out: string[] = [];
        let open = false;
        let changed = false;

        for (const line of lines) {
            const isHeader = /^\s*```action:\w+/.test(line);
            const isFence = /^\s*```\s*$/.test(line);

            if (isHeader) {
                if (open) { out.push('```'); changed = true; }
                open = true;
                out.push(line);
                continue;
            }
            if (isFence && open) { open = false; out.push(line); continue; }
            out.push(line);
        }

        if (open) { out.push('```'); changed = true; }

        if (changed) {
            this.logger.info('Aktions-Parser: fehlenden Schluss-Zaun ergänzt.');
            return out.join('\n');
        }
        return text;
    }

    private async parseAndExecuteActions(response: string, confirm: ConfirmFn, onActionProgress?: ActionProgressCallback): Promise<ExecutedAction[]> {
        const executed: ExecutedAction[] = [];

        const normalized = this.normalizeActionMarkup(response);

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
                    case 'ask_user':
                        executed.push(await this.handleAskUserAction(blockContent, confirm, onActionProgress));
                        break;
                    case 'web_search':
                        executed.push(await this.handleWebSearchAction(blockContent, onActionProgress));
                        break;
                    case 'web_fetch':
                        executed.push(await this.handleWebFetchAction(blockContent, onActionProgress));
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

        // Der Block kann eine Kopfzeile `shell: powershell` tragen. Ohne sie
        // gilt die Einstellung – für Build und Tests ist das WSL.
        const { shellKind, command: rest } = AIEngine.parseShellBlock(command);
        const trimmed = rest.trim();

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

        const shellLabel = ShellRunner.resolveShell(shellKind, config) === 'powershell'
            ? 'PowerShell' : 'WSL';
        const choice = await confirm(
            `Shell-Befehl ausführen (${shellLabel}):\n\`${trimmed}\``,
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

        // Beim Start als "läuft" melden, danach mit Ergebnis überschreiben –
        // dieselbe Karte, damit man den Befehl nicht zweimal liest.
        // Werkzeugname zeigt die Shell: sonst sieht man in der Zeile nicht, ob
        // der Befehl unter WSL oder in der PowerShell lief – bei Fehlern ist das
        // die erste Frage.
        const toolName = shellLabel === 'PowerShell' ? 'PowerShell' : 'Bash';

        onActionProgress?.(`Shell: ${commandToRun}`, '', {
            tool: toolName, target: commandToRun, running: true
        });

        const result = await this.shellRunner.run(commandToRun, workDir, 120_000, confirm, shellKind);
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 4000);
        const ok = result.exitCode === 0;

        onActionProgress?.(`Shell: ${commandToRun}`, output || '(keine Ausgabe)', {
            tool: toolName,
            target: commandToRun,
            detail: ok ? undefined : `Exit ${result.exitCode}`,
            ok
        });

        return {
            type: 'shell',
            description: `Shell: ${commandToRun.slice(0, 60)}`,
            success: result.exitCode === 0,
            output: output || '(keine Ausgabe)'
        };
    }

    /**
     * Entscheidungsfrage an den Benutzer – und warten.
     *
     * Das Gegenstück zu Claude Codes Frage-Dialog: eine Frage, 2–4 Optionen mit
     * Beschriftung und Erklärung, Einfach- oder Mehrfachauswahl, plus ein
     * Freitextfeld für „etwas anderes". Die Antwort geht als Ausgabe der Aktion
     * zurück ins Modell, also in die nächste Runde der Schleife.
     *
     * Wichtig für die Schleife: die Antwort ist eine ERFOLGREICHE Aktion mit
     * Ausgabe. Damit greift Zweig 3 von `planNextStep` und das Modell arbeitet
     * mit der Entscheidung weiter, statt stehenzubleiben.
     */
    private async handleAskUserAction(
        content: string,
        confirm: ConfirmFn,
        onActionProgress?: ActionProgressCallback
    ): Promise<ExecutedAction> {
        const request = AIEngine.parseAskBlock(content);
        if (!request.question || request.options.length === 0) {
            throw new Error('ask_user braucht "question:" und mindestens eine Option');
        }

        this.logger.info(`Frage an den Benutzer: ${request.question} `
            + `(${request.options.length} Optionen${request.multi ? ', Mehrfachauswahl' : ''})`);

        onActionProgress?.(`Frage: ${request.question}`, '', {
            tool: 'Frage', target: request.question, running: true
        });

        // Ohne Dialog-Callback (kopflos, Tests, Sidebar) über die
        // Bestätigungskarte fragen – die kennt jeder Aufrufer.
        const answer = this.onAsk
            ? await this.onAsk(request)
            : await confirm(
                `${request.question}\n\n`
                + request.options.map(o => `- **${o.label}** – ${o.description}`).join('\n'),
                request.options.map(o => o.label)
            );

        const clean = (answer ?? '').trim();

        onActionProgress?.(`Frage: ${request.question}`, clean || '(abgebrochen)', {
            tool: 'Frage', target: request.question,
            detail: clean ? undefined : 'abgebrochen', ok: !!clean
        });

        if (!clean) {
            return {
                type: 'shell',
                description: `Frage unbeantwortet: ${request.question.slice(0, 50)}`,
                success: false,
                output: 'The user did not answer. Do not ask again – decide yourself, '
                    + 'state your assumption in one sentence and carry on.'
            };
        }

        this.logger.info(`Antwort des Benutzers: ${clean}`);
        return {
            type: 'shell',
            description: `Entscheidung: ${clean.slice(0, 60)}`,
            success: true,
            output: `The user answered the question "${request.question}" with: ${clean}\n\n`
                + `Work with that decision now. Do not ask again.`
        };
    }

    /**
     * `ask_user`-Block zerlegen.
     *
     * Format – Kopfzeilen plus eine Option pro Zeile:
     *
     *     header: Bibliothek
     *     question: Welche Datumsbibliothek?
     *     multi: false
     *     options:
     *     date-fns — klein, modular, Standard in neuen Projekten
     *     Luxon — Zeitzonen eingebaut, größer
     *
     * Der Gedankenstrich trennt Beschriftung und Erklärung; erlaubt sind „—",
     * „–", „ - " und „:". Fehlt er, ist die ganze Zeile die Beschriftung.
     */
    static parseAskBlock(raw: string): AskRequest {
        const text = raw.replace(/\r\n/g, '\n');
        const field = (name: string): string => {
            const m = new RegExp(`^\\s*${name}:\\s*(.*)$`, 'im').exec(text);
            return (m?.[1] ?? '').trim();
        };

        const question = field('question') || field('frage');
        const header = field('header') || field('titel') || 'Entscheidung';
        const multi = /^(true|ja|yes|1)$/i.test(field('multi') || field('mehrfach'));

        // Optionen: alles nach einer Zeile `options:` bzw. `optionen:`,
        // sonst jede Zeile, die wie eine Aufzählung aussieht.
        const optionsStart = /^\s*(?:options|optionen):\s*$/im.exec(text);
        const body = optionsStart
            ? text.slice(optionsStart.index + optionsStart[0].length)
            : text;

        const known = /^\s*(?:question|frage|header|titel|multi|mehrfach|absicht|options|optionen)\s*:/i;
        const options: AskOption[] = [];
        for (const line of body.split('\n')) {
            // Nur echte Aufzählungszeichen entfernen. Ein weiter gefasstes
            // Muster fräst auch die Beschriftung an: aus „3 Varianten" würde
            // „Varianten".
            const trimmed = line.replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, '').trim();
            if (!trimmed || known.test(line)) continue;
            // Trenner zwischen Beschriftung und Erklärung. Der Bindestrich
            // braucht Abstand auf BEIDEN Seiten, sonst zerschneidet er
            // „date-fns" mitten im Namen.
            const split = /\s+(?:—|–|::)\s*|\s+-\s+|:\s+/.exec(trimmed);
            if (split) {
                options.push({
                    label: trimmed.slice(0, split.index).trim(),
                    description: trimmed.slice(split.index + split[0].length).trim()
                });
            } else {
                options.push({ label: trimmed, description: '' });
            }
            if (options.length >= 4) break;   // wie bei Claude Code: höchstens 4
        }

        return { header, question, options, multi };
    }

    /**
     * Shell-Block zerlegen: optionale Kopfzeile `shell: powershell`, Rest Befehl.
     *
     * Der Block darf beides sein – eine reine Befehlszeile (der übliche Fall)
     * oder ein Kopf-plus-Rumpf-Block mit `---`. Ein Befehl, der zufällig mit
     * „shell:" beginnt, wird nicht zur Kopfzeile: geprüft wird auf die beiden
     * bekannten Werte.
     */
    static parseShellBlock(raw: string): { shellKind: ShellKind; command: string } {
        const lines = raw.replace(/\r\n/g, '\n').split('\n');
        let shellKind: ShellKind = 'auto';
        let start = 0;

        const head = /^\s*shell:\s*(\w+)\s*$/i.exec(lines[0] ?? '');
        if (head) {
            const value = head[1].toLowerCase();
            if (value === 'powershell' || value === 'ps' || value === 'pwsh') {
                shellKind = 'powershell';
                start = 1;
            } else if (value === 'wsl' || value === 'bash' || value === 'sh') {
                shellKind = value === 'wsl' ? 'wsl' : 'bash';
                start = 1;
            }
        }

        // Trenner überspringen – auch wenn gar keine Kopfzeile davor stand:
        // manche Modelle schreiben ihn gewohnheitsmäßig immer.
        while (/^\s*(?:---)?\s*$/.test(lines[start] ?? '')
               && start < lines.length
               && !/\S/.test(lines[start] ?? '')) {
            start++;
        }
        if (/^\s*---\s*$/.test(lines[start] ?? '')) start++;

        return { shellKind, command: lines.slice(start).join('\n') };
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

        // Kompakte Anzeige: Werkzeugname, Ziel, Zusatz – getrennt, damit die
        // Oberfläche eine Terminalzeile daraus bauen kann.
        const DISPLAY: Record<string, string> = {
            read_file: 'Read', grep: 'Grep', glob: 'Glob', list_dir: 'List'
        };
        // description hat die Form "read_file: src/a.ts (L1–115)"
        const parsed = /^[\w_]+:\s*(.+?)(?:\s*[(→]\s*(.+?)\)?)?$/.exec(result.description);
        onActionProgress?.(result.description, result.output.slice(0, 4000), {
            tool: DISPLAY[type] ?? type,
            target: parsed?.[1]?.trim(),
            detail: parsed?.[2]?.trim(),
            ok: true
        });

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

        // Die Zusammenfassung ist die Schlussantwort, keine Werkzeugausgabe.
        // Als `output` landete sie in einer Monospace-Box mit vier sichtbaren
        // Zeilen – Aufzählungen und Hervorhebungen darin waren nur Rohtext.
        // `process()` gibt sie deshalb als Nachricht in den Chat.
        this.lastDoneSummary = text;

        return {
            type: 'info',
            description: '✅ Aufgabe abgeschlossen',
            success: true,
            output: text || undefined
        };
    }

    /**
     * Seite abrufen und ihren Text an die KI geben.
     *
     * Ohne dieses Werkzeug bekommt das Modell aus einer Suche nur Titel und
     * Adressen – damit kann es keine Frage beantworten. Erst der Seiteninhalt
     * hilft. Deshalb hat auch Claude Code neben der Suche ein Abrufwerkzeug.
     */
    private async handleWebFetchAction(
        content: string,
        onActionProgress?: ActionProgressCallback
    ): Promise<ExecutedAction> {
        const urlMatch = content.match(/^url:\s*(\S+)$/m)
            ?? content.match(/(https?:\/\/\S+)/);
        if (!urlMatch) throw new Error('Keine URL im web_fetch Block gefunden');
        const url = urlMatch[1].trim().replace(/[).,]+$/, '');

        onActionProgress?.(`Fetch: ${url}`, '', { tool: 'Fetch', target: url, running: true });

        try {
            const page = await WebSearcher.getInstance().fetchPage(url);
            const header = page.title ? `# ${page.title}\n(${page.url})\n\n` : `(${page.url})\n\n`;
            const body = header + page.text;

            onActionProgress?.(`Fetch: ${url}`, page.text.slice(0, 4000), {
                tool: 'Fetch', target: url,
                detail: `${page.text.length} Zeichen`, ok: true
            });

            return {
                type: 'web_search',
                description: `Seite gelesen: ${page.title || url}`,
                success: page.text.length > 0,
                output: body
            };
        } catch (err) {
            const msg = (err as Error).message;
            onActionProgress?.(`Fetch: ${url}`, msg, {
                tool: 'Fetch', target: url, ok: false
            });
            return {
                type: 'web_search',
                description: `Seite nicht abrufbar: ${url}`,
                success: false,
                output: `${msg}\n\nPrüfe die Adresse oder nutze web_search, um eine andere Quelle zu finden.`
            };
        }
    }

    private async handleWebSearchAction(content: string, onActionProgress?: ActionProgressCallback): Promise<ExecutedAction> {
        const queryMatch = content.match(/^query:\s*(.+)$/m);
        if (!queryMatch) throw new Error('Kein "query:" in web_search Block gefunden');
        const query = queryMatch[1].trim();

        onActionProgress?.(`Web-Suche: ${query}`, '', { tool: 'Search', target: query, running: true });
        const searcher = WebSearcher.getInstance();
        const searchResult = await searcher.search(query, 5);
        const formatted = searcher.formatForAI(searchResult);

        onActionProgress?.(`Web-Suche: ${query}`, formatted.slice(0, 4000), {
            tool: 'Search', target: query,
            detail: `${searchResult.results.length} Ergebnis(se)`, ok: true
        });
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

        // Ab Runde 1 ist `userPrompt` der Fortsetzungs-Prompt der Schleife, nicht
        // der Auftrag. In der Zusammenfassung muss der Auftrag stehen.
        const task = this.currentTask || userPrompt;
        parts.push(`Aufgabe: "${task.slice(0, 200).replace(/\n/g, ' ')}"`);

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
        // Genau dieselbe Normalisierung wie im Parser: was ausgeführt wird, muss
        // auch aus der Anzeige verschwinden. Sonst liest der Benutzer
        // „action:done" oder „>>>REPLACE" samt Quellcode statt einer Antwort.
        return this.normalizeActionMarkup(text)
            .replace(/<think>[\s\S]*?<\/think>/gi, '')              // Reasoning-Blöcke
            .replace(/```action:\w+[^\n]*\n[\s\S]*?```\n?/g, '')    // Backtick-Blöcke
            .replace(/<action:\w+>[\s\S]*?<\/action:\w+>\n?/g, '')  // XML-Tags
            .replace(/\[action:\w+\][\s\S]*?\[\/action:\w+\]\n?/g, '') // Bracket-Tags
            // Ein Block, dessen Schluss-Zaun das Modell ganz vergessen hat:
            // ab der Kopfzeile bis zum Textende wegwerfen. Ein abgeschnittener
            // Aktionsblock ist im Chat nie eine Antwort.
            .replace(/```action:\w+[^\n]*\n[\s\S]*$/g, '')
            // Uebrige Patch-Marker: der Block war weg, die Marker standen noch da
            .replace(/^\s*(?:<<<SEARCH|>>>REPLACE|>>>>>>>\s*REPLACE|<<<<<<<\s*SEARCH)\s*$/gm, '')
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

            // Die letzte Sitzung kommt als EINE Hintergrund-Notiz zurück, nicht
            // als nachgespielte Gesprächsrunden. Sonst hält das Modell die alte
            // Aufgabe für die laufende – siehe HistoryManager.getLastSessionDigest.
            if (!this.historyLoaded) {
                this.historyLoaded = true;
                const digest = this.historyManager.getLastSessionDigest();
                if (digest) {
                    this.conversationHistory = [{
                        role: 'user',
                        content:
                            `For your information – this happened in the PREVIOUS, FINISHED ` +
                            `session. It is background knowledge only and NOT an open task. ` +
                            `Work exclusively on the task that comes next.\n\n${digest}`
                    }, {
                        role: 'assistant',
                        content: 'Understood – that is background. I am waiting for the new task.'
                    }];
                    this.logger.info(`Hintergrund-Notiz aus letzter Session geladen (${digest.length} Zeichen)`);
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
                            'You extract search terms. ' +
                            'Return ONLY the optimised query — at most 5 words, no explanation, ' +
                            'no punctuation. Keep product and library names verbatim.\n\n' +
                            'Examples:\n' +
                            'Input: "suche im Internet nach der REST API von Checkmk"\n' +
                            'Output: Checkmk REST API\n\n' +
                            'Input: "recherchiere wie man in Python async/await benutzt"\n' +
                            'Output: Python async await tutorial\n\n' +
                            'Input: "look up the npm docs for axios and show me examples"\n' +
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
