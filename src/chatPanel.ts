import * as vscode from 'vscode';
import {
    AIEngine, ExecutedAction, PlanStep, AssistantMode, ActionMeta, AskRequest, getAssistantMode
} from './aiEngine';
import { SettingsPanel } from './settingsPanel';
import { ActionHistory } from './actionHistory';
import { MCPClient, GenerationStats, StreamCallback } from './mcpClient';
import { FileManager } from './fileManager';
import { Logger } from './logger';
import { ConfirmFn, DiffMeta, AppliedChange } from './confirm';
import { parseCommand, parseBudget, LoopBudget, HELP_TEXT } from './commands';

interface WebviewMessage {
    type:
        | 'sendMessage'
        | 'confirmResponse'
        | 'openDiff'
        | 'undoLast'
        | 'undoAll'
        | 'resetConversation'
        | 'openSettings'
        | 'openLog'
        | 'testConnection'
        | 'cancelGeneration'
        | 'actionProgress'
        | 'inputEnabled'
        | 'setMode'
        | 'clearHistory'
        | 'decisionResponse';
    text?: string;
    requestId?: string;
    choice?: string;
    mode?: AssistantMode;
}

/**
 * ChatPanel – opens the AI chat as an editor tab (WebviewPanel).
 *
 * Each instance is its own session with its own conversation history.
 * Multiple tabs can be open at the same time.
 */
export class ChatPanel {
    public static readonly viewType = 'aiAssistant.chatPanel';

    // Alle aktiven Chat-Tabs: sessionId → ChatPanel
    private static panels = new Map<string, ChatPanel>();
    private static nextId = 1;

    /** Send mode change to all open tabs */
    static broadcastModeChange(mode: AssistantMode): void {
        for (const p of ChatPanel.panels.values()) {
            p.post({ type: 'modeChanged', mode });
        }
    }

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private readonly sessionId: string;
    private readonly aiEngine: AIEngine;
    private readonly actionHistory = ActionHistory.getInstance();
    private readonly logger = Logger.getInstance();
    private readonly fileManager = FileManager.getInstance();
    private pendingConfirmations = new Map<string, (choice: string) => void>();
    /** Diff data per requestId for the "Open in Editor" button */
    private pendingDiffs = new Map<string, DiffMeta>();
    /** Is a task currently running? Used for "new task interrupts". */
    private runningTask: Promise<void> | null = null;
    private disposables: vscode.Disposable[] = [];

    private constructor(
        extensionUri: vscode.Uri,
        sessionId: string,
        column: vscode.ViewColumn
    ) {
        this.extensionUri = extensionUri;
        this.sessionId = sessionId;
        this.aiEngine = AIEngine.getInstance();

        this.panel = vscode.window.createWebviewPanel(
            ChatPanel.viewType,
            `AI Chat #${sessionId}`,
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,   // Tab-Inhalt bleibt beim Wechseln
                localResourceRoots: [extensionUri]
            }
        );

        this.panel.webview.html = this.buildHtml(this.panel.webview);

        // Tab-Icon
        this.panel.iconPath = new vscode.ThemeIcon('robot');

        // Messages from the WebView
        this.panel.webview.onDidReceiveMessage(
            (msg: WebviewMessage) => this.handleMessage(msg),
            null,
            this.disposables
        );

        // Tab closed → clean up
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.postSystem(`AI Chat Session #${sessionId} bereit.`);

        // Scan the workspace and display the result in the chat
        try {
            const root = this.fileManager.getWorkspaceRoot();
            const files = this.fileManager.listFiles();
            this.postSystem(`📁 Workspace: ${root} — ${files.length} file(s) found`);
        } catch {
            this.postSystem('⚠ No workspace is open. Please open a folder.');
        }

        // A set goal extends beyond the session – therefore, it belongs in the
        // Open visibly, otherwise one wonders about the answers.
        const goal = this.aiEngine.getGoal();
        if (goal) this.post({ type: 'goalChanged', goal });

        // Immediately show the log channel (preserveFocus=true → focus remains in the editor)
        this.logger.show();

        // Bring the keyboard focus into the panel.
        // If the chat is opened via the command palette, VS Code returns the focus
        // to the previously active view (Explorer, other sidebar) afterwards –
        // you then type into empty space. reveal(preserveFocus=false) corrects this,
        // the input field itself focuses in the WebView script.
        // Delayed because logger.show() still rebuilds the panel layout.
        setTimeout(() => {
            if (ChatPanel.panels.has(this.sessionId)) {
                this.panel.reveal(column, false);
            }
        }, 150);
    }

    /**
     * Open a new chat tab or focus an existing one.
     * @param forceNew  true = immer neuen Tab erstellen
     */
    static open(extensionUri: vscode.Uri, forceNew = false): ChatPanel {
        // Reuse the last active tab if not forceNew
        if (!forceNew && ChatPanel.panels.size > 0) {
            const last = [...ChatPanel.panels.values()].at(-1)!;
            last.panel.reveal(vscode.ViewColumn.One, false);
            return last;
        }

        const sessionId = String(ChatPanel.nextId++);
        const column = vscode.window.activeTextEditor
            ? vscode.ViewColumn.Beside
            : vscode.ViewColumn.One;

        const instance = new ChatPanel(extensionUri, sessionId, column);
        ChatPanel.panels.set(sessionId, instance);
        return instance;
    }

    /** Alle aktiven Panels */
    static getAll(): ChatPanel[] {
        return [...ChatPanel.panels.values()];
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Nachrichten-Handler
    // ──────────────────────────────────────────────────────────────────────────

    private async handleMessage(msg: WebviewMessage): Promise<void> {
        switch (msg.type) {
            case 'sendMessage':
                if (msg.text?.trim()) {
                    const text = msg.text.trim();

                    // Commands like /goal and /loop do NOT go to the model –
                    // it would describe a loop instead of executing one.
                    if (await this.handleSlashCommand(text)) break;

                    // Is a task still running? Then the instruction
                    // is QUEUED, not interrupted: the current step
                    // is completed first, then it will be executed. An interruption
                    // in the middle of a step would leave half-finished work –
                    // a file modified, but tests not run. If you really
                    // want to stop immediately, use "Cancel".
                    if (this.runningTask) {
                        const n = this.aiEngine.queueUserInput(text);
                        this.post({ type: 'queuedMessage', text, count: n });
                        break;
                    }
                    await this.handleUserMessage(text);
                }
                break;

            case 'confirmResponse':
            // The decision dialog uses the same queue:
            // a response is a response, regardless of which card it comes from.
            case 'decisionResponse': {
                const handler = this.pendingConfirmations.get(msg.requestId ?? '');
                if (handler) {
                    this.pendingConfirmations.delete(msg.requestId!);
                    this.pendingDiffs.delete(msg.requestId!);
                    handler(msg.choice ?? '');
                }
                break;
            }

            case 'openDiff': {
                const diff = this.pendingDiffs.get(msg.requestId ?? '');
                if (diff) {
                    const label = require('path').basename(diff.oldUri);
                    await this.fileManager.openDiffEditor(diff.oldUri, diff.newContent, label);
                }
                break;
            }

            case 'undoLast':
                await this.actionHistory.undoLast();
                this.postSystem('↩ Last AI action undone.');
                break;

            case 'undoAll':
                await this.actionHistory.undoAll();
                this.postSystem('↩ All AI actions undone.');
                break;

            case 'resetConversation':
                this.aiEngine.resetConversation();
                for (const [, resolve] of this.pendingConfirmations) {
                    resolve('Reject');
                }
                this.pendingConfirmations.clear();
                this.pendingDiffs.clear();
                this.postSystem('Conversation reset.');
                break;

            case 'clearHistory': {
                // Deletes the persisted history – irreversible, therefore ask.
                const answer = await vscode.window.showWarningMessage(
                    'Delete the entire chat history?\n'
                    + 'Every saved session in ai-code-assistant.json will be removed. '
                    + 'Code changes that were already applied stay as they are.',
                    { modal: true },
                    'Clear history',
                    'Cancel'
                );
                if (answer !== 'Clear history') break;

                const removed = this.aiEngine.clearHistory();
                this.pendingConfirmations.clear();
                this.pendingDiffs.clear();
                this.post({ type: 'clearChat' });
                this.postSystem(`🗑 History cleared (${removed} session(s)). A new session has started.`);
                break;
            }

            case 'openSettings':
                SettingsPanel.open(this.extensionUri);
                break;

            case 'setMode': {
                const mode = msg.mode === 'auto' || msg.mode === 'plan' ? msg.mode : 'ask';
                await vscode.commands.executeCommand('aiAssistant.setMode', mode);
                break;
            }

            case 'openLog':
                this.logger.show();
                break;

            case 'testConnection':
                await this.runConnectionTest();
                break;

            case 'cancelGeneration':
                this.aiEngine.cancel();
                this.post({ type: 'thinking', value: false });
                this.post({ type: 'assistantMessageEnd' });
                this.postSystem('⏹ Generierung abgebrochen.');
                break;
        }
    }

    private async handleUserMessage(userText: string): Promise<void> {
        // Record the run so that a new task can wait for it
        const task = this.runUserMessage(userText);
        this.runningTask = task;
        try {
            await task;
        } finally {
            if (this.runningTask === task) this.runningTask = null;
        }
    }

    private async runUserMessage(userText: string): Promise<void> {
        this.post({ type: 'userMessage', text: userText });
        this.post({ type: 'thinking', value: true });

        const confirmFn = this.buildConfirmFn();
        this.bindEngineCallbacks();

        try {
            const stream = this.buildStreamFn();

            const result = await this.aiEngine.process(
                userText,
                stream.onToken,
                confirmFn,
                this.onIterationFn(),
                0,
                this.onActionProgressFn()
            );

            if (!stream.started()) {
                if (result.text) {
                    this.post({ type: 'assistantMessage', text: result.text });
                }
            }

            if (result.actions.length > 0) {
                const title = result.iterations > 1
                    ? `Actions taken (${result.iterations} steps)`
                    : 'Actions taken';
                this.post({ type: 'actions', actions: this.summarizeActions(result.actions), title });
            }

            if (result.contextWarning) {
                this.post({ type: 'contextWarning', text: result.contextWarning });
            }

            // Always ensure at the end that Thinking is off and Input is active
            this.post({ type: 'thinking', value: false });
            this.post({ type: 'inputEnabled', value: true });

        } catch (err) {
            this.post({ type: 'thinking', value: false });
            this.post({ type: 'inputEnabled', value: true });
            const msg = err instanceof Error ? err.message : String(err);
            this.post({ type: 'errorMessage', text: msg });
            this.logger.error('The AI request failed', err);
        }
    }

    /**
     * Aktions-Ausgaben für die Übersichtskarte kürzen.
     *
     * Analyse-Aktionen liefern ganze Dateien bzw. hunderte grep-Treffer – die
     * wurden während des Laufs schon als Fortschritt angezeigt. In der Bilanz
     * am Ende zählt nur, WAS gemacht wurde, nicht der komplette Inhalt.
     */
    private summarizeActions(actions: ExecutedAction[]): ExecutedAction[] {
        const LIMIT = 600;
        return actions.map(a => {
            if (a.type === 'analysis') {
                return { ...a, output: undefined };
            }
            if (a.output && a.output.length > LIMIT) {
                return {
                    ...a,
                    output: `${a.output.slice(0, LIMIT)}\n… [${a.output.length - LIMIT} characters cut – in full in the log]`
                };
            }
            return a;
        });
    }

    private async runConnectionTest(): Promise<void> {
        this.postSystem('Testing the connection...');
        const { success, info } = await MCPClient.getInstance().testConnection();
        const url = vscode.workspace.getConfiguration('aiAssistant')
            .get<string>('serverUrl', 'http://localhost:8080');
        this.postSystem(`${success ? '✅' : '❌'} llama.cpp (${url}): ${info}`);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // In-Chat Confirmation
    // ──────────────────────────────────────────────────────────────────────────

    private requestConfirmation(message: string, choices: string[], diff?: DiffMeta): Promise<string> {
        const requestId = `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        return new Promise<string>((resolve) => {
            this.pendingConfirmations.set(requestId, resolve);
            if (diff) {
                this.pendingDiffs.set(requestId, diff);
            }
            this.post({
                type: 'confirmRequest',
                requestId,
                message,
                choices,
                diffText: diff?.diffText ?? null,
                hasDiff: !!diff,
                stats: diff?.stats ?? null
            });
        });
    }

    buildConfirmFn(): ConfirmFn {
        return (message, choices, diff) =>
            this.requestConfirmation(message, choices, diff);
    }

    /**
     * The token stream into the chat – for a single run AND for the loop.
     *
     * The loop used to pass an empty callback, on the reasoning that the round's
     * text arrives as the announcement afterwards anyway. What that looked like
     * in the window: "Writing the answer… 1.6k Tok" for two minutes and not one
     * character in the chat. A reasoning model spends most of its output on
     * thinking, which reaches the panel as a `<think>` block and is rendered as a
     * collapsed "🧠 Reasoning" section – so there IS something to show, and in the
     * loop it is needed most: the rounds are long and nothing else moves.
     */
    /**
     * The round announcement – and the thinking indicator around it.
     *
     * Both halves matter. The loop path used to post the announcement alone, so
     * after the first iteration the "KI denkt…" bar was gone and never came
     * back: the assistant worked for minutes and the panel looked idle. Whoever
     * writes a line into the chat also has to say that work continues.
     */
    private onIterationFn() {
        return (iteration: number, reason: string) => {
            this.post({ type: 'thinking', value: false });
            this.post({ type: 'iterationMessage', iteration, reason });
            this.post({ type: 'thinking', value: true });
        };
    }

    /**
     * An action with its output in the chat. `meta` carries the tool name, the
     * target and the state – without it the row shows only "Aktion" and the
     * whole description as the target.
     */
    private onActionProgressFn() {
        return (description: string, output: string, meta?: ActionMeta) => {
            this.post({ type: 'thinking', value: false });
            this.post({ type: 'actionProgress', description, output, meta });
            this.post({ type: 'thinking', value: true });
        };
    }

    private buildStreamFn(): { onToken: StreamCallback; started: () => boolean } {
        let started = false;
        return {
            started: () => started,
            onToken: (token: string, done: boolean) => {
                if (!started) {
                    started = true;
                    this.post({ type: 'thinking', value: false });
                    this.post({ type: 'assistantMessageStart' });
                }
                if (!done) {
                    this.post({ type: 'assistantToken', text: token });
                } else {
                    this.post({ type: 'assistantMessageEnd' });
                }
            }
        };
    }

    /**
     * Point every one of the engine's feedback paths at THIS panel.
     *
     * In one place, because otherwise it goes wrong exactly the way it did go
     * wrong: the `/loop` path set only two of the callbacks, and inside the loop
     * the token statistics were missing – the user saw "KI denkt…" for minutes
     * without a single number. Every path that starts the engine calls this.
     *
     * Still per run and not in the constructor: with several chat tabs open they
     * all share the same engine instance. Whoever is running owns the callbacks
     * – otherwise the output lands in the wrong tab.
     */
    private bindEngineCallbacks(): void {
        // The plan as a live checklist in the chat
        this.aiEngine.setPlanCallback((steps: PlanStep[]) => {
            this.post({ type: 'plan', steps });
        });

        // Jede angewandte Änderung als farbiger Diff. Im Auto-Modus ist das der
        // EINZIGE Weg, Änderungen zu sehen – eine Bestätigungskarte gibt es dort
        // nicht.
        this.fileManager.setDiffReporter((change: AppliedChange) => {
            this.post({ type: 'fileDiff', change });
        });

        // Laufende Kennzahlen: Fortschritt der Prompt-Auswertung und Token/s.
        // Bei großem Kontext dauert allein die Eingabe-Auswertung Minuten – ohne
        // diese Anzeige sieht der Benutzer nur „KI denkt…" und weiß nicht, ob
        // überhaupt etwas passiert.
        this.aiEngine.setStatsCallback((stats: GenerationStats) => {
            this.post({ type: 'stats', stats });
        });

        // Ansage jeder Runde im Chat. process() gibt nur den Text der ersten
        // Runde zurück – ohne diesen Weg stand ab Schritt 2 nur „nächster
        // Schritt…" da, ohne zu sagen, was der Assistent vorhat.
        this.aiEngine.setNarrationCallback((text: string) => {
            this.post({ type: 'narration', text });
        });

        // Entscheidungsfrage als Karte im Chat.
        this.aiEngine.setAskCallback((request: AskRequest) => this.requestDecision(request));
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Slash-Befehle
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * `/goal`, `/loop` und `/help` behandeln.
     *
     * @returns true, wenn es ein Befehl war und die Nachricht damit erledigt ist
     */
    private async handleSlashCommand(text: string): Promise<boolean> {
        const cmd = parseCommand(text);
        if (!cmd) return false;

        this.post({ type: 'userMessage', text });

        if (cmd.name === 'help') {
            this.post({ type: 'assistantMessage', text: HELP_TEXT });
            return true;
        }

        if (cmd.name === 'goal') {
            if (!cmd.rest) {
                const goal = this.aiEngine.getGoal();
                this.post({
                    type: 'assistantMessage',
                    text: goal
                        ? `**Current goal**\n\n${goal}`
                        : 'No goal is set. `/goal <text>` sets one.'
                });
                return true;
            }
            if (/^(l[öo]schen|clear|weg|none|aus)$/i.test(cmd.rest)) {
                this.aiEngine.setGoal('');
                this.post({ type: 'goalChanged', goal: '' });
                this.post({ type: 'assistantMessage', text: 'Goal cleared.' });
                return true;
            }
            this.aiEngine.setGoal(cmd.rest);
            this.post({ type: 'goalChanged', goal: cmd.rest });
            this.post({
                type: 'assistantMessage',
                text: `**Goal set**\n\n${cmd.rest}\n\n`
                    + 'From now on it goes into every request and outlives the session. '
                    + 'With `/loop <budget>` I work towards it repeatedly.'
            });
            return true;
        }

        // ── /loop ────────────────────────────────────────────────────────────
        const { budget, task } = parseBudget(cmd.rest);
        const goal = this.aiEngine.getGoal();

        if (!task && !goal) {
            this.post({
                type: 'assistantMessage',
                text: 'For `/loop` I need a goal or a task.\n\n'
                    + 'Either set `/goal <text>`, or go straight to '
                    + '`/loop 15m <what needs doing>`.'
            });
            return true;
        }

        // A running loop is not duplicated – the new statement
        // is inserted.
        if (this.runningTask) {
            const n = this.aiEngine.queueUserInput(text);
            this.post({ type: 'queuedMessage', text, count: n });
            return true;
        }

        this.runningTask = this.runLoopTask(task || goal, budget);
        try { await this.runningTask; } finally { this.runningTask = null; }
        return true;
    }

    /** Drive the loop and show the progress in the chat. */
    private async runLoopTask(task: string, budget: LoopBudget): Promise<void> {
        const goal = this.aiEngine.getGoal();
        this.post({
            type: 'assistantMessage',
            text: `**Loop started** – budget ${budget.label}, at most `
                + `${budget.rounds} round(s).\n\n`
                + (goal ? `Goal: ${goal}\n\n` : '')
                + `Task: ${task}\n\n`
                + 'It ends when the goal is reached, the budget is spent '
                + 'or you click **Cancel**. You can type at any time – '
                + 'the instruction comes up after the current step.'
        });
        this.post({ type: 'thinking', value: true });

        // Every feedback path, not just two – see bindEngineCallbacks.
        this.bindEngineCallbacks();

        try {
            const result = await this.aiEngine.runLoop(
                task,
                budget,
                this.buildStreamFn().onToken,
                this.buildConfirmFn(),
                this.onIterationFn(),
                this.onActionProgressFn(),
                (round: number, total: number, note: string) => {
                    this.post({ type: 'loopRound', round, total, note });
                }
            );

            this.post({
                type: 'assistantMessage',
                text: `**Loop finished** – ${result.rounds} round(s), `
                    + `${result.actions} action(s). Reason: ${result.stopped}.`
            });

            // What happened across the rounds, in one piece. The rows from
            // during the run are far above once the loop has taken eight rounds.
            if (result.log.length > 0) {
                this.post({
                    type: 'actions',
                    actions: this.summarizeActions(result.log),
                    title: `Actions taken (${result.rounds} `
                        + `${result.rounds === 1 ? 'round' : 'rounds'})`
                });
            }
        } catch (err) {
            this.post({
                type: 'errorMessage',
                text: `Loop aborted: ${(err as Error).message}`
            });
        } finally {
            this.post({ type: 'thinking', value: false });
            this.post({ type: 'inputEnabled', value: true });
        }
    }

    /**
     * Pose the decision question as a card in the chat and wait for the answer.
     *
     * Uses the same queue as the confirmation; only the card in
     * Webview is a different (radio or checkbox options with explanation and
     * a free-text field). The answer is the label of the selection, at
     * Multiple selection connected with `", "` – this is how Claude Code also handles it.
     */
    private requestDecision(request: AskRequest): Promise<string> {
        const requestId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        return new Promise<string>((resolve) => {
            this.pendingConfirmations.set(requestId, resolve);
            this.post({
                type: 'decisionRequest',
                requestId,
                header: request.header,
                question: request.question,
                options: request.options,
                multi: request.multi
            });
        });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Helpers
    // ──────────────────────────────────────────────────────────────────────────

    private post(data: Record<string, unknown>): void {
        this.panel.webview.postMessage(data);
    }

    private postSystem(text: string): void {
        this.post({ type: 'systemMessage', text });
    }

    private dispose(): void {
        ChatPanel.panels.delete(this.sessionId);
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }

    // ──────────────────────────────────────────────────────────────────────────
    // HTML (Editor tab optimized: full width, no sidebar frame)
    // ──────────────────────────────────────────────────────────────────────────

    private buildHtml(webview: vscode.Webview): string {
        const nonce = Array.from({ length: 16 }, () => Math.random().toString(36)[2]).join('');
        const csp = [
            `default-src 'none'`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`
        ].join('; ');

        return /* html */`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Chat #${this.sessionId}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:         var(--vscode-editor-background,           #1e1e1e);
      --bg-msg:     var(--vscode-editorWidget-background,     #252526);
      --bg-user:    var(--vscode-button-background,           #0e639c);
      --fg:         var(--vscode-editor-foreground,           #d4d4d4);
      --fg-muted:   var(--vscode-descriptionForeground,       #888);
      --accent:     var(--vscode-button-background,           #0e639c);
      --accent-fg:  var(--vscode-button-foreground,           #fff);
      --border:     var(--vscode-widget-border,               #454545);
      --code-bg:    var(--vscode-textCodeBlock-background,    #1a1a2e);
      --warn-bg:    rgba(255,180,0,.10);
      --warn-brd:   rgba(255,180,0,.45);
      --radius: 8px;
      --font:       var(--vscode-font-family,        'Segoe UI', sans-serif);
      --font-mono:  var(--vscode-editor-font-family, 'Courier New', monospace);
      --font-size:  var(--vscode-font-size,          13px);
    }
    body {
      font-family: var(--font);
      font-size: var(--font-size);
      color: var(--fg);
      background: var(--bg);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* ── Toolbar ── */
    #toolbar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 12px;
      background: var(--bg-msg);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .tb-btn {
      background: transparent;
      color: var(--fg-muted);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 4px 10px;
      font-size: 12px;
      cursor: pointer;
      transition: color .15s, border-color .15s;
      white-space: nowrap;
      font-family: var(--font);
    }
    .tb-btn:hover           { color: var(--fg);  border-color: var(--accent); }
    .tb-btn.danger:hover    { color: #f77;        border-color: #f77; }
    .tb-spacer { flex: 1; }
    /* ── Modus-Listbox ── */
    #mode-label {
      font-size: 11px;
      color: var(--fg-muted);
      margin-right: 2px;
    }
    #mode-select {
      font-family: var(--font);
      font-size: 11px;
      font-weight: 600;
      padding: 3px 6px;
      border-radius: 4px;
      cursor: pointer;
      background: var(--vscode-dropdown-background, #3c3c3c);
      color: var(--vscode-dropdown-foreground, #ccc);
      border: 1px solid var(--vscode-dropdown-border, var(--border));
      max-width: 230px;
    }
    #mode-select:focus { outline: 1px solid var(--accent); }
    /* The active mode should be recognizable at a glance */
    #mode-select.mode-auto { color: #fc0; border-color: rgba(255,180,0,.55); }
    #mode-select.mode-ask  { color: #8bf; border-color: rgba(100,180,255,.45); }
    #mode-select.mode-plan { color: #b39dff; border-color: rgba(150,120,255,.55); }
    #session-label {
      font-size: 11px;
      color: var(--fg-muted);
      padding: 0 8px;
      opacity: 0.6;
    }

    /* ── Pending-Banner ── */
    #pending-banner {
      display: none;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      background: var(--warn-bg);
      border-bottom: 1px solid var(--warn-brd);
      font-size: 11px;
      color: var(--fg-muted);
      flex-shrink: 0;
    }
    #pending-banner.visible { display: flex; }

    /* ── Chat ── */
    #chat {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      scroll-behavior: smooth;
    }
    #chat::-webkit-scrollbar { width: 6px; }
    #chat::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

    .msg-user {
      background: var(--bg-user);
      color: var(--accent-fg);
      border-radius: var(--radius) var(--radius) 2px var(--radius);
      padding: 10px 14px;
      align-self: flex-end;
      max-width: 75%;
      word-break: break-word;
      line-height: 1.5;
    }
    .msg-assistant {
      background: var(--bg-msg);
      border: 1px solid var(--border);
      border-radius: 2px var(--radius) var(--radius) var(--radius);
      padding: 10px 14px;
      max-width: 85%;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.6;
    }
    .msg-system {
      color: var(--fg-muted);
      font-size: 11px;
      font-style: italic;
      text-align: center;
      padding: 2px 0;
    }
    .msg-error {
      background: rgba(255,60,60,.10);
      border: 1px solid rgba(255,60,60,.4);
      border-radius: var(--radius);
      padding: 10px 14px;
      color: #f99;
    }
    .msg-warning {
      background: rgba(255,180,0,.10);
      border: 1px solid rgba(255,180,0,.4);
      border-radius: var(--radius);
      padding: 10px 14px;
      color: #fc0;
      font-size: 12px;
    }
    /* ── Toolbar: one line per operation, output below ── */
    .tool-row {
      border-left: 2px solid var(--border);
      padding: 2px 0 2px 10px;
      margin: 1px 0;
      font-size: 12px;
    }
    .tool-running { border-left-color: #d9a13b; }
    .tool-ok      { border-left-color: #5aa85a; }
    .tool-fail    { border-left-color: #d05a5a; }

    .tool-head {
      display: flex;
      align-items: baseline;
      gap: 8px;
      line-height: 1.5;
    }
    .tool-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
      align-self: center;
      background: var(--fg-muted);
    }
    .tool-running .tool-dot { background: #d9a13b; }
    .tool-ok      .tool-dot { background: #5aa85a; }
    .tool-fail    .tool-dot { background: #d05a5a; }

    .tool-name {
      font-weight: 600;
      color: var(--fg);
      flex-shrink: 0;
    }
    .tool-target {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--fg-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .tool-detail {
      margin-left: auto;
      font-size: 10px;
      color: var(--fg-muted);
      flex-shrink: 0;
      opacity: .8;
    }
    .tool-output { margin: 3px 0 4px 14px; }
    pre.tool-out {
      margin: 0;
      font-family: var(--font-mono);
      font-size: 11px;
      line-height: 1.45;
      color: var(--fg-muted);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 320px;
      overflow-y: auto;
    }
    .tool-more {
      background: none;
      border: none;
      padding: 2px 0 0;
      margin: 0;
      font-family: var(--font);
      font-size: 10px;
      color: var(--fg-muted);
      cursor: pointer;
    }
    .tool-more:hover { color: var(--fg); }

    .msg-progress {
      background: rgba(80,180,80,.08);
      border: 1px solid rgba(80,180,80,.25);
      border-radius: var(--radius);
      padding: 8px 14px;
      font-size: 12px;
      color: var(--fg);
    }
    .msg-progress-title {
      font-weight: 600;
      margin-bottom: 4px;
      color: #6dbf6d;
    }
    .msg-progress-output {
      font-family: var(--font-mono, monospace);
      white-space: pre-wrap;
      font-size: 11px;
      color: var(--fg-muted);
      max-height: 200px;
      overflow-y: auto;
    }
    .msg-iteration {
      background: rgba(100,150,255,.08);
      border: 1px solid rgba(100,150,255,.25);
      border-radius: var(--radius);
      padding: 8px 14px;
      color: #88aaff;
      font-size: 12px;
      font-style: italic;
    }

    /* ── Markdown in the response text ── */
    .msg-assistant p { margin: 0 0 8px; line-height: 1.55; }
    .msg-assistant p:last-child { margin-bottom: 0; }
    .msg-assistant ul, .msg-assistant ol {
      margin: 4px 0 10px;
      padding-left: 22px;
      line-height: 1.55;
    }
    .msg-assistant li { margin: 2px 0; }
    .msg-assistant li::marker { color: var(--fg-muted); }
    .msg-assistant .md-h {
      margin: 12px 0 6px;
      font-weight: 600;
      line-height: 1.3;
    }
    .msg-assistant h3.md-h { font-size: 1.15em; }
    .msg-assistant h4.md-h { font-size: 1.05em; }
    .msg-assistant h5.md-h,
    .msg-assistant h6.md-h { font-size: 1em; color: var(--fg-muted); }
    .msg-assistant blockquote {
      margin: 6px 0;
      padding: 2px 0 2px 10px;
      border-left: 3px solid var(--border);
      color: var(--fg-muted);
    }
    .msg-assistant hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 10px 0;
    }
    .msg-assistant pre {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 9px 11px;
      margin: 6px 0 10px;
      overflow-x: auto;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.45;
      position: relative;
    }
    /* Language specification of the code block as a small mark in the upper right corner */
    .msg-assistant pre[data-lang]::before {
      content: attr(data-lang);
      position: absolute;
      top: 2px; right: 7px;
      font-size: 9px;
      letter-spacing: .06em;
      text-transform: uppercase;
      color: var(--fg-muted);
      opacity: .7;
    }
    .msg-assistant pre code {
      background: none;
      padding: 0;
      white-space: pre;
    }
    .msg-assistant .md-table {
      border-collapse: collapse;
      margin: 6px 0 10px;
      font-size: 12px;
      display: block;
      overflow-x: auto;
      max-width: 100%;
    }
    .msg-assistant .md-table td {
      border: 1px solid var(--border);
      padding: 4px 9px;
      vertical-align: top;
    }
    /* Erste Zeile als Kopfzeile lesen */
    .msg-assistant .md-table tr:first-child td {
      font-weight: 600;
      background: rgba(255,255,255,.04);
    }
    .msg-assistant a { color: var(--vscode-textLink-foreground, #4daafc); }

    /* ── Metrics below the input ──
       Bewusst NICHT in der Denk-Leiste: die wird zwischen den Schritten der
       Agenten-Schleife aus- und wieder eingeschaltet, die Zahlen wären dann
constantly away. Here they remain standing over the entire task. */
    #input-footer {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 5px;
    }
    #stats-bar {
      display: none;
      align-items: center;
      gap: 8px;
      margin-left: auto;
      font-size: 10px;
      color: var(--fg-muted);
      font-family: var(--font-mono);
      white-space: nowrap;
    }
    #stats-bar.visible { display: inline-flex; }
    #stats-progress {
      display: none;
      width: 90px;
      height: 4px;
      background: rgba(255,255,255,.12);
      border-radius: 2px;
      overflow: hidden;
    }
    #stats-progress.visible { display: inline-block; }
    #stats-progress-fill {
      display: block;
      height: 100%;
      width: 0%;
      background: var(--accent);
      transition: width .2s linear;
    }

    /* ── Applied change with diff ── */
    .diff-card {
      background: var(--bg-msg);
      border: 1px solid var(--border);
      border-left: 3px solid #6dbf6d;
      border-radius: var(--radius);
      padding: 8px 12px;
      font-size: 12px;
    }
    .diff-card.diff-deleted { border-left-color: #f77; }
    .diff-card.diff-created { border-left-color: #8bf; }
    .diff-card-head {
      font-weight: 600;
      font-family: var(--font-mono);
      color: var(--fg);
      margin-bottom: 6px;
    }
    .diff-card summary {
      cursor: pointer;
      color: var(--fg-muted);
      font-size: 11px;
      margin-bottom: 4px;
      user-select: none;
    }
    .diff-card summary:hover { color: var(--fg); }

    /* ── Arbeitsplan ── */
    .plan-panel {
      background: rgba(150,120,255,.08);
      border: 1px solid rgba(150,120,255,.30);
      border-radius: var(--radius);
      padding: 10px 14px 12px;
      font-size: 12px;
    }
    .plan-head {
      font-weight: 600;
      color: #b39dff;
      margin-bottom: 8px;
      letter-spacing: .02em;
    }
    .plan-bar {
      height: 4px;
      background: rgba(255,255,255,.10);
      border-radius: 2px;
      overflow: hidden;
      margin-bottom: 10px;
    }
    .plan-bar-fill {
      height: 100%;
      background: #8b7ae0;
      transition: width .3s ease;
    }
    .plan-step {
      display: flex;
      gap: 8px;
      align-items: baseline;
      padding: 2px 0;
      line-height: 1.5;
    }
    .plan-icon { flex-shrink: 0; }
    .plan-done  { color: var(--fg-muted); text-decoration: line-through; }
    .plan-doing { color: #fc0; font-weight: 600; }
    .plan-todo  { color: var(--fg); }
    .msg-assistant code {
      font-family: var(--font-mono);
      font-size: 12px;
      background: var(--code-bg);
      padding: 1px 5px;
      border-radius: 3px;
    }
    .msg-assistant pre {
      background: var(--code-bg);
      border-radius: 6px;
      padding: 12px 14px;
      overflow-x: auto;
      margin: 8px 0;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.5;
    }
    .msg-assistant pre code { background: none; padding: 0; }

    /* ── Confirmation Card ── */
    .confirm-card {
      border-radius: var(--radius);
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      border: 1px solid var(--warn-brd);
      background: var(--warn-bg);
      max-width: 85%;
    }
    .confirm-card.resolved {
      opacity: 0.5;
      border-color: var(--border);
      background: transparent;
    }
    .confirm-msg { font-size: 13px; line-height: 1.5; word-break: break-word; }
    .confirm-msg strong { color: var(--fg); }

    /* ── Farbiger Diff ── */
    .diff-view {
      font-family: var(--font-mono);
      font-size: 11px;
      border-radius: 5px;
      overflow: hidden;
      max-height: 260px;
      overflow-y: auto;
      border: 1px solid var(--border);
    }
    .diff-view::-webkit-scrollbar { width: 4px; }
    .diff-view::-webkit-scrollbar-thumb { background: var(--border); }
    .diff-line {
      display: flex;
      align-items: stretch;
      line-height: 1.45;
      white-space: pre;
    }
    .diff-line:hover { filter: brightness(1.1); }
    .diff-line.add    { background: rgba(70, 185, 80, .15); color: #8dcc8d; }
    .diff-line.remove { background: rgba(220, 60, 60,  .15); color: #e08080; }
    .diff-line.hunk   { background: rgba(100,150,255, .10); color: #88aaff; font-style: italic; }
    .diff-line.ctx    { color: var(--fg-muted); }
    .diff-gutter {
      width: 22px;
      min-width: 22px;
      text-align: center;
      font-size: 10px;
      padding: 0 2px;
      user-select: none;
      flex-shrink: 0;
      border-right: 1px solid var(--border);
    }
    .diff-line.add    .diff-gutter { background: rgba(70, 185, 80, .25); color: #6b6; }
    .diff-line.remove .diff-gutter { background: rgba(220, 60, 60,  .25); color: #c66; }
    .diff-line.hunk   .diff-gutter { background: rgba(100,150,255, .15); }
    .diff-text { padding: 0 6px; overflow: hidden; text-overflow: ellipsis; white-space: pre; }
    .diff-footer {
      font-size: 10px;
      color: var(--fg-muted);
      padding: 4px 8px;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--bg-msg);
    }
    .diff-open-btn {
      font-size: 10px;
      color: var(--accent);
      background: none;
      border: none;
      cursor: pointer;
      padding: 0;
      font-family: var(--font);
      text-decoration: underline;
    }
    .diff-open-btn:hover { opacity: .8; }

    .confirm-buttons { display: flex; flex-wrap: wrap; gap: 8px; }
    .confirm-card.resolved .confirm-buttons { display: none; }
    .confirm-btn {
      border: none;
      border-radius: 5px;
      padding: 6px 16px;
      font-size: 12px;
      cursor: pointer;
      font-family: var(--font);
      transition: opacity .15s;
    }
    .confirm-btn:hover    { opacity: .85; }
    .confirm-btn:disabled { opacity: .4; cursor: default; }
    .confirm-btn.primary   { background: var(--accent); color: var(--accent-fg); }
    .confirm-btn.secondary { background: var(--bg-msg); color: var(--fg); border: 1px solid var(--border); }
    .resolved-label { font-size: 11px; color: var(--fg-muted); font-style: italic; display: none; }
    .confirm-card.resolved .resolved-label { display: block; }

    /* ── Reasoning-Block (eingeklappt) ── */
    .think-block {
      border: 1px solid rgba(150,150,150,.2);
      border-radius: 5px;
      margin: 4px 0;
      background: rgba(0,0,0,.15);
      max-width: 85%;
    }
    .think-block summary {
      padding: 4px 10px;
      cursor: pointer;
      color: var(--fg-muted);
      font-size: 11px;
      user-select: none;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .think-block summary::-webkit-details-marker { display: none; }
    .think-toggle { font-size: 9px; transition: transform .15s; display: inline-block; }
    .think-meta { font-size: 10px; opacity: .65; }
    details.think-block[open] .think-toggle { transform: rotate(90deg); }
    .think-content {
      padding: 8px 12px;
      font-size: 11px;
      color: var(--fg-muted);
      border-top: 1px solid rgba(150,150,150,.15);
      white-space: pre-wrap;
      font-family: var(--font-mono);
      line-height: 1.5;
      max-height: 400px;
      overflow-y: auto;
    }

    /* ── Aktionen-Panel ── */
    .actions-panel {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 10px 14px;
      font-size: 12px;
      max-width: 85%;
    }
    .actions-panel h4 {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .05em;
      color: var(--fg-muted);
      margin-bottom: 8px;
    }
    /* Target bar: always visible as long as a target is set. A target that
       man nicht sieht, vergisst man - und wundert sich dann ueber die
       Antworten. */
    #goal-bar {
      display: none;
      padding: 6px 14px;
      font-size: 11px;
      color: var(--accent, #4a9eff);
      border-bottom: 1px solid var(--border);
      background: var(--code-bg);
    }
    #goal-bar.visible { display: block; }

    /* Enqueued instruction: like a user message, but fainter. */
    .msg-queued { opacity: .65; }
    .queued-note {
      margin-top: 4px;
      font-size: 10px;
      opacity: .85;
    }
    .msg-loop {
      color: var(--accent, #4a9eff);
      font-weight: 500;
    }

    /* ── Entscheidungs-Karte ──────────────────────────────────────────────
       Nachgebaut nach dem Frage-Dialog im Claude-Code-Plugin. Sie soll
stand out: the assistant waits for the user at this point. */
    .decision-card {
      background: var(--card-bg, rgba(127,127,127,.06));
      border: 1px solid var(--accent, #4a9eff);
      border-radius: var(--radius);
      padding: 14px 16px;
      max-width: 85%;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .decision-card.decision-done { border-color: var(--border); opacity: .85; }
    .decision-header {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .08em;
      color: var(--accent, #4a9eff);
      font-weight: 600;
    }
    .decision-question { font-size: 14px; line-height: 1.45; }
    .decision-options { display: flex; flex-direction: column; gap: 6px; }
    .decision-option {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      cursor: pointer;
      background: var(--code-bg);
    }
    .decision-option:hover,
    .decision-option:focus { border-color: var(--accent, #4a9eff); outline: none; }
    .decision-option.decision-checked { border-color: var(--accent, #4a9eff); }
    .decision-option.decision-locked { cursor: default; opacity: .6; }
    .decision-radio, .decision-box {
      width: 14px; height: 14px; margin-top: 2px; flex: 0 0 14px;
      border: 1px solid var(--fg-muted);
    }
    .decision-radio { border-radius: 50%; }
    .decision-box { border-radius: 3px; }
    .decision-checked .decision-radio,
    .decision-checked .decision-box {
      border-color: var(--accent, #4a9eff);
      background: var(--accent, #4a9eff);
      box-shadow: inset 0 0 0 2px var(--code-bg);
    }
    .decision-body { display: flex; flex-direction: column; gap: 2px; }
    .decision-label { font-size: 13px; }
    .decision-desc { font-size: 11px; color: var(--fg-muted); line-height: 1.4; }
    .decision-input {
      width: 100%;
      padding: 7px 10px;
      background: var(--code-bg);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      font-family: inherit;
      font-size: 12px;
    }
    .decision-input:focus { outline: none; border-color: var(--accent, #4a9eff); }
    .decision-ok {
      align-self: flex-start;
      padding: 6px 14px;
      border: none;
      border-radius: var(--radius);
      background: var(--accent, #4a9eff);
      color: #fff;
      font-size: 12px;
      cursor: pointer;
    }
    .decision-ok:disabled { opacity: .45; cursor: default; }
    .decision-answer { font-size: 12px; color: var(--accent, #4a9eff); }

    /* Balance footer: inconspicuous, so that the answer above remains the main thing.
       No box, no monospace output. */
    .actions-summary {
      background: none;
      border: none;
      border-top: 1px solid var(--border);
      border-radius: 0;
      padding: 6px 0 0;
      max-width: 100%;
    }
    .actions-summary-line {
      font-size: 11px;
      color: var(--fg-muted);
      letter-spacing: .02em;
    }
    .actions-summary .action-item { margin-top: 4px; font-size: 12px; }
    .action-item { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 4px; line-height: 1.4; }
    .action-ok   { color: #6c6; }
    .action-fail { color: #c66; }
    .action-output {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--fg-muted);
      margin-left: 20px;
      white-space: pre-wrap;
      max-height: 150px;
      overflow-y: auto;
    }

    /* ── Thinking ── */
    #thinking {
      display: none;
      align-items: center;
      gap: 8px;
      color: var(--fg-muted);
      font-size: 12px;
      padding: 8px 16px;
      flex-shrink: 0;
    }
    #thinking.visible { display: flex; }
    /* Die Punkte und der Phasentext gehen, der Abbrechen-Knopf bleibt.
       Solange gearbeitet wird, muss man abbrechen koennen - auch waehrend
       Antworttext im Chat steht. */
    #thinking.phase-hidden .dot,
    #thinking.phase-hidden #thinking-label { display: none; }
    #thinking.phase-hidden { padding: 4px 16px; }
    .dot { width: 7px; height: 7px; background: var(--accent); border-radius: 50%; animation: bounce 1.2s infinite; }
    .dot:nth-child(2) { animation-delay: .2s; }
    .dot:nth-child(3) { animation-delay: .4s; }
    @keyframes bounce { 0%,80%,100%{transform:scale(.6);opacity:.4} 40%{transform:scale(1);opacity:1} }
    #btn-abort {
      margin-left: 6px;
      padding: 2px 10px;
      font-size: 11px;
      background: transparent;
      color: #f77;
      border: 1px solid rgba(255,100,100,.4);
      border-radius: 4px;
      cursor: pointer;
      font-family: var(--font);
      transition: background .12s, border-color .12s;
    }
    #btn-abort:hover { background: rgba(255,100,100,.12); border-color: #f77; }

    /* ── Input ── */
    #input-area {
      padding: 10px 12px;
      background: var(--bg-msg);
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }
    #input-row { display: flex; gap: 8px; align-items: flex-end; }
    #prompt-input {
      flex: 1;
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 9px 12px;
      font-family: var(--font);
      font-size: var(--font-size);
      resize: none;
      min-height: 40px;
      max-height: 200px;
      overflow-y: auto;
      line-height: 1.4;
      outline: none;
      transition: border-color .15s;
    }
    #prompt-input:focus { border-color: var(--accent); }
    #send-btn {
      background: var(--accent);
      color: var(--accent-fg);
      border: none;
      border-radius: 6px;
      padding: 9px 16px;
      cursor: pointer;
      font-size: 16px;
      height: 40px;
      flex-shrink: 0;
      transition: opacity .15s;
    }
    #send-btn:hover    { opacity: .85; }
    #send-btn:disabled { opacity: .4; cursor: default; }
    #hint { font-size: 10px; color: var(--fg-muted); margin-top: 5px; }
  </style>
</head>
<body>

<div id="toolbar">
  <button id="btn-test"     class="tb-btn">🔌 Connection</button>
  <button id="btn-reset"    class="tb-btn">🔄 New</button>
  <button id="btn-clear"    class="tb-btn danger">🗑 Clear history</button>
  <span class="tb-spacer"></span>
  <label id="mode-label" for="mode-select">Mode</label>
  <select id="mode-select" title="Arbeitsmodus des Assistenten">
    <option value="ask">🔒 Ask – confirm every change</option>
    <option value="auto">⚡ Auto – no questions asked</option>
    <option value="plan">📋 Plan – read and plan only</option>
  </select>
  <button id="btn-undo"     class="tb-btn">↩ Undo</button>
  <button id="btn-undo-all" class="tb-btn danger">↩↩ Undo All</button>
  <button id="btn-log"      class="tb-btn">📋 Log</button>
  <button id="btn-settings" class="tb-btn">⚙</button>
</div>

<div id="goal-bar"></div>

<div id="pending-banner"></div>

<div id="chat"></div>

<div id="thinking">
  <div class="dot"></div><div class="dot"></div><div class="dot"></div>
  <span id="thinking-label">KI denkt...</span>
  <button id="btn-abort">⏹ Cancel</button>
</div>

<div id="input-area">
  <div id="input-row">
    <textarea id="prompt-input"
      placeholder="Type an instruction… (e.g. 'Build a REST API with Express')"
      rows="1"></textarea>
    <button id="send-btn" title="Senden (Enter)">➤</button>
  </div>
  <div id="input-footer">
    <span id="hint">Enter to send &nbsp;·&nbsp; Shift+Enter for a line break</span>
    <span id="stats-bar">
      <span id="stats-progress"><span id="stats-progress-fill"></span></span>
      <span id="stats-text"></span>
    </span>
  </div>
</div>

<script nonce="${nonce}">
const vscode        = acquireVsCodeApi();
const chat          = document.getElementById('chat');
const goalBar       = document.getElementById('goal-bar');
const promptInput   = document.getElementById('prompt-input');
const sendBtn       = document.getElementById('send-btn');
const thinking      = document.getElementById('thinking');
const pendingBanner = document.getElementById('pending-banner');
const hintEl        = document.getElementById('hint');
const modeSelect    = document.getElementById('mode-select');

const MODE_HINTS = {
  ask:  'Every file change and every shell command is confirmed in the chat.',
  auto: 'The assistant works through without asking. Everything stays undoable.',
  plan: 'Read and plan only – changes and shell commands are blocked.'
};

function setMode(mode) {
  if (!modeSelect) return;
  const value = MODE_HINTS[mode] ? mode : 'ask';
  modeSelect.value = value;
  modeSelect.className = 'mode-' + value;
  modeSelect.title = MODE_HINTS[value];
}

// Current mode, used during rendering
setMode('${getAssistantMode()}');

let isBusy = false;
let currentAssistantEl = null;
let pendingCount = 0;

// ── Toolbar (addEventListener – onclick attributes are blocked by CSP) ──
document.getElementById('btn-test')    .addEventListener('click', () => vscode.postMessage({type:'testConnection'}));
document.getElementById('btn-reset')   .addEventListener('click', () => vscode.postMessage({type:'resetConversation'}));
document.getElementById('btn-clear')   .addEventListener('click', () => vscode.postMessage({type:'clearHistory'}));
document.getElementById('btn-undo')    .addEventListener('click', () => vscode.postMessage({type:'undoLast'}));
document.getElementById('btn-undo-all').addEventListener('click', () => vscode.postMessage({type:'undoAll'}));
document.getElementById('btn-log')     .addEventListener('click', () => vscode.postMessage({type:'openLog'}));
document.getElementById('btn-settings').addEventListener('click', () => vscode.postMessage({type:'openSettings'}));
document.getElementById('btn-abort')   .addEventListener('click', () => vscode.postMessage({type:'cancelGeneration'}));
modeSelect.addEventListener('change', () =>
  vscode.postMessage({type:'setMode', mode: modeSelect.value}));

// ── Messages from the Extension Host ──────────────────────────────────────────
// As a named function, so that the test run (test/webview-rows.js) can take
// exactly this path instead of calling the handlers individually.
window.addEventListener('message', (ev) => handleHostMessage(ev.data));

function handleHostMessage(msg) {
  switch (msg.type) {
    case 'userMessage':       resetPlan(); resetStats(); append(makeUserMsg(msg.text)); break;
    case 'plan':             renderPlan(msg.steps); break;
    case 'narration':        appendNarration(msg.text); break;
    case 'clearChat':        chat.innerHTML = ''; resetPlan(); resetStats(); break;
    case 'assistantMessage':
      // Beendet den Lauf NICHT: diese Nachricht kommt auch mittendrin -
      // "Loop started", "Goal set", die Abschlusszusammenfassung. Wer hier
      // den Zustand loescht, nimmt dem Benutzer den Abbrechen-Knopf genau in
      // dem Moment, in dem die Schleife anfaengt. Das Ende sagt der Host mit
      // 'inputEnabled'.
      append(makeAssistantMsg(msg.text));
      setPhaseVisible(false); break;
    case 'assistantMessageStart':
      currentAssistantEl = makeAssistantMsg('');
      currentAssistantEl.dataset.raw = '';
      streamedEl = currentAssistantEl;
      append(currentAssistantEl); break;
    case 'assistantToken':
      if (currentAssistantEl) {
        currentAssistantEl.dataset.raw += msg.text;
        updateAssistantEl(currentAssistantEl);
        // Die Denkpunkte gehen, sobald wirklich etwas dasteht - der
        // Abbrechen-Knopf bleibt, denn gearbeitet wird weiter. Und beginnt
        // eine Runde direkt mit einem Aktionsblock, wird der aus der Anzeige
        // geschnitten: dann bleiben auch die Punkte, sonst sieht es aus, als
        // sei nichts mehr los, waehrend das Modell eine ganze Datei schreibt.
        setPhaseVisible(cutActionMarkup(currentAssistantEl.dataset.raw).trim() === '');
        scrollBottom();
      } break;
    case 'assistantMessageEnd':
      // Ende der ANTWORT, nicht des Auftrags: danach werden die Aktionen
      // ausgefuehrt, und die Agenten-Schleife kann weitere Runden anhaengen.
      currentAssistantEl = null; setPhaseVisible(false); finalizeProgress(); break;
    case 'thinking':
      setThinking(msg.value);
      if (msg.value) setInputEnabled(false); break;
    case 'systemMessage':  append(makeSystemMsg(msg.text)); break;
    case 'errorMessage':
      append(makeErrorMsg(msg.text));
      setThinking(false); setInputEnabled(true); break;
    case 'actions':        append(makeActionsPanel(msg.actions, msg.title)); break;
    case 'iterationMessage':
      append(makeIterationMsg(msg.iteration, msg.reason)); break;
    case 'actionProgress':
      appendOrUpdateProgress(msg.description, msg.output, msg.meta); break;
    case 'contextWarning':
      append(makeWarningMsg(msg.text)); break;
    case 'modeChanged':    setMode(msg.mode); break;
    case 'fileDiff':       renderFileDiff(msg.change); break;
    case 'stats':          renderStats(msg.stats); break;
    case 'inputEnabled':   setThinking(false); setInputEnabled(msg.value); finalizeProgress(); resetStats(); break;
    case 'queuedMessage':   append(makeQueuedMsg(msg.text, msg.count)); break;
    case 'loopRound':       append(makeLoopRoundMsg(msg.round, msg.total, msg.note)); break;
    case 'goalChanged':     setGoalBar(msg.goal); break;
    case 'decisionRequest':
      append(makeDecisionCard(msg.requestId, msg.header, msg.question, msg.options, msg.multi));
      pendingCount++;
      updateBanner();
      // Gewartet wird auf den Benutzer, also keine Denkpunkte - aber der
      // Auftrag laeuft, und abbrechen darf man auch vor dem Antworten.
      setPhaseVisible(false);
      scrollBottom(); break;
    case 'confirmRequest':
      append(makeConfirmCard(
        msg.requestId, msg.message, msg.choices,
        msg.diffText, msg.hasDiff, msg.stats
      ));
      pendingCount++;
      updateBanner();
      scrollBottom(); break;
  }
}

// ── Confirmation card with colored diff ─────────────────────────────────────
/**
 * Decision card: a question, 2-4 options, a free-text field.
 *
 * Rebuilt based on the question dialog in the Claude Code plugin: a label for the
 * Decision, the question in larger font, then the options as radio
 * (Single selection) or checkboxes (multiple selection), each with a label and
 * Explanation. Selection by click, Enter or Space; "Something else" takes
 * Free text. In single selection, a click sends the answer immediately - a
 * zweite Bestaetigung waere ein Klick zu viel.
 */
function makeDecisionCard(requestId, header, question, options, multi) {
  const card = document.createElement('div');
  card.className = 'decision-card';

  if (header) {
    const tag = document.createElement('div');
    tag.className = 'decision-header';
    tag.textContent = header;
    card.appendChild(tag);
  }

  const q = document.createElement('div');
  q.className = 'decision-question';
  q.textContent = question;
  card.appendChild(q);

  const chosen = new Set();
  let answered = false;

  const send = (value) => {
    if (answered) return;
    answered = true;
    card.classList.add('decision-done');
    const shown = document.createElement('div');
    shown.className = 'decision-answer';
    shown.textContent = '\\u2192 ' + value;
    card.appendChild(shown);
    for (const el of card.querySelectorAll('.decision-option')) el.classList.add('decision-locked');
    if (freeWrap) freeWrap.style.display = 'none';
    pendingCount = Math.max(0, pendingCount - 1);
    updateBanner();
    vscode.postMessage({ type: 'decisionResponse', requestId, choice: value });
  };

  const list = document.createElement('div');
  list.className = 'decision-options';

  for (const opt of (options || [])) {
    const row = document.createElement('div');
    row.className = 'decision-option';
    row.tabIndex = 0;
    row.setAttribute('role', multi ? 'checkbox' : 'radio');
    row.setAttribute('aria-checked', 'false');

    const mark = document.createElement('div');
    mark.className = multi ? 'decision-box' : 'decision-radio';
    row.appendChild(mark);

    const body = document.createElement('div');
    body.className = 'decision-body';
    const label = document.createElement('div');
    label.className = 'decision-label';
    label.textContent = opt.label;
    body.appendChild(label);
    if (opt.description) {
      const desc = document.createElement('div');
      desc.className = 'decision-desc';
      desc.textContent = opt.description;
      body.appendChild(desc);
    }
    row.appendChild(body);

    const pick = () => {
      if (answered) return;
      if (!multi) { send(opt.label); return; }
      if (chosen.has(opt.label)) chosen.delete(opt.label); else chosen.add(opt.label);
      row.classList.toggle('decision-checked', chosen.has(opt.label));
      row.setAttribute('aria-checked', chosen.has(opt.label) ? 'true' : 'false');
      if (okBtn) okBtn.disabled = chosen.size === 0;
    };
    row.addEventListener('click', pick);
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); }
    });

    list.appendChild(row);
  }
  card.appendChild(list);

  // Free text: the options never covered everything, and without this field the
  // user would have to cancel the current task to say something else.
  const freeWrap = document.createElement('div');
  freeWrap.className = 'decision-free';
  const free = document.createElement('input');
  free.type = 'text';
  free.className = 'decision-input';
  free.placeholder = 'Etwas anderes\\u2026 (Enter schickt ab)';
  free.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && free.value.trim()) { ev.preventDefault(); send(free.value.trim()); }
  });
  freeWrap.appendChild(free);
  card.appendChild(freeWrap);

  let okBtn = null;
  if (multi) {
    okBtn = document.createElement('button');
    okBtn.className = 'decision-ok';
    okBtn.textContent = '\\u00dcbernehmen';
    okBtn.disabled = true;
    okBtn.addEventListener('click', () => {
      if (chosen.size > 0) send([...chosen].join(', '));
    });
    card.appendChild(okBtn);
  }

  return card;
}

function makeConfirmCard(requestId, message, choices, diffText, hasDiff, stats) {
  const card = document.createElement('div');
  card.className = 'confirm-card';
  card.dataset.requestId = requestId;

  // Nachricht
  const msgEl = document.createElement('div');
  msgEl.className = 'confirm-msg';
  msgEl.innerHTML = renderMd(message);
  card.appendChild(msgEl);

  // Farbiger Diff-Block
  if (diffText) {
    const diffView = buildDiffView(diffText);
    card.appendChild(diffView);

    // Footer: Stats + "Open in Editor" button
    const footer = document.createElement('div');
    footer.className = 'diff-footer';

    const statsEl = document.createElement('span');
    if (stats) {
      statsEl.innerHTML =
        '<span style="color:#c66">−' + stats[0] + '</span> ' +
        '<span style="color:#6c6">+' + stats[1] + '</span> lines';
    }
    footer.appendChild(statsEl);

    if (hasDiff) {
      const openBtn = document.createElement('button');
      openBtn.className = 'diff-open-btn';
      openBtn.textContent = '↗ Open in editor';
      openBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'openDiff', requestId });
      });
      footer.appendChild(openBtn);
    }

    diffView.appendChild(footer);
    card.appendChild(diffView);
  }

  // Aktions-Buttons
  const btnRow = document.createElement('div');
  btnRow.className = 'confirm-buttons';
  choices.forEach((label, idx) => {
    const btn = document.createElement('button');
    btn.className = 'confirm-btn ' + (idx === 0 ? 'primary' : 'secondary');
    btn.textContent = label;
    btn.addEventListener('click', () => resolveConfirm(card, requestId, label));
    btnRow.appendChild(btn);
  });
  card.appendChild(btnRow);

  const rl = document.createElement('div');
  rl.className = 'resolved-label';
  card.appendChild(rl);
  return card;
}

// ── Colored diff block from unified-diff string ──────────────────────────────
function buildDiffView(diffText) {
  const view = document.createElement('div');
  view.className = 'diff-view';

  const lines = diffText.split('\\n');
  for (const line of lines) {
    const row = document.createElement('div');
    const gutter = document.createElement('span');
    gutter.className = 'diff-gutter';
    const text = document.createElement('span');
    text.className = 'diff-text';

    if (line.startsWith('@@')) {
      row.className = 'diff-line hunk';
      gutter.textContent = '⋯';
      text.textContent = line;
    } else if (line.startsWith('+')) {
      row.className = 'diff-line add';
      gutter.textContent = '+';
      text.textContent = line.slice(1);
    } else if (line.startsWith('-')) {
      row.className = 'diff-line remove';
      gutter.textContent = '−';
      text.textContent = line.slice(1);
    } else {
      row.className = 'diff-line ctx';
      gutter.textContent = '';
      text.textContent = line.slice(1);  // Leerzeichen am Anfang entfernen
    }

    row.appendChild(gutter);
    row.appendChild(text);
    view.appendChild(row);
  }
  return view;
}

function resolveConfirm(card, requestId, choice) {
  card.classList.add('resolved');
  const rl = card.querySelector('.resolved-label');
  if (rl) rl.textContent = '✓ ' + choice;
  pendingCount = Math.max(0, pendingCount - 1);
  updateBanner();
  vscode.postMessage({ type: 'confirmResponse', requestId, choice });
}

function updateBanner() {
  if (pendingCount > 0) {
    pendingBanner.className = 'visible';
    pendingBanner.textContent =
      '⏳ ' + pendingCount + ' Confirmation' + (pendingCount > 1 ? 'en' : '') + ' ausstehend – scrolle nach unten';
    pendingBanner.style.display = 'flex';
  } else {
    pendingBanner.style.display = 'none';
    pendingBanner.className = '';
  }
}

// ── Senden ───────────────────────────────────────────────────────────────────
function submitPrompt() {
  const text = promptInput.value.trim();
  // isBusy no longer blocks: a new task may now start the ongoing
  // interrupt. The extension host handles the cancellation.
  if (!text) return;
  promptInput.value = "";
  autoResize();
  vscode.postMessage({ type: "sendMessage", text });
}

sendBtn.addEventListener('click', submitPrompt);
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitPrompt(); }
});
promptInput.addEventListener('input', autoResize);

// Focus the input field upon opening – so you can start typing immediately.
// Also when returning after a tab switch, since focus is lost in that process.
promptInput.focus();
window.addEventListener('focus', () => { if (!isBusy) promptInput.focus(); });

function autoResize() {
  promptInput.style.height = 'auto';
  promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + 'px';
}

// ── Elemente erstellen ───────────────────────────────────────────────────────
function makeUserMsg(text) {
  const d = document.createElement('div');
  d.className = 'msg-user'; d.textContent = text; return d;
}
function makeAssistantMsg(text) {
  const d = document.createElement('div');
  d.className = 'msg-assistant'; d.innerHTML = renderMd(text); return d;
}
function makeSystemMsg(text) {
  const d = document.createElement('div');
  d.className = 'msg-system'; d.textContent = text; return d;
}

/**
 * Eine Anweisung, die waehrend der Arbeit getippt wurde.
 *
 * Sie sieht bewusst aus wie eine Benutzernachricht, nur blasser und mit einem
 * Vermerk: sie IST gesendet, sie ist nur noch nicht dran. Ohne diese Karte
 * wuesste man nicht, ob die Eingabe angekommen ist.
 */
function makeQueuedMsg(text, count) {
  const d = document.createElement('div');
  d.className = 'msg-user msg-queued';

  const body = document.createElement('div');
  body.textContent = text;
  d.appendChild(body);

  const note = document.createElement('div');
  note.className = 'queued-note';
  note.textContent = count > 1
    ? '\\u23f3 queued (' + count + ') \\u2013 comes up after the current step'
    : '\\u23f3 queued \\u2013 comes up after the current step';
  d.appendChild(note);
  return d;
}

/** Loop counter of the /loop loop. */
function makeLoopRoundMsg(round, total, note) {
  const d = document.createElement('div');
  d.className = 'msg-iteration msg-loop';
  d.textContent = '\\u21bb Loop: round ' + round + ' of at most '
    + total + (note ? ' \\u00b7 ' + note : '');
  return d;
}

/** Show or hide the target bar below the toolbar. */
function setGoalBar(goal) {
  if (!goalBar) return;
  const text = String(goal || '').trim();
  goalBar.textContent = text ? '\\u25ce Goal: ' + text : '';
  goalBar.classList.toggle('visible', !!text);
}
function makeErrorMsg(text) {
  const d = document.createElement('div');
  d.className = 'msg-error'; d.textContent = '⚠ ' + text; return d;
}
function makeIterationMsg(iteration, reason) {
  const d = document.createElement('div');
  d.className = 'msg-iteration';
  d.textContent = '🔧 ' + reason + ' (Iteration ' + iteration + ')';
  return d;
}

// ── Key Metrics: Prompt Progress and Tokens/Second ─────────────────────────
// With large contexts, evaluating the input alone can take minutes. Without
// this display, only "AI is thinking…" appears, leaving you unsure if it's stuck.
const statsBar      = document.getElementById('stats-bar');
const statsProgress = document.getElementById('stats-progress');
const statsFill     = document.getElementById('stats-progress-fill');
const statsText     = document.getElementById('stats-text');

function fmtNum(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n));
}

const thinkingLabel = document.getElementById('thinking-label');

/**
 * Adjust the label of the thinking bar to the current phase.
 * "AI is thinking…" says nothing – during input evaluation, one wants to know,
 * that calculations are performed and to what extent.
 */
function setThinkingPhase(text) {
  if (thinkingLabel) thinkingLabel.textContent = text;
}

/** Was der Assistent gerade schreibt, in Worten statt im Werkzeugnamen. */
function TOOL_VERB(tool) {
  const verbs = {
    create_file: 'Writing a file', edit_file: 'Changing a file',
    patch_file: 'Writing a patch', replace_lines: 'Replacing lines',
    delete_file: 'Deleting a file', shell: 'Composing a command',
    read_file: 'Reading a file', grep: 'Composing a search',
    glob: 'Composing a search', list_dir: 'Reading a directory',
    web_search: 'Composing a search', web_fetch: 'Preparing a fetch',
    plan: 'Writing the plan', done: 'Writing the summary',
    ask_user: 'Composing a question', remember: 'Noting a rule'
  };
  return verbs[tool] || (tool + ' in progress');
}

function renderStats(s) {
  if (!s || !statsBar) return;
  statsBar.classList.add('visible');

  const parts = [];

  // During prompt evaluation: bar + percentage
  const p = s.promptProgress;
  if (p && p.fraction < 1) {
    statsProgress.classList.add('visible');
    statsFill.style.width = Math.round(p.fraction * 100) + '%';
    const pct = Math.round(p.fraction * 100);
    parts.push('Prompt ' + pct + '% (' + fmtNum(p.processed) + '/' + fmtNum(p.total) + ')');
    setThinkingPhase('Reading the prompt… ' + pct + '%');
  } else {
    statsProgress.classList.remove('visible');
    if (s.predictedTokens > 0) {
      // With a native tool call there is no text to show – so at least say
      // WHICH call is being written. Without it the panel showed "Antwort wird
      // erzeugt… 2.1k Tok" for minutes and nothing else.
      setThinkingPhase(s.tool
        ? TOOL_VERB(s.tool) + '… ' + fmtNum(s.predictedTokens) + ' Tok'
        : 'Writing the answer… ' + fmtNum(s.predictedTokens) + ' Tok');
    }
  }

  if (s.tool) parts.push('\\u2699 ' + s.tool);

  if (s.promptTokens > 0) {
    let inPart = '↓ ' + fmtNum(s.promptTokens) + ' Tok';
    if (s.promptPerSecond > 0) inPart += ' @ ' + Math.round(s.promptPerSecond) + '/s';
    if (s.cachedTokens > 0) inPart += ' (' + fmtNum(s.cachedTokens) + ' aus Cache)';
    parts.push(inPart);
  }

  if (s.predictedTokens > 0) {
    let outPart = '↑ ' + fmtNum(s.predictedTokens) + ' Tok';
    if (s.predictedPerSecond > 0) outPart += ' @ ' + s.predictedPerSecond.toFixed(1) + '/s';
    parts.push(outPart);
  }

  statsText.textContent = parts.join('   ·   ');
}

function resetStats() {
  if (!statsBar) return;
  statsBar.classList.remove('visible');
  statsProgress.classList.remove('visible');
  statsText.textContent = '';
  statsFill.style.width = '0%';
  setThinkingPhase("KI denkt...");
}

// The streamed paragraph of the current round. At the end of the round, it is replaced by the
// bereinigten Text ersetzt (siehe appendNarration).
let streamedEl = null;

// Lines of the current round, by key. A map instead of "only the last
// line": in the window run, the assistant fetched two pages, and the first line
// remained at "running...", while the finished output received a second line
// with the same address. If you only compare the last line, you lose
// any message that does not immediately follow its predecessor.
let progressRows = new Map();
let lastProgressEl = null;

/**
 * Identität einer Fortschrittsmeldung: die Beschreibung ohne Status-Symbol.
 * "⚙ Shell: npm test" und "✅ Shell: npm test" sind derselbe Vorgang und
 * sollen dieselbe Karte aktualisieren – zwei verschiedene Vorgänge dagegen
 * bekommen zwei Karten. Ohne diesen Schlüssel überschrieb jede Meldung die
 * vorherige und man sah am Ende nur eine einzige Zeile.
 */
function progressKey(description) {
  return String(description).replace(/^[^A-Za-z0-9\\x60]+/, '').trim();
}

/**
 * Der geprueft saubere Text einer Runde.
 *
 * Waehrend des Streamens rendert der Chat die ROHE Modellantwort - da stehen die
 * Aktionsbloecke noch drin. Im Fenster sah man deshalb ">>>REPLACE" und
 * Quellcode statt einer Antwort. Die Engine liefert nach jeder Runde den
 * bereinigten Text nach, und der ersetzt hier den gestreamten Absatz.
 *
 * Bewusst nicht als 'assistantMessage': die gibt das Eingabefeld wieder frei,
 * und der Assistent arbeitet ja noch. Ausserdem beendet sie die laufende
 * Werkzeugzeile, damit die naechste Aktion eine neue bekommt.
 */
function appendNarration(text) {
  const clean = String(text == null ? '' : text).trim();

  // Replace the streamed paragraph of this round with the clean text.
  if (streamedEl) {
    const el = streamedEl;
    streamedEl = null;
    if (clean) {
      el.dataset.raw = clean;
      updateAssistantEl(el);
    } else if (el.parentNode) {
      // Nothing but action markup: the empty paragraph has no place in the chat
      el.parentNode.removeChild(el);
    }
    finalizeProgress();
    scrollBottom();
    return;
  }

  if (!clean) return;
  finalizeProgress();
  append(makeAssistantMsg(clean));
}

/** How many lines of output are visible without expanding. */
const OUTPUT_PREVIEW_LINES = 4;

/**
 * Use the output of an action: the first lines are visible, the rest is hidden
 * a switch. Without truncation, a test output pushes everything else away.
 */
function fillOutput(box, text) {
  box.innerHTML = '';
  const clean = String(text == null ? '' : text).replace(/\\s+$/, '');
  if (!clean) { box.style.display = 'none'; return; }
  box.style.display = '';

  const lines = clean.split('\\n');
  const pre = document.createElement('pre');
  pre.className = 'tool-out';
  pre.textContent = lines.slice(0, OUTPUT_PREVIEW_LINES).join('\\n');
  box.appendChild(pre);

  if (lines.length <= OUTPUT_PREVIEW_LINES) return;

  const rest = lines.length - OUTPUT_PREVIEW_LINES;
  const more = document.createElement('button');
  more.className = 'tool-more';
  more.textContent = '▸ ' + rest + ' more lines';
  let open = false;
  more.addEventListener('click', () => {
    open = !open;
    pre.textContent = open ? clean : lines.slice(0, OUTPUT_PREVIEW_LINES).join('\\n');
    more.textContent = (open ? '▾ ' : '▸ ') + rest + ' more lines';
    scrollBottom();
  });
  box.appendChild(more);
}

/**
 * Build a toolbar: point, tool name, target, additional.
 * Conscious like a terminal line – one line per operation, output below.
 */
function buildToolRow(meta, description) {
  const row = document.createElement('div');
  row.className = 'tool-row';

  const head = document.createElement('div');
  head.className = 'tool-head';

  const dot = document.createElement('span');
  dot.className = 'tool-dot';
  head.appendChild(dot);

  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = (meta && meta.tool) || 'Action';
  head.appendChild(name);

  const target = document.createElement('span');
  target.className = 'tool-target';
  target.textContent = (meta && meta.target) || description || '';
  head.appendChild(target);

  const detail = document.createElement('span');
  detail.className = 'tool-detail';
  head.appendChild(detail);

  row.appendChild(head);

  const box = document.createElement('div');
  box.className = 'tool-output';
  box.style.display = 'none';
  row.appendChild(box);

  return row;
}

/** Set the status of a tool line: running / successful / failed. */
function styleToolRow(row, meta) {
  const state = !meta ? 'ok'
    : meta.running ? 'running'
    : meta.ok === false ? 'fail' : 'ok';
  row.className = 'tool-row tool-' + state;

  const detail = row.querySelector('.tool-detail');
  if (detail) {
    detail.textContent = (meta && meta.detail) ? meta.detail
      : (meta && meta.running) ? 'running…' : '';
  }
}

/**
 * Ein Ergebnis darf seine laufende Zeile auch dann finden, wenn der
 * Beschreibungstext leicht abweicht - gesucht wird ueber Werkzeug und Ziel.
 *
 * Der Grund: im Fenster standen fuer EINEN sed-Aufruf zwei Zeilen, die obere
 * fuer immer auf "laeuft...". Eine Zeile, die nie ein Ergebnis bekommt, laesst
 * den Benutzer glauben, der Befehl haenge noch - genau die Unklarheit, gegen
 * die die Zeilen da sind.
 */
function findRunningRow(meta) {
  if (!meta || meta.running || !meta.tool || !meta.target) return null;
  // Im DOM gesucht, nicht in progressRows: die Liste wird zwischendurch
  // geleert (jede Bestaetigung schickt 'inputEnabled' hinterher), und dann
  // stand die laufende Zeile fuer immer auf "laeuft...", waehrend ihr Ergebnis
  // eine zweite Zeile bekam. Genau so sah es beim Testlauf aus.
  const rows = chat.querySelectorAll('.tool-row');
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.dataset.tool === meta.tool && row.dataset.target === meta.target
        && row.classList.contains('tool-running')) {
      return row;
    }
  }
  return null;
}

function appendOrUpdateProgress(description, output, meta) {
  const key = progressKey((meta && meta.tool ? meta.tool + ' ' : '') + description);

  // Derselbe Vorgang aktualisiert seine Zeile, auch wenn zwischendurch eine
  // andere Aktion gemeldet wurde. Zwei verschiedene Vorgaenge bekommen zwei
  // Zeilen - ohne diese Unterscheidung ueberschrieb jede Meldung die vorherige
  // und man sah am Ende nur eine einzige Zeile.
  const known = progressRows.get(key) || findRunningRow(meta);
  if (known) {
    styleToolRow(known, meta);
    fillOutput(known.querySelector('.tool-output'), output);
    scrollBottom();
    return;
  }

  const row = buildToolRow(meta, description);
  row.dataset.key = key;
  row.dataset.tool = (meta && meta.tool) || '';
  row.dataset.target = (meta && meta.target) || '';
  styleToolRow(row, meta);
  fillOutput(row.querySelector('.tool-output'), output);

  progressRows.set(key, row);
  lastProgressEl = row;
  append(row);
}

// ── Applied file change with colored diff ──────────────────────────────
// In auto mode there is no confirmation card – without this display you would
// never see what the assistant changed.
function renderFileDiff(change) {
  if (!change) return;

  const card = document.createElement('div');
  card.className = 'diff-card diff-' + change.kind;

  const head = document.createElement('div');
  head.className = 'diff-card-head';
  const [removed, added] = change.stats || [0, 0];
  const icon = change.kind === 'created' ? '📄'
    : change.kind === 'deleted' ? '🗑' : '✏';
  head.textContent = icon + ' ' + change.path + '  ' + change.kind
    + '   −' + removed + ' / +' + added;
  card.appendChild(head);

  if (change.diffText) {
    const details = document.createElement('details');
    details.open = true;
    const summary = document.createElement('summary');
    summary.textContent = 'Show diff';
    details.appendChild(summary);
    details.appendChild(buildDiffView(change.diffText));
    card.appendChild(details);
  }

  append(card);
}

// End section: the previous toolbar lines remain, but a
// the identically named action afterwards gets a new line - a second "npm test"
// After a change, it is a new process and not an addendum to the first one.
function finalizeProgress() {
  progressRows = new Map();
  lastProgressEl = null;
}
function makeWarningMsg(text) {
  const d = document.createElement('div');
  d.className = 'msg-warning';
  d.textContent = '⚠ ' + text;
  return d;
}

// ── Work Plan (AI Todo List) ─────────────────────────────────────────
// There is always only ONE plan card per task: it is updated in place
// so that you can track progress instead of seeing ten copies.
let planEl = null;

function renderPlan(steps) {
  if (!steps || steps.length === 0) return;

  if (!planEl) {
    planEl = document.createElement('div');
    planEl.className = 'plan-panel';
    append(planEl);
  }
  planEl.innerHTML = '';

  const done = steps.filter(s => s.status === 'done').length;

  const head = document.createElement('div');
  head.className = 'plan-head';
  head.textContent = '📋 Plan – ' + done + '/' + steps.length + ' erledigt';
  planEl.appendChild(head);

  const bar = document.createElement('div');
  bar.className = 'plan-bar';
  const fill = document.createElement('div');
  fill.className = 'plan-bar-fill';
  fill.style.width = Math.round((done / steps.length) * 100) + '%';
  bar.appendChild(fill);
  planEl.appendChild(bar);

  for (const s of steps) {
    const row = document.createElement('div');
    row.className = 'plan-step plan-' + s.status;
    const icon = s.status === 'done' ? '✅' : s.status === 'doing' ? '⏳' : '☐';
    row.innerHTML = '<span class="plan-icon">' + icon + '</span><span>' + esc(s.text) + '</span>';
    planEl.appendChild(row);
  }
  scrollBottom();
}

/** Release the plan card so that the next task receives a new one. */
function resetPlan() { planEl = null; }
/**
 * Fusszeile am Ende eines Laufs: eine Zeile Bilanz, plus die Fehlschlaege.
 *
 * Fruener stand hier jede Aktion samt Ausgabe noch einmal - seit jede Aktion
 * ihre eigene Werkzeugzeile hat, war das eine zweite, monospace gesetzte Kopie
 * des ganzen Laufs. Und sie stand als LETZTES im Chat, also dort, wo man die
 * Antwort erwartet. Erfolge sind oben schon zu sehen; nur was schiefging muss
 * hier noch einmal auftauchen, damit es nicht im Verlauf nach oben rutscht.
 */
function makeActionsPanel(actions, title) {
  const p = document.createElement('div');
  p.className = 'actions-panel actions-summary';

  const failed = actions.filter(a => !a.success);
  const ok = actions.length - failed.length;

  const h = document.createElement('div');
  h.className = 'actions-summary-line';
  h.textContent = (title || 'Actions taken')
    + '  \\u00b7  ' + ok + ' erfolgreich'
    + (failed.length ? ', ' + failed.length + ' fehlgeschlagen' : '');
  p.appendChild(h);

  for (const a of failed) {
    const row = document.createElement('div');
    row.className = 'action-item';
    // Regarding textContent instead of innerHTML: the description comes from a
    // model answer and must not be able to inject markup.
    const icon = document.createElement('span');
    icon.className = 'action-fail';
    icon.textContent = '\\u274c';
    row.appendChild(icon);
    const label = document.createElement('span');
    label.textContent = ' ' + a.description;
    row.appendChild(label);
    p.appendChild(row);
  }
  return p;
}

function append(el) { chat.appendChild(el); scrollBottom(); return el; }
function scrollBottom() { requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; }); }
// The thinking state no longer blocks input: the user should be able to choose between
// can send a new task to the iterations. Enter interrupts the
// current task and then starts the new one.
/**
 * Laeuft gerade ein Auftrag?
 *
 * Das hier entscheidet ueber den Abbrechen-Knopf und den Hinweistext - nicht
 * darueber, ob Denkpunkte zu sehen sind. Beides war einmal dasselbe, und das
 * war der Fehler: sobald Antworttext kam, verschwand die ganze Zeile samt
 * Abbrechen. Bei einer Runde mit Prosa war der Knopf weg, bei einer mit
 * reinem Werkzeugaufruf blieb er - "manchmal da, manchmal nicht".
 *
 * Ausgeschaltet wird nur vom Host, wenn der Auftrag wirklich zu Ende ist.
 */
function setThinking(v) {
  isBusy = v;
  thinking.classList.toggle("visible", v);
  if (v) thinking.classList.remove("phase-hidden");
  if (hintEl) hintEl.textContent = v
    ? "Enter queues the instruction \u2013 it comes up after the current step"
    : "Enter to send \\u00b7 Shift+Enter for a line break";
  if (v) scrollBottom();
}

/**
 * Denkpunkte und Phasentext ein- oder ausblenden.
 *
 * Sie gehoeren weg, sobald im Chat wirklich etwas steht - zwei Anzeigen fuer
 * denselben Zustand sind eine zu viel. Der Abbrechen-Knopf bleibt.
 */
function setPhaseVisible(v) {
  thinking.classList.toggle("phase-hidden", !v);
  // Ein laufender Auftrag ohne Denkpunkte braucht die Zeile weiterhin:
  // ohne 'visible' waere auch der Knopf weg.
  if (isBusy) thinking.classList.add("visible");
}
function setInputEnabled(v) {
  // Input and send remain always operable
  promptInput.disabled = false;
  sendBtn.disabled = false;
  if (v) isBusy = false;
}

// ── Markdown + Reasoning Blocks ─────────────────────────────────────────────

/** Basic Markdown without <think>-Handling */
function renderMdBasic(text) {
  if (!text) return '';

  // Remove code blocks first and replace them with placeholders.
  // Otherwise, the line processing would see lists and headings within them.
  const blocks = [];
  let src = String(text).replace(/\\u0060\\u0060\\u0060([\\w+-]*)[ \\t]*\\r?\\n([\\s\\S]*?)\\u0060\\u0060\\u0060/g,
    (_m, lang, code) => {
      const i = blocks.length;
      blocks.push({ lang: lang || '', code: code });
      return '\\u0000BLOCK' + i + '\\u0000';
    });

  // Incomplete block (streaming still running): Display the rest as code,
  // so that the text does not break apart as Markdown and then jump around.
  const openFence = src.indexOf('\\u0060\\u0060\\u0060');
  if (openFence !== -1) {
    const head = src.slice(0, openFence);
    const rest = src.slice(openFence + 3);
    const nl = rest.indexOf('\\n');
    const lang = nl === -1 ? rest.trim() : rest.slice(0, nl).trim();
    const code = nl === -1 ? '' : rest.slice(nl + 1);
    const i = blocks.length;
    blocks.push({ lang: lang, code: code });
    src = head + '\\u0000BLOCK' + i + '\\u0000';
  }

  const out = [];
  let listType = null;   // 'ul' | 'ol' | null
  // An empty line ends the paragraph. Without this feature, two paragraphs separated
  // by an empty line would merge into one.
  let paragraphOpen = false;

  const closeList = () => {
    if (listType) { out.push('</' + listType + '>'); listType = null; }
  };

  /** Zeichenformatierung innerhalb einer Zeile. */
  const inline = (s) => {
    let h = esc(s);
    h = h.replace(/\\u0060([^\\u0060]+)\\u0060/g, '<code>$1</code>');
    h = h.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    h = h.replace(/(^|[^*])\\*([^*]+)\\*/g, '$1<em>$2</em>');
    // Markdown links; only http(s), so that no javascript: gets through
    h = h.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return h;
  };

  const lines = src.split('\\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    // Placeholder for a code block
    const ph = /^\\u0000BLOCK(\\d+)\\u0000$/.exec(t);
    if (ph) {
      closeList();
      const b = blocks[Number(ph[1])];
      const code = b.code.replace(/\\s+$/, '');
      // Empty block = empty framed box in the chat. This happens when the
      // action markup was cut out of the text and only its fence remained,
      // or when streaming has just opened a fence. Nothing to show.
      if (code.trim() === '') continue;
      out.push('<pre' + (b.lang ? ' data-lang="' + esc(b.lang) + '"' : '') +
        '><code>' + esc(code) + '</code></pre>');
      continue;
    }

    if (t === '') { closeList(); paragraphOpen = false; continue; }

    // Waagerechte Linie
    if (/^([-*_])\\1{2,}$/.test(t)) { closeList(); out.push('<hr>'); continue; }

    // Ueberschrift
    const head = /^(#{1,6})\\s+(.*)$/.exec(t);
    if (head) {
      closeList();
      const lvl = Math.min(6, head[1].length + 2);   // ## -> h4, damit es in den Chat passt
      out.push('<h' + lvl + ' class="md-h">' + inline(head[2]) + '</h' + lvl + '>');
      continue;
    }

    // Zitat
    const quote = /^>\\s?(.*)$/.exec(t);
    if (quote) {
      closeList();
      out.push('<blockquote>' + inline(quote[1]) + '</blockquote>');
      continue;
    }

    // Aufzaehlung
    const ul = /^[-*+]\\s+(.*)$/.exec(t);
    if (ul) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push('<li>' + inline(ul[1]) + '</li>');
      continue;
    }

    // Nummerierte Liste
    const ol = /^(\\d+)[.)]\\s+(.*)$/.exec(t);
    if (ol) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push('<li>' + inline(ol[2]) + '</li>');
      continue;
    }

    // Tabellenzeile
    if (/^\\|.*\\|$/.test(t)) {
      // Separator line (|---|---|) belongs to the table but is not displayed
      if (/^\\|[\\s:|-]+\\|$/.test(t)) continue;
      closeList();
      const cells = t.slice(1, -1).split('|').map(c => '<td>' + inline(c.trim()) + '</td>');
      const prevIsTable = out.length > 0 && out[out.length - 1].startsWith('<table');
      if (prevIsTable) {
        out[out.length - 1] = out[out.length - 1].replace(/<\\/table>$/, '') +
          '<tr>' + cells.join('') + '</tr></table>';
      } else {
        out.push('<table class="md-table"><tr>' + cells.join('') + '</tr></table>');
      }
      continue;
    }

    // Normaler Absatz. Aufeinanderfolgende Zeilen bleiben ein Absatz.
    const prev = out[out.length - 1];
    if (paragraphOpen && !listType && prev && prev.endsWith('</p>')) {
      out[out.length - 1] = prev.slice(0, -4) + '<br>' + inline(line) + '</p>';
    } else {
      closeList();
      out.push('<p>' + inline(line) + '</p>');
      paragraphOpen = true;
    }
  }

  closeList();
  return out.join('');
}

/**
 * Incrementally updates an assistant element during streaming.
 * The <details> element is created only once and never replaced afterwards,
 * so that the user can expand/collapse it without it being reset.
 */
/**
 * Cut action markup from the still-running stream.
 *
 * The chat renders the raw response during streaming. Starting from the first
 * Action header is the remaining tool call and no longer a response - without
 * this cut flashed ">>>REPLACE" and the source code in the chat until the
 * The engine delivered the cleaned text. Only one cut, no
 * Reconstruction: the reliable version will come anyway.
 */
function cutActionMarkup(text) {
  // Backticks in the pattern must be escaped: this code is inside a
  // TypeScript template string, a raw \` terminates it (see AGENTS.md).
  const cut = String(text).search(/(^|\\n)[ \\t]*(?:\`\`\`)?action:[a-z_]+/i);
  return cut === -1 ? text : text.slice(0, cut);
}

function updateAssistantEl(el) {
  const raw = cutActionMarkup(el.dataset.raw || '');
  const thinkStart = raw.indexOf('<think>');

  if (thinkStart === -1) {
    // No reasoning block → simple rendering
    el.innerHTML = renderMdBasic(raw);
    return;
  }

  const beforeThink = raw.slice(0, thinkStart);
  const afterOpen   = raw.slice(thinkStart + 7);
  const thinkEnd    = afterOpen.indexOf('</think>');
  const isStreaming = thinkEnd === -1;
  const thinkText   = isStreaming ? afterOpen : afterOpen.slice(0, thinkEnd);
  const afterThink  = isStreaming ? '' : afterOpen.slice(thinkEnd + 8);

  // <details> Element wiederverwenden falls vorhanden
  let details = el.querySelector('.think-block');

  if (!details) {
    // Erstmalig aufbauen
    el.innerHTML = (beforeThink ? renderMdBasic(beforeThink) : '') +
      '<details class="think-block">' +
        '<summary><span class="think-toggle">▶</span>' +
        '<span class="think-label">🧠 Reasoning</span><span class="think-meta"></span></summary>' +
        '<div class="think-content"></div>' +
      '</details>' +
      '<div class="think-after"></div>';

    details = el.querySelector('.think-block');

    // Scroll when the user manually expands
    details.addEventListener('toggle', () => {
      if (details.open) requestAnimationFrame(() => {
        details.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
  }

  // Only update content – open status remains unchanged
  const contentEl = el.querySelector('.think-content');
  if (contentEl) contentEl.innerHTML = renderMdBasic(thinkText);

  // Scope in the header: even when collapsed, it should be visible that (and how
  // much) is being thought about. Otherwise, a collapsed block looks like nothing.
  const metaEl = el.querySelector('.think-meta');
  if (metaEl) {
    const lines = thinkText ? thinkText.split('\\n').length : 0;
    metaEl.textContent = isStreaming ? ' · denkt… ' + lines + ' Z.' : ' · ' + lines + ' Z.';
  }

  // When streaming is complete: collapse (unless the user has manually opened it)
  if (!isStreaming) {
    const label = el.querySelector('.think-label');
    if (label) label.textContent = '🧠 Reasoning';

    // No automatic expand or collapse: the state belongs to the user.
    // Previously, it would collapse again upon completion - this would undo
    // any click the user made while thinking.

    // Render text after
    const afterEl = el.querySelector('.think-after');
    if (afterEl) afterEl.innerHTML = renderMdBasic(afterThink);
  }

  // Benutzer-Intent merken
  if (details && !details._toggleListenerAdded) {
    details._toggleListenerAdded = true;
    details.addEventListener('toggle', () => {
      details.dataset.userOpened = details.open ? '1' : '';
    });
  }
}

/** For non-streamed messages: static rendering */
function renderMd(text) {
  if (!text) return '';
  const thinkStart = text.indexOf('<think>');
  if (thinkStart === -1) return renderMdBasic(text);

  const before   = text.slice(0, thinkStart);
  const afterOpen = text.slice(thinkStart + 7);
  const thinkEnd  = afterOpen.indexOf('</think>');

  if (thinkEnd !== -1) {
    const thinkContent = afterOpen.slice(0, thinkEnd);
    const after        = afterOpen.slice(thinkEnd + 8);
    return (before ? renderMdBasic(before) : '') +
      '<details class="think-block">' +
        '<summary><span class="think-toggle">▶</span><span class="think-label">🧠 Reasoning</span></summary>' +
        '<div class="think-content">' + renderMdBasic(thinkContent) + '</div>' +
      '</details>' +
      (after ? renderMd(after) : '');
  }

  // Incomplete block (should not occur after stream)
  return (before ? renderMdBasic(before) : '') +
    '<details class="think-block">' +
      '<summary><span class="think-toggle">▶</span><span class="think-label">🧠 Reasoning\u2026</span></summary>' +
      '<div class="think-content">' + renderMdBasic(afterOpen) + '</div>' +
    '</details>';
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

promptInput.focus();
</script>
</body>
</html>`;
    }
}
