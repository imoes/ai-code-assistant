import * as vscode from 'vscode';
import { AIEngine, ExecutedAction } from './aiEngine';
import { ActionHistory } from './actionHistory';
import { MCPClient } from './mcpClient';
import { FileManager } from './fileManager';
import { Logger } from './logger';
import { ConfirmFn, DiffMeta } from './confirm';

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
        | 'cancelGeneration';
    text?: string;
    requestId?: string;
    choice?: string;
}

/**
 * ChatPanel – öffnet den AI-Chat als Editor-Tab (WebviewPanel).
 *
 * Jede Instanz ist eine eigene Session mit eigenem Konversationsverlauf.
 * Mehrere Tabs können gleichzeitig geöffnet sein.
 */
export class ChatPanel {
    public static readonly viewType = 'aiAssistant.chatPanel';

    // Alle aktiven Chat-Tabs: sessionId → ChatPanel
    private static panels = new Map<string, ChatPanel>();
    private static nextId = 1;

    /** Modus-Änderung an alle offenen Tabs senden */
    static broadcastModeChange(isAuto: boolean): void {
        for (const p of ChatPanel.panels.values()) {
            p.post({ type: 'modeChanged', isAuto });
        }
    }

    private readonly panel: vscode.WebviewPanel;
    private readonly sessionId: string;
    private readonly aiEngine: AIEngine;
    private readonly actionHistory = ActionHistory.getInstance();
    private readonly logger = Logger.getInstance();
    private readonly fileManager = FileManager.getInstance();
    private pendingConfirmations = new Map<string, (choice: string) => void>();
    /** Diff-Daten pro requestId für den "In Editor öffnen"-Button */
    private pendingDiffs = new Map<string, DiffMeta>();
    private disposables: vscode.Disposable[] = [];

    private constructor(
        extensionUri: vscode.Uri,
        sessionId: string,
        column: vscode.ViewColumn
    ) {
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

        // Nachrichten vom WebView
        this.panel.webview.onDidReceiveMessage(
            (msg: WebviewMessage) => this.handleMessage(msg),
            null,
            this.disposables
        );

        // Tab geschlossen → aufräumen
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.postSystem(`AI Chat Session #${sessionId} bereit.`);

        // Workspace scannen und Ergebnis im Chat anzeigen
        try {
            const root = this.fileManager.getWorkspaceRoot();
            const files = this.fileManager.listFiles();
            this.postSystem(`📁 Workspace: ${root} — ${files.length} Datei(en) gefunden`);
        } catch {
            this.postSystem('⚠ Kein Workspace geöffnet. Bitte einen Ordner öffnen.');
        }

        // Log-Kanal sofort einblenden (preserveFocus=true → Fokus bleibt im Editor)
        this.logger.show();
    }

    /**
     * Neuen Chat-Tab öffnen oder bestehenden fokussieren.
     * @param forceNew  true = immer neuen Tab erstellen
     */
    static open(extensionUri: vscode.Uri, forceNew = false): ChatPanel {
        // Letzten aktiven Tab wiederverwenden wenn nicht forceNew
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
                    await this.handleUserMessage(msg.text.trim());
                }
                break;

            case 'confirmResponse': {
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
                this.postSystem('↩ Letzte KI-Aktion rückgängig gemacht.');
                break;

            case 'undoAll':
                await this.actionHistory.undoAll();
                this.postSystem('↩ Alle KI-Aktionen rückgängig gemacht.');
                break;

            case 'resetConversation':
                this.aiEngine.resetConversation();
                for (const [, resolve] of this.pendingConfirmations) {
                    resolve('Ablehnen');
                }
                this.pendingConfirmations.clear();
                this.pendingDiffs.clear();
                this.postSystem('Konversation zurückgesetzt.');
                break;

            case 'openSettings':
                vscode.commands.executeCommand('workbench.action.openSettings', 'aiAssistant');
                break;

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
        this.post({ type: 'userMessage', text: userText });
        this.post({ type: 'thinking', value: true });

        const confirmFn = this.buildConfirmFn();

        try {
            let streamStarted = false;

            const result = await this.aiEngine.process(
                userText,
                (token: string, done: boolean) => {
                    if (!streamStarted) {
                        streamStarted = true;
                        this.post({ type: 'thinking', value: false });
                        this.post({ type: 'assistantMessageStart' });
                    }
                    if (!done) {
                        this.post({ type: 'assistantToken', text: token });
                    } else {
                        this.post({ type: 'assistantMessageEnd' });
                    }
                },
                confirmFn,
                (iteration: number, reason: string) => {
                    // Show repair iteration status in chat
                    this.post({ type: 'thinking', value: false });
                    this.post({ type: 'iterationMessage', iteration, reason });
                    this.post({ type: 'thinking', value: true });
                }
            );

            if (!streamStarted) {
                this.post({ type: 'thinking', value: false });
                if (result.text) {
                    this.post({ type: 'assistantMessage', text: result.text });
                }
            }

            if (result.actions.length > 0) {
                const title = result.iterations > 1
                    ? `Ausgeführte Aktionen (${result.iterations} Iterationen)`
                    : 'Ausgeführte Aktionen';
                this.post({ type: 'actions', actions: result.actions, title });
            }

            if (result.contextWarning) {
                this.post({ type: 'contextWarning', text: result.contextWarning });
            }

        } catch (err) {
            this.post({ type: 'thinking', value: false });
            const msg = err instanceof Error ? err.message : String(err);
            this.post({ type: 'errorMessage', text: msg });
            this.logger.error('Fehler bei KI-Verarbeitung', err);
        }
    }

    private async runConnectionTest(): Promise<void> {
        this.postSystem('Verbindung wird getestet...');
        const { success, info } = await MCPClient.getInstance().testConnection();
        const url = vscode.workspace.getConfiguration('aiAssistant')
            .get<string>('serverUrl', 'http://localhost:8080');
        this.postSystem(`${success ? '✅' : '❌'} llama.cpp (${url}): ${info}`);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // In-Chat Bestätigung
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
    // HTML (Editor-Tab optimiert: volle Breite, kein Sidebar-Rahmen)
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
    .mode-badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: 600;
      letter-spacing: .03em;
    }
    .mode-badge.auto   { background: rgba(255,180,0,.2);  color: #fc0; border: 1px solid rgba(255,180,0,.4); }
    .mode-badge.manual { background: rgba(100,180,255,.15); color: #8bf; border: 1px solid rgba(100,180,255,.3); }
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
    .msg-iteration {
      background: rgba(100,150,255,.08);
      border: 1px solid rgba(100,150,255,.25);
      border-radius: var(--radius);
      padding: 8px 14px;
      color: #88aaff;
      font-size: 12px;
      font-style: italic;
    }
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

    /* ── Bestätigungs-Karte ── */
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
  <button id="btn-test"     class="tb-btn">🔌 Verbindung</button>
  <button id="btn-reset"    class="tb-btn">🔄 Neu</button>
  <span class="tb-spacer"></span>
  <span id="mode-badge" class="mode-badge"></span>
  <button id="btn-undo"     class="tb-btn">↩ Undo</button>
  <button id="btn-undo-all" class="tb-btn danger">↩↩ Undo All</button>
  <button id="btn-log"      class="tb-btn">📋 Log</button>
  <button id="btn-settings" class="tb-btn">⚙</button>
</div>

<div id="pending-banner"></div>

<div id="chat"></div>

<div id="thinking">
  <div class="dot"></div><div class="dot"></div><div class="dot"></div>
  <span>KI denkt...</span>
  <button id="btn-abort">⏹ Abbrechen</button>
</div>

<div id="input-area">
  <div id="input-row">
    <textarea id="prompt-input"
      placeholder="Anweisung eingeben… (z.B. 'Erstelle eine REST API mit Express')"
      rows="1"></textarea>
    <button id="send-btn" title="Senden (Enter)">➤</button>
  </div>
  <div id="hint">Enter zum Senden &nbsp;·&nbsp; Shift+Enter für Zeilenumbruch</div>
</div>

<script nonce="${nonce}">
const vscode        = acquireVsCodeApi();
const chat          = document.getElementById('chat');
const promptInput   = document.getElementById('prompt-input');
const sendBtn       = document.getElementById('send-btn');
const thinking      = document.getElementById('thinking');
const pendingBanner = document.getElementById('pending-banner');
const modeBadge     = document.getElementById('mode-badge');

function setModeBadge(isAuto) {
  if (!modeBadge) return;
  if (isAuto) {
    modeBadge.className = 'mode-badge auto';
    modeBadge.textContent = '⚡ Auto';
    modeBadge.title = 'Automatischer Modus – KI führt Aktionen ohne Bestätigung aus';
  } else {
    modeBadge.className = 'mode-badge manual';
    modeBadge.textContent = '🔒 Manuell';
    modeBadge.title = 'Manueller Modus – jede Aktion wird bestätigt';
  }
}
// Initialen Modus aus dem data-Attribut lesen das beim Render eingebettet wurde
setModeBadge(${vscode.workspace.getConfiguration('aiAssistant').get<boolean>('autoApply', false)});

let isBusy = false;
let currentAssistantEl = null;
let pendingCount = 0;

// ── Toolbar (addEventListener – onclick-Attribute werden von CSP blockiert) ──
document.getElementById('btn-test')    .addEventListener('click', () => vscode.postMessage({type:'testConnection'}));
document.getElementById('btn-reset')   .addEventListener('click', () => vscode.postMessage({type:'resetConversation'}));
document.getElementById('btn-undo')    .addEventListener('click', () => vscode.postMessage({type:'undoLast'}));
document.getElementById('btn-undo-all').addEventListener('click', () => vscode.postMessage({type:'undoAll'}));
document.getElementById('btn-log')     .addEventListener('click', () => vscode.postMessage({type:'openLog'}));
document.getElementById('btn-settings').addEventListener('click', () => vscode.postMessage({type:'openSettings'}));
document.getElementById('btn-abort')   .addEventListener('click', () => vscode.postMessage({type:'cancelGeneration'}));

// ── Nachrichten vom Extension-Host ──────────────────────────────────────────
window.addEventListener('message', (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'userMessage':       append(makeUserMsg(msg.text)); break;
    case 'assistantMessage':
      append(makeAssistantMsg(msg.text));
      setThinking(false); setInputEnabled(true); break;
    case 'assistantMessageStart':
      currentAssistantEl = makeAssistantMsg('');
      currentAssistantEl.dataset.raw = '';
      append(currentAssistantEl); break;
    case 'assistantToken':
      if (currentAssistantEl) {
        currentAssistantEl.dataset.raw += msg.text;
        currentAssistantEl.innerHTML = renderMd(currentAssistantEl.dataset.raw);
        scrollBottom();
      } break;
    case 'assistantMessageEnd':
      currentAssistantEl = null; setThinking(false); setInputEnabled(true); break;
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
    case 'contextWarning':
      append(makeWarningMsg(msg.text)); break;
    case 'modeChanged':    setModeBadge(msg.isAuto); break;
    case 'confirmRequest':
      append(makeConfirmCard(
        msg.requestId, msg.message, msg.choices,
        msg.diffText, msg.hasDiff, msg.stats
      ));
      pendingCount++;
      updateBanner();
      scrollBottom(); break;
  }
});

// ── Bestätigungs-Karte mit farbigem Diff ────────────────────────────────────
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

    // Footer: Stats + "In Editor öffnen"-Button
    const footer = document.createElement('div');
    footer.className = 'diff-footer';

    const statsEl = document.createElement('span');
    if (stats) {
      statsEl.innerHTML =
        '<span style="color:#c66">−' + stats[0] + '</span> ' +
        '<span style="color:#6c6">+' + stats[1] + '</span> Zeilen';
    }
    footer.appendChild(statsEl);

    if (hasDiff) {
      const openBtn = document.createElement('button');
      openBtn.className = 'diff-open-btn';
      openBtn.textContent = '↗ In Editor öffnen';
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

// ── Farbiger Diff-Block aus unified-diff-String ──────────────────────────────
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
      '⏳ ' + pendingCount + ' Bestätigung' + (pendingCount > 1 ? 'en' : '') + ' ausstehend – scrolle nach unten';
    pendingBanner.style.display = 'flex';
  } else {
    pendingBanner.style.display = 'none';
    pendingBanner.className = '';
  }
}

// ── Senden ───────────────────────────────────────────────────────────────────
function submitPrompt() {
  const text = promptInput.value.trim();
  if (!text || isBusy) return;
  promptInput.value = '';
  autoResize();
  vscode.postMessage({ type: 'sendMessage', text });
  setInputEnabled(false);
}

sendBtn.addEventListener('click', submitPrompt);
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitPrompt(); }
});
promptInput.addEventListener('input', autoResize);

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
function makeWarningMsg(text) {
  const d = document.createElement('div');
  d.className = 'msg-warning';
  d.textContent = '⚠ ' + text;
  return d;
}
function makeActionsPanel(actions, title) {
  const p = document.createElement('div');
  p.className = 'actions-panel';
  const h = document.createElement('h4');
  h.textContent = title || 'Ausgeführte Aktionen'; p.appendChild(h);
  for (const a of actions) {
    const row = document.createElement('div');
    row.className = 'action-item';
    row.innerHTML = '<span class="' + (a.success ? 'action-ok' : 'action-fail') + '">' +
      (a.success ? '✅' : '❌') + '</span> ' + esc(a.description);
    p.appendChild(row);
    if (a.output) {
      const out = document.createElement('div');
      out.className = 'action-output'; out.textContent = a.output; p.appendChild(out);
    }
  }
  return p;
}

function append(el) { chat.appendChild(el); scrollBottom(); return el; }
function scrollBottom() { requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; }); }
function setThinking(v) { isBusy = v; thinking.classList.toggle('visible', v); if(v) scrollBottom(); }
function setInputEnabled(v) { isBusy = !v; promptInput.disabled = !v; sendBtn.disabled = !v; }

// ── Markdown + Reasoning-Blöcke ─────────────────────────────────────────────

/** Basis-Markdown ohne <think>-Handling */
function renderMdBasic(text) {
  if (!text) return '';
  let h = esc(text);
  h = h.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (_, _l, c) => '<pre><code>' + c + '</code></pre>');
  h = h.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  h = h.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  h = h.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
  h = h.replace(/\\n/g, '<br>');
  return h;
}

/**
 * Hauptfunktion: rendert Markdown und klappt <think>…</think>-Blöcke ein.
 * Während des Streamings (kein </think> sichtbar) bleibt der Block offen
 * und zeigt "Reasoning…". Sobald </think> erscheint, klappt er zu.
 */
function renderMd(text) {
  if (!text) return '';
  const thinkStart = text.indexOf('<think>');
  if (thinkStart === -1) return renderMdBasic(text);

  const parts = [];
  const before = text.slice(0, thinkStart);
  if (before) parts.push(renderMdBasic(before));

  const afterOpen = text.slice(thinkStart + 7);   // nach <think>
  const thinkEnd  = afterOpen.indexOf('</think>');

  if (thinkEnd !== -1) {
    // Vollständiger Block → eingeklappt
    const thinkContent = afterOpen.slice(0, thinkEnd);
    const after        = afterOpen.slice(thinkEnd + 8); // nach </think>
    parts.push(
      '<details class="think-block">' +
        '<summary><span class="think-toggle">▶</span>🧠 Reasoning</summary>' +
        '<div class="think-content">' + renderMdBasic(thinkContent) + '</div>' +
      '</details>'
    );
    if (after) parts.push(renderMd(after));  // weitere Blöcke möglich
  } else {
    // Noch kein </think> – Stream läuft noch → offen anzeigen
    parts.push(
      '<details class="think-block" open>' +
        '<summary><span class="think-toggle">▶</span>🧠 Reasoning\u2026</summary>' +
        '<div class="think-content">' + renderMdBasic(afterOpen) + '</div>' +
      '</details>'
    );
  }
  return parts.join('');
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
