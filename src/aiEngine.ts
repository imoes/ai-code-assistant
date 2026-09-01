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
import { LoopBudget } from './commands';
import { PracticeStore } from './practices';
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
 * Language policy – appears at the beginning of every system prompt.
 *
 * The instructions to the model are **English**: the models follow English
 * Instructions are more reliable, and the tool descriptions become shorter.
 * The response should remain unaffected and in the user's language
 * occur – otherwise an assistant with a German interface will suddenly respond
 * English. Therefore, the rule is explicitly set and repeated multiple times
 * (announcements, plan points, closing text), because that is exactly where a relapse into
 * Display to the user immediately.
 */
export const LANGUAGE_RULE =
    '## Language\n' +
    'These instructions are in English. Your ANSWER is not: always write to the user ' +
    'in the language they used in their request. That applies to everything the user ' +
    'reads – your prose, the sentence announcing each action, the plan items and the ' +
    'closing summary. Identifiers, code, file paths, shell commands and the action ' +
    'block syntax stay as they are.\n';

/** Assistant's working mode. */
export type AssistantMode = 'ask' | 'auto' | 'plan';

/**
 * Aktuellen Arbeitsmodus lesen.
 *
 * `aiAssistant.mode` is the source of truth. Only as long as no one
 * has been set, the old `autoApply` continues to apply – so that existing installations
 * do not suddenly run in the wrong mode after the update.
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

/** A step in the assistant's work plan. */
export interface PlanStep {
    text: string;
    status: 'todo' | 'doing' | 'done';
}

/** Callback when the assistant creates or updates its plan. */
export type PlanCallback = (steps: PlanStep[]) => void;

/** Callback invoked for each repair iteration */
export type IterationCallback = (iteration: number, reason: string) => void;

/**
 * Describes an action so that the display can render it cleanly.
 *
 * Previously, the UI only received a ready-made string containing an emoji and
 * had to disassemble it. With these fields, it can create a compact line
 * build – tool name, target, additional info – as in a terminal.
 */
export interface ActionMeta {
    /** Display name of the tool: Read, Grep, Bash, … */
    tool: string;
    /** Worauf es angewendet wurde: Pfad, Suchmuster, Befehl */
    target?: string;
    /** Additional information at the end of the line, e.g. "L1–115" or "12 matches" */
    detail?: string;
    /** Is the process still running? */
    running?: boolean;
    /** Ergebnis, sobald bekannt */
    ok?: boolean;
}

/** Callback for ongoing actions (shell output, search, ...) */
export type ActionProgressCallback = (
    description: string,
    output: string,
    meta?: ActionMeta
) => void;

/** Callback for running metrics (prompt progress, tokens, tokens/s) */
export type StatsProgressCallback = (stats: GenerationStats) => void;

/**
 * Callback for the assistant's announcement – once per round.
 *
 * Necessary because `process()` only returns the text of the FIRST round: the
 * Announcements from subsequent rounds would otherwise be lost, and the chat would show from round 2 onwards
 * only "next step…" without stating what the assistant plans to do.
 */
export type NarrationCallback = (text: string) => void;

/** An answer option in the decision dialog. */
export interface AskOption {
    label: string;
    description: string;
}

/** A decision question for the user. */
export interface AskRequest {
    /** Short label, 2–3 words – like the tab label in Claude Code */
    header: string;
    question: string;
    options: AskOption[];
    /** Multiple selection (checkboxes) instead of single selection (radio buttons) */
    multi: boolean;
}

/**
 * Callback for the decision dialog.
 *
 * Returns the selected labels, with multiple selections separated by `", "`
 * connected – the same form that Claude Code also uses in the webview. One
 * empty string means: the user has canceled.
 */
export type AskCallback = (request: AskRequest) => Promise<string>;

/**
 * AIEngine: Processes prompts, executes actions, writes history.
 *
 * Features:
 *  - command.md: Liest workspace/command.md als permanente KI-Anweisung
 * - Shell feedback loop: On failed commands, the output
 * automatically returned to the AI (max. 3 iterations)
 * - History: Every conversation is saved in ai-code-assistant.json
 * - Context warning: Warns when the model's context limit is approaching
 */
export class AIEngine {
    private static instance: AIEngine;
    private mcpClient = MCPClient.getInstance();
    private fileManager = FileManager.getInstance();
    private shellRunner = ShellRunner.getInstance();
    private analyzer = CodeAnalyzer.getInstance();
    private console = AgentConsole.getInstance();
    private logger = Logger.getInstance();

    /** Current work plan (todo list) of the running task */
    private plan: PlanStep[] = [];

    /** Callback to display the plan in the chat */
    private onPlanUpdate?: PlanCallback;

    /** Callback for running metrics (progress, tokens/second) */
    private onStats?: StatsProgressCallback;

    /** Callback for the announcement per round (see NarrationCallback) */
    private onNarration?: NarrationCallback;

    /** Callback for the decision dialog (see AskCallback) */
    private onAsk?: AskCallback;

    /** Signal set by the AI indicating that the task is completed */
    private taskComplete = false;

    /** Summary from `action:done` – displayed as the final answer */
    private lastDoneSummary = '';

    /**
     * Standing target (`/goal`). `null` means "not yet read from the history"
     * – not the same as "no target set".
     */
    private goal: string | null = null;

    /** Is a `/loop` loop currently running? */
    private loopActive = false;

    /** Commands that were typed during work (see queueUserInput) */
    private pendingInputs: string[] = [];

    /** Learned best practices – loaded only on first access. */
    private practiceStore: PracticeStore | null = null;

    /**
     * The user's instruction from round 0 – verbatim.
     *
     * The continuation prompts of the loop referred to "the original
     * Task", without naming it. The model searched for it in the conversation history
     * and found there the task of presiding. Whoever wants to let others continue working,
     * must send the order every round.
     */
    private currentTask = '';

    /** User-set abort signal – also terminates the loop */
    private cancelled = false;

    /** Is a task currently running? For "new task interrupts the old". */
    private busy = false;

    /** Plan mode: read-only and planning, no changes */
    private planModeActive = false;

    /** Fingerprint of the actions from the last round – detects cycles */
    private lastActionSignature = '';

    /** How often the same round occurred consecutively */
    private repeatCount = 0;

    /** Conversation history (in-memory, also stored in history) */
    private conversationHistory: ChatMessage[] = [];

    /** HistoryManager: is lazily initialized when the Workspace is known */
    private historyManager: HistoryManager | null = null;

    /** Prevents double loading of the history */
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
        this.logger.info('Conversation history reset.');
    }

    /** Register a callback that reports plan changes to the chat. */
    setPlanCallback(cb: PlanCallback | undefined): void {
        this.onPlanUpdate = cb;
    }

    /** Register a callback that reports key figures to the chat. */
    setStatsCallback(cb: StatsProgressCallback | undefined): void {
        this.onStats = cb;
    }

    /** Register a callback that reports the announcement of each round. */
    setNarrationCallback(cb: NarrationCallback | undefined): void {
        this.onNarration = cb;
    }

    /** Set callback for the decision dialog (see AskCallback). */
    setAskCallback(cb: AskCallback | undefined): void {
        this.onAsk = cb;
    }

    /** Aktuellen Arbeitsplan abfragen. */
    getPlan(): PlanStep[] {
        return this.plan.map(s => ({ ...s }));
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Goal (/goal) and Loop (/loop)
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Stehendes Ziel abfragen.
     *
     * The goal is not the order of a round, but what everyone
     * Work through orders – “an assistant that writes code, finds bugs, and
     * corrected". It goes into every request and survives session and restart,
     * because otherwise it disappears exactly when a long task begins.
     */
    getGoal(): string {
        if (this.goal === null) {
            this.ensureHistoryManager();
            this.goal = this.historyManager?.getGoal() ?? '';
        }
        return this.goal;
    }

    /** Set a goal (empty text clears it). */
    setGoal(text: string): void {
        this.goal = text.trim();
        this.ensureHistoryManager();
        this.historyManager?.setGoal(this.goal);
        this.logger.info(this.goal ? `Goal set: ${this.goal}` : 'Goal cleared.');
    }

    /**
     * Repeat working on the goal until the budget is exhausted.
     *
     * A round is a complete `process()` run with its own
     * Agent loop. After that, it is checked whether to continue at all –
     * a loop that does the same thing three times is wasted time.
     *
     * Abbruchbedingungen, in dieser Reihenfolge:
     * 1. The user has canceled (`cancel()`), or a new instruction
     * has replaced the current task.
     * 2. The assistant reports the goal as achieved (`action:done` AND no
     *      offenen Planschritte).
     * 3. Time or round budget exhausted.
     * 4. Two consecutive rounds without any action – then nothing more happens.
     *
     * Without (4), the loop drains the budget while the model in each
     * Round only explains that everything is done.
     */
    async runLoop(
        task: string,
        budget: LoopBudget,
        onStream: StreamCallback,
        confirmFn: ConfirmFn | undefined,
        onIteration?: IterationCallback,
        onActionProgress?: ActionProgressCallback,
        onRound?: (round: number, total: number, note: string) => void
    ): Promise<{ rounds: number; actions: number; stopped: string; log: ExecutedAction[] }> {
        const started = Date.now();
        const deadline = started + budget.minutes * 60_000;
        const goal = this.getGoal();

        let rounds = 0;
        let actions = 0;
        let idleRounds = 0;
        // Every action of every round, so that at the end there is a list of
        // what was actually done. A single run gets that panel; the loop only
        // reported "7 Runden, 23 Aktionen" and the detail scrolled away.
        const log: ExecutedAction[] = [];
        let stopped = 'budget spent';

        this.loopActive = true;
        try {
            while (rounds < budget.rounds) {
                if (this.cancelled) { stopped = 'cancelled'; break; }
                if (Date.now() >= deadline) { stopped = 'time spent'; break; }

                rounds++;
                const left = Math.max(0, Math.round((deadline - Date.now()) / 60_000));

                // In a round-budget scenario, time is not the limit: "still
                // ~120 minutes" to report, while after the third round
                // is misleading. What it depends on is stated in the
                // Labeling of the budget.
                const boundByRounds = /Runde/i.test(budget.label);
                onRound?.(rounds, budget.rounds, boundByRounds
                    ? `${budget.rounds - rounds} round(s) left`
                    : `~${left} minute(s) left`);

                // What the user types in between takes precedence over the
                // loop prompt – they are watching and adjusting.
                const queued = rounds > 1 ? this.takeQueuedPrompt() : null;
                const prompt = queued
                    ?? (rounds === 1
                        ? task
                        : this.buildLoopPrompt(rounds, budget.rounds, left, task, goal));

                const result = await this.process(
                    prompt, onStream, confirmFn, onIteration, 0, onActionProgress
                );
                actions += result.actions.length;
                log.push(...result.actions);

                if (this.cancelled) { stopped = 'cancelled'; break; }

                // Nothing done: once is chance, twice is stagnation.
                if (result.actions.length === 0) {
                    idleRounds++;
                    if (idleRounds >= 2) { stopped = 'no actions left'; break; }
                } else {
                    idleRounds = 0;
                }

                // Reported as complete AND no open planning step: then it is done.
                const openSteps = this.plan.filter(s => s.status !== 'done').length;
                if (this.taskComplete && openSteps === 0) {
                    stopped = 'goal reached';
                    break;
                }
            }
        } finally {
            this.loopActive = false;
        }

        this.logger.info(
            `Loop finished after ${rounds} round(s), ${actions} action(s): ${stopped}`);
        return { rounds, actions, stopped, log };
    }

    /** Is a `/loop` loop currently running? */
    isLooping(): boolean {
        return this.loopActive;
    }

    /**
     * The prompt for each round starting from the second.
     *
     * He names three things that the model otherwise does not have: where it is in the budget
     * states what the goal is, and that "already done" is a valid response
     * is. Without the last point, a model invents work to complete the round.
     * fill.
     */
    private buildLoopPrompt(
        round: number, total: number, minutesLeft: number, task: string, goal: string
    ): string {
        const openSteps = this.plan.filter(s => s.status !== 'done');
        return [
            `LOOP ROUND ${round} of at most ${total} (about ${minutesLeft} minute(s) left).`,
            '',
            goal ? `GOAL:\n${goal}\n` : '',
            `TASK:\n${task}`,
            '',
            openSteps.length > 0
                ? 'Still open in the plan:\n'
                    + openSteps.map(s => `- ${s.text}`).join('\n')
                : 'The plan has no open steps.',
            '',
            'Check what is actually still missing for the goal – read the code, run the',
            'tests. Then do the next concrete step.',
            '',
            'If the goal is genuinely reached: verify it once (tests, or the file you',
            'changed) and finish with action:done. Do NOT invent work to fill the round –',
            '"already done" is a valid answer and ends the loop.'
        ].filter(Boolean).join('\n');
    }

    /**
     * Delete the entire saved history – file and ongoing conversation.
     *
     * @returns Number of removed sessions
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
        this.logger.info('Cancelled by the user: request and agent loop are stopping.');
    }

    /** Is a task currently running? */
    isBusy(): boolean {
        return this.busy;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Haupt-Methode
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Benutzer-Prompt verarbeiten.
     *
     * @param userPrompt     User input
     * @param onStream       Token-Streaming-Callback
     * @param confirmFn      In-Chat confirmation function
     * @param onIteration    Callback when a repair iteration starts
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
            'You are an experienced software developer and AI coding assistant.'
        );

        const confirm: ConfirmFn = autoApply
            ? autoConfirmFn
            : (confirmFn ?? autoConfirmFn);

        // Check for cancellation before a new round begins. The user should
        // be able to exit between iterations, not only at the step limit.
        if (this.cancelled) {
            this.logger.info('Agent loop cancelled (by the user).');
            return { text: '', actions: [], iterations: _depth };
        }

        // New user task → completion signal and discard old plan
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

            // Start the work log in the terminal, if desired
            if (config.get<boolean>('showConsole', true)) {
                this.console.task(userPrompt, mode);
                this.console.show(false);   // anlegen, aber nicht den Fokus klauen
            }
        }

        // In plan mode, changes are locked – even if the model
        // still attempts them (see blockedInPlanMode).
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
            this.logger.info(`Workspace scan: ${allFilesList.length} file(s) in ${root}`);
            workspaceContext = `\n\n## Project\n${this.analyzer.projectOverview()}`;

            // Include the active editor file and files mentioned in the prompt in advance.
            // Intentionally limited to 600 lines: the assistant retrieves the rest
            // specifically using read_file, instead of blindly filling the context.
            const PRELOAD_LINES = 600;

            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const relPath = path.relative(root, editor.document.uri.fsPath);
                const content = editor.document.getText();
                workspaceContext += `\n\n## Currently open file (${relPath})\n` +
                    `\`\`\`\n${this.addLineNumbers(content, PRELOAD_LINES)}\n\`\`\``;
            }

            // Automatically read in other files mentioned in the prompt
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

        // ── Build System Prompt ───────────────────────────────────────────────
        // Order: STABLE first, VARIABLE last.
        // llama.cpp caches the common prompt prefix between requests. In an
        // agent loop with 12 rounds, this is the difference between single
        // and twelvefold prompt evaluation. Everything that changes per round
        // (file contents, plan) must therefore go to the END – otherwise the cache is useless from there
        // on and the large tool manual is evaluated anew every round.
        const fullSystemPrompt = [
            systemPromptBase,
            commandMdContent ? `\n\n## Permanent project instructions\n${commandMdContent}` : '',
            this.buildToolManual(),
            testInstruction,
            this.buildGoalContext(),
            this.getPractices()?.forPrompt() ?? '',
            workspaceContext,
            this.buildPlanContext()
        ].join('');

        // ── Estimate context size ─────────────────────────────────────────────
        // Compress history BEFORE sending the request – otherwise it will blow up.
        const compactNote = await this.compactHistoryIfNeeded(fullSystemPrompt);
        if (compactNote) {
            onActionProgress?.('🗜 History compacted', compactNote);
        }

        const contextWarning = this.checkContextSize(fullSystemPrompt, userPrompt);

        // ── Automatic web search for keywords ───────────────────────
        let searchContext = '';
        if (_depth === 0 && this.detectSearchIntent(userPrompt)) {
            onActionProgress?.('🔍 Refining the search terms…', userPrompt.slice(0, 80));
            const searchQuery = await this.extractSearchQuery(userPrompt);
            onActionProgress?.('🔍 Searching the web…', searchQuery);
            try {
                const searcher = WebSearcher.getInstance();
                const searchResult = await searcher.search(searchQuery, 5);
                searchContext = '\n\n' + searcher.formatForAI(searchResult);
                onActionProgress?.('🔍 Web search finished', `${searchResult.results.length} result(s) for "${searchQuery}"`);
                this.logger.info(`Auto search: "${searchQuery}" → ${searchResult.results.length} result(s)`);
            } catch (err) {
                this.logger.warn(`Auto search failed: ${(err as Error).message}`);
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

        // ── Send AI Request ─────────────────────────────────────────────────
        // Send tools in the OpenAI schema if enabled. llama.cpp renders
        // them into the model's format and parses the response back – therefore
        // it works equally well with Qwen, Gemma, Kimi, laguna, DeepSeek.
        const useNativeTools = config.get<boolean>('nativeToolCalls', true);

        let rawResponse = '';
        let nativeCalls = '';
        /** Announcements from the tool calls (`intent`) – see below */
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
            throw new Error(`The AI is not reachable: ${(err as Error).message}`);
        }

        // Reasoning models (laguna, DeepSeek R1, Qwen, etc.) often design action blocks in the <think> block
        // that they subsequently discard or execute differently. These
        // MUST NOT be executed – only the actual response counts.
        //
        // If the server provided tool calls, THESE are the truth: the
        // response text is then prose. Otherwise, the text is parsed – as a fallback
        // for servers without --jinja and models that ignore the tools and
        // still write their format into the text. (The text normalization
        // occurs in parseAndExecuteActions.)
        const actionSource = nativeCalls || this.stripReasoning(rawResponse);

        // ── Maintain conversation history ──────────────────────────────────────
        // Without reasoning: the thinking part is useless for the next round, but
        // would fill up the context (with reasoning models, often many times the
        // actual response).
        this.conversationHistory.push({ role: 'user', content: userPrompt });
        this.conversationHistory.push({ role: 'assistant', content: actionSource.trim() || rawResponse });
        if (this.conversationHistory.length > 30) {
            this.conversationHistory = this.conversationHistory.slice(-30);
        }
        // Announcement of the assistant BEFORE the actions – otherwise the actions
        // stand without justification.
        //
        // For native tool calls, models return `content: null`: they
        // put everything into the call and write no prose. Therefore, the
        // tools include a field `intent`, which is used here.
        const prose = this.cleanForDisplay(rawResponse);
        const cleanText = prose || toolIntents.join('\n');
        this.console.narration(cleanText);

        // The cleaned text goes to the display in EVERY round – even in the
        // first one. The chat streams the RAW response along with it; without this follow-up
        // the action blocks remain there, and the user reads
        // ">>>REPLACE" along with source code instead of an answer.
        //
        // Empty text is a valid message: then the round consisted only of
        // tool calls and the streamed paragraph is removed.
        this.onNarration?.(cleanText);

        const actions = await this.parseAndExecuteActions(actionSource, confirm, onActionProgress);
        const thinkingBlock = this.extractThinkingBlock(rawResponse);

        // Push the final summary as a message – it is the
        // response to the task and belongs as Markdown in the chat, not in
        // a tool output.
        if (this.lastDoneSummary && this.lastDoneSummary !== cleanText) {
            this.onNarration?.(this.lastDoneSummary);
            this.lastDoneSummary = '';
        }

        // ── Example Detection: AI only showed an example instead of taking action ──
        if (_depth === 0 && actions.length === 0 && config.get<boolean>('autoFixOnError', true)) {
            const hasCodeBlock = /```[\w\s]*\n[\s\S]+?```/.test(actionSource);
            const looksLikeExample = hasCodeBlock && /beispiel|example|so könnte|hier ist wie|du kannst|you can|hier ein|so würde/i.test(actionSource);
            if (looksLikeExample) {
                this.logger.info('Example detection: the AI showed an example without an action → correction prompt');
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
            this.logger.warn('History: HistoryManager is null – nothing was stored.');
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

        // ── Enqueued instruction: here is the clean cut ───────────────
        // The step is finished, the file written, the output is there. What
        // the user has typed in the meantime comes NOW – before
        // the step that the loop itself would have planned.
        const queued = this.takeQueuedPrompt();
        if (queued) {
            const note = 'New instruction received – carrying it out…';
            this.logger.info(`Queued instruction is being inserted (round ${_depth + 1}).`);
            this.console.step(_depth + 1, note);
            onIteration?.(_depth + 1, note);

            const queuedResult = await this.process(
                queued, onStream, confirmFn, onIteration, _depth + 1, onActionProgress
            );

            if (_depth === 0) this.busy = false;
            return {
                text: cleanText,
                actions: [...actions, ...queuedResult.actions],
                contextWarning,
                iterations: queuedResult.iterations + 1
            };
        }

        // ── Agenten-Schleife ──────────────────────────────────────────────────
        const step = this.planNextStep(actions, _depth, config);

        if (step) {
            this.logger.info(`Agent loop step ${_depth + 1}: ${step.reason}`);
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
    // Agent Loop: decides whether and how to continue working
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Determine the next step of the agent loop.
     *
     * Work continues if anything remains open after this round:
     * - Analysis results are available → the AI must now utilize them
     * - Shell command failed → analyze and fix the error
     * - Command output without code changes → act based on the output
     * - The plan still has open steps → process the next step
     *
     * Cancellation occurs on action:done, upon reaching the step limit, or if
     * nothing is left open.
     *
     * @returns Prompt + reasoning for the next round, or null to terminate
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

        // User has canceled – do not continue
        if (this.cancelled) {
            this.logger.info('Agent loop finished: cancelled by the user.');
            return null;
        }

        // The AI has reported the task as completed itself
        if (this.taskComplete) {
            this.logger.info('Agent loop finished: action:done received.');
            return null;
        }

        if (depth >= maxSteps) {
            this.logger.warn(`Agent loop finished: step limit ${maxSteps} reached.`);
            return null;
        }

        const analyses = actions.filter(a => a.type === 'analysis' && a.output?.trim());
        const failedShells = actions.filter(a => a.type === 'shell' && !a.success && a.output?.trim());

        // The instruction is sent in EVERY round. Without it, the model
        // pieces together "the original task" itself from the history.
        const task = this.currentTask
            ? `YOUR TASK (unchanged – this is what you are working on):\n`
                + `${this.currentTask.slice(0, 1500)}\n\n`
            : '';

        // Failed changes (patch did not apply, file missing, rejected).
        // These MUST be reported: otherwise the model will repeat the same
        // patch endlessly, because it never learns that it did not apply.
        const isFileAction = (t: ExecutedAction['type']) =>
            t === 'file_create' || t === 'file_edit' || t === 'file_delete';
        const failedFileActions = actions.filter(
            a => (isFileAction(a.type) || a.type === 'info') && !a.success && a.output?.trim()
        );

        // Nur ERFOLGREICHE Änderungen zählen als getane Arbeit. Vorher galt auch
        // ein gescheiterter Patch als Dateiänderung – dadurch wurden die
        // Befehlsausgaben unterdrückt und die Schleife lief blind weiter.
        const hasFileActions = actions.some(a => isFileAction(a.type) && a.success);

        // ── Detect repetition ─────────────────────────────────────────────
        // If a round yields exactly the same result as the previous one,
        // continuing is pointless: the model is going in circles.
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
                `Agent loop finished: the same round repeated ${this.repeatCount + 1}× ` +
                `(${signature.slice(0, 160)}). The model is not getting anywhere.`
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
            && !a.description.startsWith('File read:')
            && (a.type === 'shell' || (a.type === 'web_search' && !hasFileActions)));

        // ── 1. Fehlgeschlagene Shell-Befehle: Fehler beheben ──────────────────
        if (failedShells.length > 0 && autoFix) {
            const userInstruction = failedShells.find(a => a.output?.startsWith('Instruction from the user:'));
            const ctx = this.formatOutputs(failedShells);

            if (userInstruction) {
                return {
                    reason: 'Instruction from the user – carrying it out…',
                    prompt: `${task}THE USER GAVE YOU AN INSTRUCTION:\n\n${ctx}\n\n` +
                        `Carry it out right away, using action blocks.`
                };
            }
            return {
                reason: `${failedShells.length} error(s) found – analysing…`,
                prompt:
                    `${task}ERROR ANALYSIS REQUIRED:\n\n${ctx}\n\n` +
                    `Read the error output closely. What is the cause? ` +
                    `If you need to see code for that: use read_file or grep. ` +
                    `Then fix the error with the appropriate action blocks. ` +
                    `Do NOT answer with "okay" or an explanation without an action.`
            };
        }

        // ── 1b. Change did not go through: Report the cause ────────
        if (failedFileActions.length > 0 && autoFix) {
            return {
                reason: `${failedFileActions.length} change(s) not applied – fixing…`,
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

        // ── 2. Analysis results are available: now utilize them ─────────────────
        if (analyses.length > 0 && agentLoop) {
            const ctx = this.formatOutputs(analyses);
            const labels = analyses.map(a => a.description).join(', ');
            return {
                reason: `Analysis read (${labels.slice(0, 90)}) – carrying on…`,
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
                reason: 'Output received – analysing…',
                prompt:
                    `${task}COMMAND OUTPUT – ANALYSIS AND ACTION REQUIRED:\n\n` +
                    `${this.formatOutputs(successfulWithOutput)}\n\n` +
                    `Analyse this output with regard to the task above and carry out the next ` +
                    `necessary steps right away (action blocks). ` +
                    `If the output already answers the task: write the answer now and finish ` +
                    `with action:done. Do NOT pick up a task from an earlier session.`
            };
        }

        // ── 3b. The round was nothing but bookkeeping ─────────────────────────
        // In the window run the assistant said "I am updating the plan and will
        // now run the tests" – and sent nothing but a plan in which the test
        // step was ticked off. Nobody ran anything. To the loop the round looked
        // like progress, because the plan had moved, so it carried on and lost
        // the test run silently.
        //
        // A plan is an announcement, not an execution. If a round is spent on
        // nothing else, it is named here.
        const onlyBookkeeping = actions.length > 0
            && actions.every(a => a.type === 'plan' || (a.type === 'info' && !this.taskComplete));
        if (onlyBookkeeping && agentLoop) {
            return {
                reason: 'Only the plan moved – carry out the step…',
                prompt:
                    `${task}THAT ROUND ONLY UPDATED BOOKKEEPING – no work was done.\n` +
                    `A plan is an announcement, not an execution. Marking a step as done ` +
                    `does not make it done.\n\n` +
                    `Carry out the next open step NOW with a real action block ` +
                    `(read_file, patch_file, create_file, shell, …). ` +
                    `If a step says "run the tests", then run them with action:shell. ` +
                    `If everything really is finished: action:done.`
            };
        }

        // ── 4. Plan hat offene Schritte: weiterarbeiten ───────────────────────
        const openSteps = this.plan.filter(s => s.status !== 'done');
        if (agentLoop && config.get<boolean>('planningEnabled', true)
            && this.plan.length > 0 && openSteps.length > 0 && actions.length > 0) {
            const next = openSteps[0];
            return {
                reason: `Plan: ${this.plan.length - openSteps.length}/${this.plan.length} done – next step…`,
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
                reason: 'Change not verified yet – starting the tests…',
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

    /** Format action outputs as a context block for the next round. */
    private formatOutputs(actions: ExecutedAction[]): string {
        return actions.map(a => {
            if (a.output?.startsWith('Instruction from the user:')) {
                return `**${a.output}**`;
            }
            const status = a.success ? '✅' : '❌';
            return `${status} ${a.description}\n\`\`\`\n${this.capOutput(a.output ?? '')}\n\`\`\``;
        }).join('\n\n');
    }

    /** Upper limit for a single action output in the follow-up prompt. */
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
            + `\n\n[… ${dropped} characters omitted. If you need the middle: `
            + `read_file with offset/limit, or grep with a pattern. …]\n\n`
            + text.slice(-tail);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // command.md lesen
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Tool manual for the system prompt: all action blocks + workflow.
     *
     * Consciously split into two phases: first READ/ANALYZE, then WRITE. The assistant
     * should understand the existing code before modifying it.
     */
    private buildToolManual(): string {
        const config = vscode.workspace.getConfiguration('aiAssistant');
        const planning = config.get<boolean>('planningEnabled', true);
        const analyze = config.get<boolean>('autoAnalyze', true);
        const agentLoop = config.get<boolean>('agentLoop', true);
        const maxSteps = config.get<number>('maxAgentSteps', 12);
        const mode = getAssistantMode();

        const parts: string[] = [];

        // The language rule comes FIRST – it is the reason why the manual
        // is allowed to be in English in the first place.
        parts.push(LANGUAGE_RULE);

        parts.push(
            `\n\n## Your role\n` +
            `You are an autonomous coding assistant with direct access to this workspace. ` +
            `You analyse, plan, write and test code on your own – like an experienced developer ` +
            `who sees the task through to the end.\n`
        );

        // ── Plan Mode: only examine and plan ───────────────────────────
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
            `Prefer WSL. Only reach for PowerShell when WSL cannot do the job.\n` +
            `If a command could sensibly run in EITHER and the answer changes what you ` +
            `do next, ask with action:ask_user instead of guessing — one round of asking ` +
            `beats three rounds of a command failing in the wrong shell:\n` +
            `\`\`\`action:ask_user\nheader: Shell\nquestion: Which shell should run this?\n` +
            `options:\n` +
            `- WSL — POSIX tools, the project's build and test commands\n` +
            `- PowerShell — Windows services, registry, Windows-only programs\n\`\`\`\n\n` +
            `Web search (returns title, address and a short excerpt):\n` +
            `\`\`\`action:web_search\nquery: search terms\n\`\`\`\n\n` +
            `Fetch and read a page – almost always needed after a search, because the\n` +
            `result list alone answers no question:\n` +
            `\`\`\`action:web_fetch\nurl: https://example.com/docs\n\`\`\`\n`
        );

        // ── Learning from successes ──────────────────────────────────────────────
        // Hermes is the role model: what has proven itself becomes reusable
        // procedural knowledge. The value depends entirely on the selection – a
        // collection of "bug fixed" notes is dead weight in any prompt.
        parts.push(
            `\n## Learning from what worked\n` +
            `When something non-obvious worked and you VERIFIED it (tests green, ` +
            `command succeeded), record it as a rule for next time:\n` +
            `\`\`\`action:remember\nregel: Run the tests with \`npm test\`, not \`node --test\`\n` +
            `warum: pretest compiles first; without it the tests run against stale output\n\`\`\`\n\n` +
            `A good rule is short, imperative and true next week too. Record:\n` +
            `- how something is built, tested or started in THIS project\n` +
            `- a pitfall that cost you a round, and what avoids it\n` +
            `- a convention you had to discover from the code\n\n` +
            `Do NOT record:\n` +
            `- what you did today ("fixed the tokenizer") – that is a diary entry, ` +
            `it helps nobody next time\n` +
            `- anything you did not verify – an unverified guess is worse than no rule\n` +
            `- general programming knowledge you already have\n` +
            `- something already listed under "What worked in this project before"\n\n` +
            `At most one rule per task. If nothing was learned, record nothing – ` +
            `that is the normal case.\n`
        );

        // ── User Inquiry ───────────────────────────────────────────────────────
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

        // ── Announcement before every action ──────────────────────────────────────────
        // Without this instruction, the model executes tools silently and the
        // user only sees a list of actions, without knowing why.
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
    /**
     * The standing target as a prompt block.
     *
     * Comes BEFORE the workspace context, because it changes per round and that
     * Goal not: llama.cpp caches the common prompt prefix, and everything
     * Stable belongs at the front.
     */
    private buildGoalContext(): string {
        const goal = this.getGoal();
        if (!goal) return '';
        return `\n\n## Standing goal\n${goal}\n`
            + `Every task works towards this. If a request conflicts with it, say so in `
            + `one sentence and follow the request – the user knows their goal.\n`;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Gelernte Best Practices
    // ──────────────────────────────────────────────────────────────────────────

    /** The memory of learned rules (null if no workspace is open). */
    getPractices(): PracticeStore | null {
        if (!this.practiceStore) {
            try {
                this.practiceStore = new PracticeStore(this.fileManager.getWorkspaceRoot());
            } catch {
                return null;   // ohne Workspace gibt es nichts zu lernen
            }
        }
        return this.practiceStore;
    }

    /**
     * Remember a rule – from `action:remember`.
     *
     * Deliberately no own action type: it is a note, not a change to
     * Project. A discarded duplicate is still a success, otherwise it would hold that
     * Model it for a failure and try again in the next round
     * once again.
     */
    private handleRememberAction(content: string): ExecutedAction {
        const rule = /^\s*(?:regel|rule|praxis|practice):\s*(.+)$/mi.exec(content);
        const why = /^\s*(?:warum|why|grund|evidence|beleg):\s*(.+)$/mi.exec(content);

        const ruleText = (rule?.[1] ?? content.split('\n')[0] ?? '').trim();
        const whyText = (why?.[1] ?? '').trim();

        const store = this.getPractices();
        if (!store) {
            return {
                type: 'info',
                description: 'No workspace – nothing remembered',
                success: false,
                output: 'There is no workspace open, so there is nowhere to store the rule.'
            };
        }

        const added = store.add(ruleText, whyText);
        return {
            type: 'info',
            description: added
                ? `💡 Learned: ${ruleText.slice(0, 60)}`
                : `💡 Already known: ${ruleText.slice(0, 60)}`,
            success: true,
            output: added
                ? 'Stored. It will be part of every future request in this project.'
                : 'Already known (or too vague) – nothing stored. Do not try again; '
                    + 'carry on with the task.'
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Eingereihte Anweisungen
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Eine Anweisung einreihen, die während der Arbeit getippt wurde.
     *
     * Sie unterbricht NICHT. Der laufende Schritt wird zu Ende gebracht, dann
     * kommt sie dran – so hält es auch Claude Code. Wer sofort abbrechen will,
     * nimmt `cancel()`.
     *
     * Der Grund gegen das Unterbrechen: mitten in einem Schritt abzubrechen
     * lässt halbfertige Arbeit zurück – eine Datei geändert, die Tests nicht
     * gelaufen. Am Schrittende ist der Zustand sauber.
     */
    queueUserInput(text: string): number {
        const clean = text.trim();
        if (!clean) return this.pendingInputs.length;
        this.pendingInputs.push(clean);
        this.logger.info(`Instruction queued (${this.pendingInputs.length} waiting): `
            + clean.slice(0, 80));
        return this.pendingInputs.length;
    }

    /** How many instructions are waiting? */
    pendingInputCount(): number {
        return this.pendingInputs.length;
    }

    /** Discard all pending instructions (on cancellation and new task). */
    clearQueuedInput(): void {
        this.pendingInputs = [];
    }

    /**
     * Get the next enqueued instruction as a prompt – or `null`.
     *
     * Several instructions are summarized into one: who three times
     * pushes forward, does not want three rounds of individual processing.
     */
    private takeQueuedPrompt(): string | null {
        if (this.pendingInputs.length === 0) return null;
        const all = this.pendingInputs.splice(0);

        // The order grows with it: otherwise, the additional request only exists in this
        // one round and is forgotten in the next one.
        this.currentTask = `${this.currentTask}\n\nNachtrag: ${all.join(' ')}`.trim();

        return 'NEW INSTRUCTION FROM THE USER – it arrived while you were working and '
            + 'takes precedence over the step you had planned next:\n\n'
            + all.map(t => `- ${t}`).join('\n')
            + '\n\nCarry it out now. Keep what you already did; do not start over.';
    }

    /** Current plan as a context block (so the AI knows where it stands). */
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
     * These files are the "project contract": conventions, build commands,
     * Prohibitions. They are provided as permanent rules with EVERY request –
     * just like Claude Code reads CLAUDE.md.
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
                // Shorten very large instruction files so that the context does not overflow
                const clipped = content.length > 8000
                    ? content.slice(0, 8000) + '\n… [cut]'
                    : content;
                blocks.push(`### ${name}\n${clipped}`);
                this.logger.info(`Project instructions loaded: ${name} (${content.length} characters)`);
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

        // Rough estimate: 1 token ≈ 4 characters
        const chars = systemPrompt.length
            + this.conversationHistory.reduce((sum, m) => sum + m.content.length, 0);
        const estimated = Math.round(chars / 4);

        if (estimated < limit) return undefined;

        const before = this.conversationHistory.length;
        // The last four messages are the current work status – they
        // remain verbatim so that the assistant does not lose track.
        const keep = this.conversationHistory.slice(-4);
        const fold = this.conversationHistory.slice(0, -4);
        if (fold.length === 0) return undefined;

        this.logger.info(
            `Compacting the history: ~${estimated} of ${ctx} tokens (${percent}% limit: ${limit}), ` +
            `${fold.length} message(s) are being summarised.`
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
            // Summarization failed → hard truncate instead of letting the request
            // fail. A truncated history is better than none.
            this.logger.warn(`Compacting failed (${(err as Error).message}) – falling back to a hard cut.`);
            this.conversationHistory = keep;
            return `⚠ History shortened: ${before - keep.length} message(s) removed `
                + `(no summary possible).`;
        }

        if (!summary) {
            this.conversationHistory = keep;
            return `⚠ History shortened: ${before - keep.length} message(s) removed.`;
        }

        this.conversationHistory = [
            { role: 'assistant', content: `## Summary of the conversation so far\n${summary}` },
            ...keep
        ];

        const afterChars = systemPrompt.length
            + this.conversationHistory.reduce((sum, m) => sum + m.content.length, 0);
        const afterTokens = Math.round(afterChars / 4);

        this.logger.info(`History compacted: ~${estimated} → ~${afterTokens} tokens.`);
        return `🗜 History compacted: ${fold.length} message(s) summarised `
            + `(~${estimated} → ~${afterTokens} tokens, limit ${percent}% of ${ctx}).`;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Check context size
    // ──────────────────────────────────────────────────────────────────────────

    private checkContextSize(systemPrompt: string, userPrompt: string): string | undefined {
        const config = vscode.workspace.getConfiguration('aiAssistant');
        const maxTokens = config.get<number>('maxTokens', 2048);
        const warnThreshold = config.get<number>('contextWarningThreshold', 6000);

        // Rough token estimate: 1 token ≈ 4 characters
        const historyChars = this.conversationHistory
            .reduce((sum, m) => sum + m.content.length, 0);
        const totalChars = systemPrompt.length + historyChars + userPrompt.length;
        const estimatedTokens = Math.round(totalChars / 4);

        this.logger.info(`Context estimate: ~${estimatedTokens} tokens (history: ${this.conversationHistory.length} messages)`);

        if (estimatedTokens > warnThreshold) {
            const percent = Math.round((estimatedTokens / warnThreshold) * 100);
            return `⚠ Context limit: ~${estimatedTokens} tokens estimated (${percent}% of the threshold ${warnThreshold}). ` +
                   `Consider resetting the conversation (🔄 New) to keep the quality up.`;
        }
        return undefined;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Parse and execute actions
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
            // Fence directly BEFORE >>>REPLACE
            .replace(/\r?\n[ \t]*```[ \t]*(?=\r?\n[ \t]*>>>+REPLACE)/g, '')
            // Fence directly AFTER <<<SEARCH
            .replace(/(<<<+SEARCH>*[ \t]*\r?\n)[ \t]*```[\w-]*[ \t]*\r?\n/g, '$1')
            // Fence directly AFTER >>>REPLACE
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

            // The content consists of the following lines, as long as they are like arguments
            // aussehen. Prosa danach bleibt Prosa.
            const body: string[] = [];
            let j = i + 1;
            while (j < lines.length) {
                const l = lines[j];
                if (/^\s*$/.test(l) && body.length > 0) break;
                if (/^\s*```/.test(l) || /^\s*action:\w+\s*$/.test(l)) break;
                const looksLikeArg = /^\s*\w+:\s*/.test(l) || /^\s*-\s*\[.\]/.test(l);
                // Allow continuation lines of a multi-line value only
                // if an argument is already present.
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
     * Bring all model spellings into `\`\`\`action:name … \`\`\``.
     *
     * **This method is the only normalization – Parser AND display
     * use them.** Previously, the parser had one more level than the display,
     * and the result appeared in the window: a `patch_file` block with shifted
     * Fences were executed (the parser could straighten them out), but remained
     * as text in the chat – the user read `>>>REPLACE` and the
     * Source code instead of an answer. Whoever adds a level here adds it
     * so that it automatically works for both directions.
     *
     * Converted: XML tags (Gemma, Qwen), bracket tags, the native
     * Tool-call formats of all model families, fenceless headers and
     * excess or missing fences in patch blocks.
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
     * Add missing end fences.
     *
     * Observed in the window: the model wrote two blocks in a row and
     * remove the fence in between.
     *
     *     ```action:list_dir
     *     path: src
     *     ```action:list_dir
     *     path: test
     *     ```
     *
     * The block pattern then ends at the fence of the SECOND header row: the first block
     * is executed, the rest remains as text – and was thus in the chat.
     * A new header within a block means: the previous one is finished.
     *
     * Runs after `normalizePatchFences`, because fences
     * allowed; that clears that stage beforehand.
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

    /**
     * These actions already show themselves in the chat: the plan as a card with
     * ticks, `done` as the answer text. A second row with the same output in a
     * monospace box would not be more feedback, only more text.
     */
    static readonly HAS_OWN_DISPLAY = new Set(['plan', 'todo', 'done', 'finish']);

    /** Tool name for the row in the chat – short, the way a terminal reads. */
    static toolLabel(actionType: string): string {
        const labels: Record<string, string> = {
            read_file: 'Read', grep: 'Grep', glob: 'Glob', list_dir: 'List',
            create_file: 'Write', edit_file: 'Write', patch_file: 'Patch',
            replace_lines: 'Patch', delete_file: 'Delete',
            shell: 'Bash', web_search: 'Search', web_fetch: 'Fetch',
            plan: 'Plan', todo: 'Plan', done: 'Done', finish: 'Done',
            remember: 'Learned', ask_user: 'Question'
        };
        return labels[actionType] ?? actionType;
    }

    /**
     * What an action was applied to, for the row in the chat: the path, the
     * command, the question. Without it the row shows only the tool name.
     */
    static actionTarget(actionType: string, block: string, description: string): string {
        // File actions carry the path in a header line.
        const path = /^\s*path:\s*(.+)$/mi.exec(block);
        if (path) return path[1].trim();

        if (actionType === 'shell') {
            const { command } = AIEngine.parseShellBlock(block);
            return command.trim().split('\n')[0].slice(0, 80);
        }

        // Otherwise the part of the description after the colon –
        // "Plan: 4/5 erledigt" becomes "4/5 erledigt".
        const afterColon = /^[^:]{1,24}:\s*(.+)$/.exec(description);
        return (afterColon?.[1] ?? description).trim().slice(0, 80);
    }

    private async parseAndExecuteActions(response: string, confirm: ConfirmFn, onActionProgress?: ActionProgressCallback): Promise<ExecutedAction[]> {
        const executed: ExecutedAction[] = [];

        const normalized = this.normalizeActionMarkup(response);

        // [^\n]* allows trailing spaces/tabs after the action type
        const blockPattern = /```action:(\w+)[^\n]*\n([\s\S]*?)```/g;
        let match: RegExpExecArray | null;

        // Debug: log found blocks
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

        // Identische Aktionen einer Runde nur EINMAL ausführen.
        //
        // Im Lauf gegen laguna kam jeder Werkzeugaufruf doppelt: `npm test`
        // lief zweimal, der Prüfbefehl zweimal, jede Datei wurde zweimal
        // gelesen. Das Modell schickt denselben Aufruf zweimal, und ohne diese
        // Sperre kostet jede Runde doppelt so lange. Bei einem Schreibvorgang
        // wäre es schlimmer als langsam.
        //
        // Nur buchstabengleiche Blöcke: zwei `read_file` auf verschiedene
        // Dateien sind zwei Aufgaben, zwei auf dieselbe Datei ist ein Versehen.
        const seenBlocks = new Set<string>();

        while ((match = blockPattern.exec(normalized)) !== null) {
            const actionType = match[1];
            const blockContent = match[2].trim();

            const blockKey = `${actionType} ${blockContent}`;
            if (seenBlocks.has(blockKey)) {
                this.logger.info(
                    `Action parser: '${actionType}' sent twice – second call skipped.`);
                continue;
            }
            seenBlocks.add(blockKey);

            // Does the handler report for itself? Then no second row is added.
            // A handler's own reports are better labelled ("Read src/x.ts · 74
            // Zeilen", a running state for long fetches), so they take
            // precedence – the fallback below is only the safety net.
            let reported = false;
            const reportingProgress: ActionProgressCallback | undefined = onActionProgress
                ? (description, output, meta) => {
                    reported = true;
                    onActionProgress(description, output, meta);
                }
                : undefined;

            // Plan mode: read-only and planning. Models occasionally attempt to write despite
            // a filtered tool catalog – here is
            // the hard limit, not in the prompt.
            if (this.planModeActive && !READ_ONLY_ACTIONS.has(actionType)) {
                this.logger.warn(`Plan mode: action '${actionType}' blocked.`);
                executed.push({
                    type: 'info',
                    description: `🔒 Plan mode: '${actionType}' not carried out`,
                    success: false,
                    output: `Changes are blocked in plan mode. Finish the plan `
                        + `(action:plan) and finish with action:done. The user then switches `
                        + `to mode "auto" or "ask" themselves to carry it out.`
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
                        executed.push(await this.handleShellAction(blockContent, confirm, reportingProgress));
                        break;
                    case 'remember':
                        executed.push(this.handleRememberAction(blockContent));
                        break;
                    case 'ask_user':
                        executed.push(await this.handleAskUserAction(blockContent, confirm, reportingProgress));
                        break;
                    case 'web_search':
                        executed.push(await this.handleWebSearchAction(blockContent, reportingProgress));
                        break;
                    case 'web_fetch':
                        executed.push(await this.handleWebFetchAction(blockContent, reportingProgress));
                        break;
                    case 'read_file':
                    case 'grep':
                    case 'glob':
                    case 'list_dir':
                        executed.push(this.handleAnalysisAction(actionType, blockContent, reportingProgress));
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

                    // If the handler reported nothing itself, a row is added
                    // here. Otherwise the action stays invisible in the chat:
                    // the five writing handlers, the plan, `done` and
                    // `remember` never called onActionProgress – the user saw
                    // the announcement and then nothing, although a file had
                    // been written.
                    //
                    // Centrally and not in every handler, so that a new action
                    // CANNOT slip through unreported.
                    if (!reported && !AIEngine.HAS_OWN_DISPLAY.has(actionType)) {
                        onActionProgress?.(last.description, last.output ?? '', {
                            tool: AIEngine.toolLabel(actionType),
                            target: AIEngine.actionTarget(actionType, blockContent, last.description),
                            ok: last.success
                        });
                    }
                }
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                this.logger.error(`Action '${actionType}' failed: ${errMsg}`);
                executed.push({
                    type: 'info',
                    description: `Action '${actionType}' failed: ${errMsg}`,
                    success: false,
                    output: errMsg
                });
                this.console.problem(`Action '${actionType}': ${errMsg}`);

                // A thrown error needs its row too – this is the case that
                // matters most. A patch whose search text does not match throws,
                // and in the window run the chat showed the announcement
                // "Tokenizer erweitern" and then, four lines later, "1 Änderung
                // nicht angewendet" – without ever saying WHICH change or why.
                if (!reported) {
                    onActionProgress?.(`${actionType}: ${errMsg}`, errMsg, {
                        tool: AIEngine.toolLabel(actionType),
                        target: AIEngine.actionTarget(actionType, blockContent, errMsg),
                        detail: 'fehlgeschlagen',
                        ok: false
                    });
                }
            }
        }
        return executed;
    }

    /**
     * Clean up the code before writing it to a file.
     *
     * Models sometimes leave remnants of their tool-call serialization in the content
     * stand (observed: a line `</arg_value>` in the middle of the source code, which
     * made the file unusable). This is caught here – and logged,
     * because it indicates a model or server issue.
     */
    private cleanCodeForWrite(content: string, where: string): string {
        const { code, removed } = stripToolMarkupFromCode(content);
        if (removed.length > 0) {
            this.logger.warn(
                `${where}: removed ${removed.length} line(s) of tool-call markup from the ` +
                `file content: ${removed.slice(0, 3).join(', ')}`
            );
            this.console.problem(
                `Markup-Reste im Inhalt entfernt (${removed.slice(0, 2).join(', ')})`
            );
        }
        return code;
    }

    /** Header keys a writing action block may carry before its body. */
    private static readonly BLOCK_HEADER_KEYS =
        /^(path|start_line|end_line|shell|encoding|mode)[ \t]*:/i;

    /**
     * Split a writing action block into its header lines and its body.
     *
     * The documented form separates the two with a line of `---`. Models leave
     * that line out all the time, and until now the block was simply rejected:
     * in one window run SIX attempts in a row died on `Kein "---" Trenner
     * gefunden` – patch_file three times, then replace_lines, edit_file and
     * create_file – and the assistant only got anywhere by falling back to
     * `sed` through the shell. Six rounds for one operator.
     *
     * The separator is redundant anyway: the header consists of known
     * `key: value` lines, so the body starts at the first line that is not one.
     * With an explicit `---` nothing changes – it stays authoritative, which
     * matters for a file whose own first line looks like a header.
     */
    static splitHeaderAndBody(content: string): { header: string; body: string } {
        // Accepts '---', '--- ', '---\r\n', '---\n', also without a trailing newline
        const sep = content.match(/^---[ \t]*(\r?\n|$)/m);
        if (sep && sep.index !== undefined) {
            return {
                header: content.slice(0, sep.index),
                body: content.slice(sep.index + sep[0].length)
            };
        }

        // No separator: read header lines from the top until one is not a header.
        const lines = content.split('\n');
        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            if (line.trim() === '' || AIEngine.BLOCK_HEADER_KEYS.test(line)) { i++; continue; }
            break;
        }

        // Nothing but header lines is not a block we can guess at – let the
        // caller report the missing separator rather than write an empty file.
        if (i === 0 || i >= lines.length) return { header: '', body: '' };

        return { header: lines.slice(0, i).join('\n'), body: lines.slice(i).join('\n') };
    }

    private async handleFileAction(type: 'create_file' | 'edit_file', content: string, confirm: ConfirmFn): Promise<ExecutedAction> {
        const { header, body } = AIEngine.splitHeaderAndBody(content);
        if (!header) throw new Error('No "---" separator found in the action block');
        const pathMatch = header.match(/^path:\s*(.+)$/m);
        if (!pathMatch) throw new Error('No "path:" found');
        const filePath = pathMatch[1].trim();
        const fileContent = this.cleanCodeForWrite(body, `${type}`);

        // Smart-merge during edit_file: The AI often provides only a part of the file.
        // If the new version is significantly shorter → use smart-merge instead of a full replace.
        if (type === 'edit_file') {
            const existing = this.fileManager.readFile(filePath);
            if (existing && existing.length > 0) {
                const existingLines = existing.split('\n').length;
                const newLines = fileContent.split('\n').length;
                if (newLines < existingLines * 0.50 && existingLines > 20) {
                    this.logger.warn(
                        `edit_file: the new version has ${newLines} lines, the original has ${existingLines}. ` +
                        `Starting a smart merge to avoid unintended deletions.`
                    );
                    const ok = await this.fileManager.smartMergeEdit(filePath, fileContent, confirm);
                    return {
                        type: 'file_edit',
                        description: `${ok ? 'Smart merge' : 'Rejected'}: ${filePath}`,
                        success: ok
                    };
                }
            }
        }

        // Fallback: Models confuse create_file/edit_file.
        // When edit_file encounters a non-existent file → create instead of throwing.
        const fileExists = !!this.fileManager.readFile(filePath);
        let actualType = type;
        if (type === 'edit_file' && !fileExists) {
            this.logger.warn(`edit_file on a file that does not exist, "${filePath}" – creating it instead.`);
            actualType = 'create_file';
        }

        const ok = actualType === 'create_file'
            ? await this.fileManager.createFile(filePath, fileContent, { overwrite: true, confirmFn: confirm })
            : await this.fileManager.editFile(filePath, fileContent, confirm);

        const verb = ok
            ? (actualType === 'create_file' ? 'Created' : 'Edited')
            : 'Rejected';
        return {
            type: actualType === 'create_file' ? 'file_create' : 'file_edit',
            description: `${verb}: ${filePath}`,
            success: ok
        };
    }

    private async handleReplaceLinesAction(content: string, confirm: ConfirmFn): Promise<ExecutedAction> {
        const { header, body } = AIEngine.splitHeaderAndBody(content);
        if (!header) throw new Error('No "---" separator found');

        const pathMatch      = header.match(/^path:\s*(.+)$/m);
        const startLineMatch = header.match(/^start_line:\s*(\d+)$/m);
        const endLineMatch   = header.match(/^end_line:\s*(\d+)$/m);

        if (!pathMatch) throw new Error('No "path:" found');

        const filePath   = pathMatch[1].trim();
        const newContent = this.cleanCodeForWrite(body, 'replace_lines');

        // Fallback: file does not exist → create
        if (!this.fileManager.readFile(filePath)) {
            this.logger.warn(`replace_lines on a file that does not exist, "${filePath}" – creating it instead.`);
            const ok = await this.fileManager.createFile(filePath, newContent, { overwrite: false, confirmFn: confirm });
            return { type: 'file_create', description: `${ok ? 'Created' : 'Rejected'}: ${filePath}`, success: ok };
        }

        if (!startLineMatch) throw new Error('No "start_line:" found');
        if (!endLineMatch)   throw new Error('No "end_line:" found');

        const startLine = parseInt(startLineMatch[1], 10);
        const endLine   = parseInt(endLineMatch[1], 10);

        if (isNaN(startLine) || isNaN(endLine) || startLine < 1 || endLine < startLine) {
            throw new Error(`Invalid line numbers: start=${startLine}, end=${endLine}`);
        }

        const ok = await this.fileManager.replaceLines(filePath, startLine, endLine, newContent, confirm);
        return {
            type: 'file_edit',
            description: `${ok ? 'Replaced' : 'Rejected'} L${startLine}-${endLine}: ${filePath}`,
            success: ok
        };
    }

    private async handlePatchAction(content: string, confirm: ConfirmFn): Promise<ExecutedAction> {
        const { header, body: patchBody } = AIEngine.splitHeaderAndBody(content);
        if (!header) throw new Error('No "---" separator found');
        const pathMatch = header.match(/^path:\s*(.+)$/m);
        if (!pathMatch) throw new Error('No "path:" found');
        const filePath = pathMatch[1].trim();

        // Parsing SEARCH/REPLACE blocks: <<<SEARCH\n...\n>>>REPLACE\n...\n (end = next block or EOF)
        // Also accepts old format <<<SEARCH>>> for backward compatibility
        // Adapting Git conflict/Aider notation to our markers. Many
        // models are trained on this and also write it here.
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
            throw new Error('No valid <<<SEARCH...>>>REPLACE blocks found');
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
            description: `${allSuccess ? 'Patched' : 'Patch failed'}: ${filePath} (${patches.length} change${patches.length > 1 ? 's' : ''})`,
            success: allSuccess,
            output: errors.length > 0 ? errors.join('\n') : undefined
        };
    }

    /**
     * Remove the closing marker from the end of a SEARCH or REPLACE text.
     *
     * Models often like to add a marker line after the new code –
     * `>>>`, `<<<END>>>`, `>>>>>>> REPLACE`, `=======`. These remain,
     * it lands right in the middle of the source code and breaks the file. (Exactly like
     * passiert: laguna schrieb `>>>` in tokenizer.js.)
     *
     * Only lines that consist EXCLUSIVELY of marker characters are
     * removes – Code like `if (a >>> b)` remains untouched.
     */
    private stripPatchTerminator(text: string): string {
        return text
            .replace(/\r?\n[ \t]*[<>=]{3,}[ \t]*(?:END|REPLACE|SEARCH)?[<>=]*[ \t]*\r?\n?[ \t]*$/i, '')
            .replace(/^[ \t]*[<>=]{3,}[ \t]*(?:END|REPLACE|SEARCH)?[<>=]*[ \t]*\r?\n?$/i, '')
            .trimEnd();
    }

    private async handleDeleteAction(content: string, confirm: ConfirmFn): Promise<ExecutedAction> {
        const pathMatch = content.match(/^path:\s*(.+)$/m);
        if (!pathMatch) throw new Error('No "path:" found');
        const ok = await this.fileManager.deleteFile(pathMatch[1].trim(), confirm);
        return {
            type: 'file_delete',
            description: `${ok ? 'Deleted' : 'Rejected'}: ${pathMatch[1].trim()}`,
            success: ok
        };
    }

    private async handleShellAction(command: string, confirm: ConfirmFn, onActionProgress?: ActionProgressCallback): Promise<ExecutedAction> {
        const config = vscode.workspace.getConfiguration('aiAssistant');
        if (!config.get<boolean>('allowShellCommands', true)) {
            return { type: 'shell', description: 'Shell disabled', success: false, output: 'Shell commands are switched off.' };
        }

        // The block can have a header `shell: powershell`. Without it,
        // the setting applies – for builds and tests, this is WSL.
        const { shellKind, command: rest } = AIEngine.parseShellBlock(command);
        const trimmed = rest.trim();

        // cat/head/tail: Intercept before the Confirm dialog and read directly
        let workDirEarly: string;
        try { workDirEarly = this.fileManager.getWorkspaceRoot(); } catch { workDirEarly = ''; }
        if (workDirEarly) {
            const intercepted = ShellRunner.interceptFileReadCommand(trimmed, workDirEarly, this.logger);
            if (intercepted) {
                this.logger.info(`File-read command intercepted (no WSL): ${trimmed}`);
                return {
                    type: 'shell',
                    description: `File read: ${trimmed}`,
                    success: intercepted.exitCode === 0,
                    output: intercepted.stdout || intercepted.stderr
                };
            }
        }

        // Which shell it WOULD be, and which one the user could switch to.
        //
        // The choice is offered with every command, not just asked once in the
        // settings: it depends on the command, not on a preference. `npm test`
        // belongs in WSL, `Get-Service` only works in PowerShell, and which of
        // the two a command needs is often clear to the user a moment before it
        // is clear to the model. Switching here costs one click; the detour
        // through "Etwas anderes" costs a whole round.
        const resolved = ShellRunner.resolveShell(shellKind, config);
        const usingPowerShell = resolved === 'powershell';
        const shellLabel = usingPowerShell ? 'PowerShell' : 'WSL';

        // The other shell is only worth offering where it exists and is allowed.
        const otherAvailable = process.platform === 'win32'
            && (usingPowerShell || config.get<boolean>('allowPowerShell', true));
        const switchLabel = usingPowerShell ? 'Run in WSL' : 'Run in PowerShell';

        const choices = otherAvailable
            ? ['Run', switchLabel, 'Something else', 'Reject']
            : ['Run', 'Something else', 'Reject'];

        const choice = await confirm(
            `Run shell command (${shellLabel}):\n\`${trimmed}\``,
            choices
        );

        let commandToRun = trimmed;
        // The user's choice beats both the block header and the setting.
        let effectiveKind: ShellKind = shellKind;
        if (choice === switchLabel) {
            effectiveKind = usingPowerShell ? 'wsl' : 'powershell';
            this.logger.info(`Shell: the user switches to ${effectiveKind} for: ${trimmed}`);
        }

        if (choice === 'Something else') {
            const userInstruction = await vscode.window.showInputBox({
                prompt: 'Enter an instruction for the AI',
                placeHolder: 'z.B. Nutze stattdessen npm ci',
                ignoreFocusOut: true
            });
            if (!userInstruction?.trim()) {
                return { type: 'shell', description: `Rejected: ${trimmed}`, success: false };
            }
            this.logger.info(`Shell: instruction from the user to the AI: ${userInstruction.trim()}`);
            // Return as a failed shell action → triggers repair loop with user context
            return {
                type: 'shell',
                description: `Rejected: ${trimmed}`,
                success: false,
                output: `Instruction from the user: ${userInstruction.trim()}\n\n(The proposed command \`${trimmed}\` was rejected.)`
            };
        } else if (choice !== 'Run' && choice !== switchLabel) {
            return { type: 'shell', description: `Rejected: ${trimmed}`, success: false };
        }

        let workDir: string;
        try { workDir = this.fileManager.getWorkspaceRoot(); }
        catch { return { type: 'shell', description: 'No workspace', success: false }; }

        // Report as "running" at startup, then overwrite with the result –
        // the same card, so you don't have to read the command twice.
        // The tool name shows the shell: otherwise you can't tell from the line whether
        // the command ran under WSL or in PowerShell – in case of errors, that's
        // the first question.
        // Named after the shell that ACTUALLY runs it - if the user switched,
        // the row has to say so, otherwise the log claims something untrue.
        const runShell = ShellRunner.resolveShell(effectiveKind, config);
        const toolName = runShell === 'powershell' ? 'PowerShell' : 'Bash';

        onActionProgress?.(`Shell: ${commandToRun}`, '', {
            tool: toolName, target: commandToRun, running: true
        });

        const result = await this.shellRunner.run(commandToRun, workDir, 120_000, confirm, effectiveKind);
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 4000);
        const ok = result.exitCode === 0;

        onActionProgress?.(`Shell: ${commandToRun}`, output || '(no output)', {
            tool: toolName,
            target: commandToRun,
            detail: ok ? undefined : `Exit ${result.exitCode}`,
            ok
        });

        return {
            type: 'shell',
            description: `Shell: ${commandToRun.slice(0, 60)}`,
            success: result.exitCode === 0,
            output: output || '(no output)'
        };
    }

    /**
     * Question to the user – and wait.
     *
     * The counterpart to Claude Code's question dialog: a question, 2–4 options with
     * Labeling and explanation, single or multiple selection, plus a
     * Free text field for "something else". The answer is passed as the output of the action
     * back into the model, i.e., into the next iteration of the loop.
     *
     * Important for the loop: the response is a SUCCESSFUL action with
     * Output. This triggers branch 3 of `planNextStep` and the model works
     * proceed with the decision instead of standing still.
     */
    private async handleAskUserAction(
        content: string,
        confirm: ConfirmFn,
        onActionProgress?: ActionProgressCallback
    ): Promise<ExecutedAction> {
        const request = AIEngine.parseAskBlock(content);
        if (!request.question || request.options.length === 0) {
            throw new Error('ask_user needs "question:" and at least one option');
        }

        this.logger.info(`Question to the user: ${request.question} `
            + `(${request.options.length} Optionen${request.multi ? ', Mehrfachauswahl' : ''})`);

        onActionProgress?.(`Question: ${request.question}`, '', {
            tool: 'Question', target: request.question, running: true
        });

        // Without dialog callback (headless, tests, sidebar) ask via the
        // confirmation card – every caller knows it.
        const answer = this.onAsk
            ? await this.onAsk(request)
            : await confirm(
                `${request.question}\n\n`
                + request.options.map(o => `- **${o.label}** – ${o.description}`).join('\n'),
                request.options.map(o => o.label)
            );

        const clean = (answer ?? '').trim();

        onActionProgress?.(`Question: ${request.question}`, clean || '(abgebrochen)', {
            tool: 'Question', target: request.question,
            detail: clean ? undefined : 'abgebrochen', ok: !!clean
        });

        if (!clean) {
            return {
                type: 'shell',
                description: `Question left unanswered: ${request.question.slice(0, 50)}`,
                success: false,
                output: 'The user did not answer. Do not ask again – decide yourself, '
                    + 'state your assumption in one sentence and carry on.'
            };
        }

        this.logger.info(`The user answered: ${clean}`);
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
     * Format – Header lines plus one option per line:
     *
     *     header: Bibliothek
     *     question: Welche Datumsbibliothek?
     *     multi: false
     *     options:
     *     date-fns — klein, modular, Standard in neuen Projekten
     * Luxon — built-in time zones, larger
     *
     * The em dash separates the label and the explanation; allowed are “—”,
     * "–", " - " and ":". If it is missing, the entire line is the label.
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

        // Options: everything after a line `options:` or `optionen:`,
        // otherwise every line that looks like a list item.
        const optionsStart = /^\s*(?:options|optionen):\s*$/im.exec(text);
        const body = optionsStart
            ? text.slice(optionsStart.index + optionsStart[0].length)
            : text;

        const known = /^\s*(?:question|frage|header|titel|multi|mehrfach|absicht|options|optionen)\s*:/i;
        const options: AskOption[] = [];
        for (const line of body.split('\n')) {
            // Only remove actual bullet points. A broader
            // pattern also strips the label: from "3 variants" it
            // would become "variants".
            const trimmed = line.replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, '').trim();
            if (!trimmed || known.test(line)) continue;
            // Separator between label and explanation. The hyphen
            // needs spacing on BOTH sides, otherwise it cuts
            // “date-fns” right in the middle of the name.
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
     * The block can be both – a pure command line (the usual case)
     * or a head-plus-body block with `---`. A command that randomly starts with
     * If it starts with "shell:", it is not checked as a header line: the two are checked
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

        // Skip the separator – even if no header preceded it:
        // some models habitually write it anyway.
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
     * Read-only analysis. Runs without confirmation because nothing is changed –
     * this allows the assistant to freely examine the code.
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
                // The path can be provided as "path: x" or as a bare first line
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

        // Compact display: tool name, target, additional info – separated so that
        // the surface can build a terminal line from it.
        const DISPLAY: Record<string, string> = {
            read_file: 'Read', grep: 'Grep', glob: 'Glob', list_dir: 'List'
        };
        // description has the form "read_file: src/a.ts (L1–115)"
        const parsed = /^[\w_]+:\s*(.+?)(?:\s*[(→]\s*(.+?)\)?)?$/.exec(result.description);
        onActionProgress?.(result.description, result.output.slice(0, 4000), {
            tool: DISPLAY[type] ?? type,
            target: parsed?.[1]?.trim(),
            detail: parsed?.[2]?.trim(),
            ok: !result.error
        });

        return {
            type: 'analysis',
            description: result.description,
            // „Keine Treffer" ist ein gültiges Ergebnis und zählt als Erfolg.
            // Konnte die Analyse gar nicht laufen – Datei fehlt, Pfad außerhalb
            // des Workspace –, ist es ein Fehlschlag und muss als solcher
            // zurückgemeldet werden.
            //
            // Vorher stand hier fest `success: true`. Im Fenster-Lauf schrieb
            // das Modell die Pfade mit führendem Schrägstrich, alle sieben
            // Lesevorgänge wurden abgelehnt – und die Schleife hielt das für
            // getane Arbeit. Es arbeitete eine ganze Runde blind.
            success: !result.error,
            output: result.output
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Planung: action:plan
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Take over the AI's work plan. Format per line:
     *   - [ ] offen   - [>] in Arbeit   - [x] erledigt
     */
    private handlePlanAction(content: string): ExecutedAction {
        const steps: PlanStep[] = [];
        for (const rawLine of content.split('\n')) {
            const line = rawLine.trim();
            if (!line) continue;
            // "- [x] Text", "* [ ] Text", "1. [>] Text" or simply "- Text"
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
            throw new Error('No valid plan entry found (expected: "- [ ] step")');
        }

        this.plan = steps;
        this.onPlanUpdate?.(this.getPlan());
        this.console.plan(steps);

        const done = steps.filter(s => s.status === 'done').length;
        this.logger.info(`Plan updated: ${done}/${steps.length} done`);

        const marks = { done: '[x]', doing: '[>]', todo: '[ ]' };
        return {
            type: 'plan',
            description: `Plan: ${done}/${steps.length} done`,
            success: true,
            output: steps.map(s => `${marks[s.status]} ${s.text}`).join('\n')
        };
    }

    /** action:done – the AI reports the task as completed. */
    private handleDoneAction(content: string): ExecutedAction {
        this.taskComplete = true;
        const summary = content.match(/^(?:zusammenfassung|summary):\s*([\s\S]+)$/mi);
        const text = (summary ? summary[1] : content).trim();
        this.logger.info('The AI reports the task as complete.');

        // The summary is the final answer, not a tool output.
        // As `output`, it ended up in a monospace box with four visible
        // lines – enumerations and highlights within it were only raw text.
        // `process()` therefore sends it as a message to the chat.
        this.lastDoneSummary = text;

        return {
            type: 'info',
            description: '✅ Task complete',
            success: true,
            output: text || undefined
        };
    }

    /**
     * Fetch the page and provide its text to the AI.
     *
     * Without this tool, the model only receives the title from a search and
     * Addresses – it cannot answer any questions with them. Only the page content
     * helps. That is why Claude Code also has a retrieval tool in addition to the search.
     */
    private async handleWebFetchAction(
        content: string,
        onActionProgress?: ActionProgressCallback
    ): Promise<ExecutedAction> {
        const urlMatch = content.match(/^url:\s*(\S+)$/m)
            ?? content.match(/(https?:\/\/\S+)/);
        if (!urlMatch) throw new Error('No URL found in the web_fetch block');
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
                description: `Page could not be fetched: ${url}`,
                success: false,
                output: `${msg}\n\nCheck the address, or use web_search to find another source.`
            };
        }
    }

    private async handleWebSearchAction(content: string, onActionProgress?: ActionProgressCallback): Promise<ExecutedAction> {
        const queryMatch = content.match(/^query:\s*(.+)$/m);
        if (!queryMatch) throw new Error('No "query:" found in the web_search block');
        const query = queryMatch[1].trim();

        onActionProgress?.(`Web search: ${query}`, '', { tool: 'Search', target: query, running: true });
        const searcher = WebSearcher.getInstance();
        const searchResult = await searcher.search(query, 5);
        const formatted = searcher.formatForAI(searchResult);

        onActionProgress?.(`Web search: ${query}`, formatted.slice(0, 4000), {
            tool: 'Search', target: query,
            detail: `${searchResult.results.length} Ergebnis(se)`, ok: true
        });
        this.logger.info(`web_search: "${query}" → ${searchResult.results.length} Ergebnis(se)`);

        return {
            type: 'web_search',
            description: `Web search: "${query}"`,
            success: searchResult.results.length > 0 || !!searchResult.abstract,
            output: formatted
        };
    }

    /**
     * Adds line numbers to file content (for AI context).
     * Format: "   1 | erste Zeile"
     * Truncates to the first N lines at maxLines.
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
            ? numbered + `\n... [${lines.length - maxLines} more lines cut]`
            : numbered;
    }

    /** Extrahiert den Inhalt des ersten <think>…</think>-Blocks (DeepSeek/Qwen). */
    private extractThinkingBlock(text: string): string | undefined {
        const match = text.match(/<think>([\s\S]*?)<\/think>/i);
        return match ? match[1].trim() : undefined;
    }

    /**
     * Build an AI-prompt-formatted reasoning summary.
     * Format: readable sentences that can be reused as context in future prompts.
     */
    private buildReasoningSummary(userPrompt: string, thinking: string | undefined, actions: ExecutedAction[]): string {
        const parts: string[] = [];

        // Starting from round 1, `userPrompt` is the loop's continuation prompt, not
        // the task. The task must be included in the summary.
        const task = this.currentTask || userPrompt;
        parts.push(`Task: "${task.slice(0, 200).replace(/\n/g, ' ')}"`);

        if (thinking) {
            // Shorten the thinking block to a maximum of 600 characters to control history size
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
            parts.push(`Actions taken: ${actionSummary}`);

            const failed = actions.filter(a => !a.success);
            if (failed.length > 0) {
                parts.push(`Fehlgeschlagen: ${failed.map(a => a.description).join('; ')}`);
            }
        } else {
            parts.push('No file or shell actions were carried out (an answer only).');
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
                'The answer ends inside the <think> block (cut off) – no actions were carried out. ' +
                'Raise aiAssistant.maxTokens.'
            );
            return text.slice(0, openIdx);
        }
        return text;
    }

    private stripActionBlocks(text: string): string {
        // Exactly the same normalization as in the parser: what is executed must
        // also disappear from the display. Otherwise the user reads
        // "action:done" or ">>>REPLACE" along with source code instead of an answer.
        return this.normalizeActionMarkup(text)
            .replace(/<think>[\s\S]*?<\/think>/gi, '')              // Reasoning-Blöcke
            .replace(/```action:\w+[^\n]*\n[\s\S]*?```\n?/g, '')    // Backtick-Blöcke
            .replace(/<action:\w+>[\s\S]*?<\/action:\w+>\n?/g, '')  // XML-Tags
            .replace(/\[action:\w+\][\s\S]*?\[\/action:\w+\]\n?/g, '') // Bracket-Tags
            // A block whose closing fence the model has completely forgotten:
            // discard from the header line to the end of the text. A truncated
            // action block is never a response in the chat.
            .replace(/```action:\w+[^\n]*\n[\s\S]*$/g, '')
            // Uebrige Patch-Marker: der Block war weg, die Marker standen noch da
            .replace(/^\s*(?:<<<SEARCH|>>>REPLACE|>>>>>>>\s*REPLACE|<<<<<<<\s*SEARCH)\s*$/gm, '')
            .trim();
    }

    /** Display text: Remove action blocks AND raw tool-call markup. */
    private cleanForDisplay(text: string): string {
        // The markup has already been executed as an action – it has no place
        // in the chat, otherwise the user would read XML instead of an answer.
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

            // The last session is returned as ONE background note, not
            // as replayed conversation rounds. Otherwise, the model would treat the old
            // task as the current one – see HistoryManager.getLastSessionDigest.
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
            this.logger.warn(`Could not initialise the HistoryManager: ${(err as Error).message}`);
        }
    }

    getHistoryManager(): HistoryManager | null {
        return this.historyManager;
    }

    /**
     * Detects whether the user wants to perform a web search.
     * Returns the raw prompt if search is detected, otherwise null.
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
     * Use the LLM to extract an optimized search term from the user prompt.
     * Example: "search the Internet for the Checkmk API" → "Checkmk REST API"
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

            // Hard stop at conjunctions — everything after is the task, not the search term
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
            // Truncate everything after "and" / "then"
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
