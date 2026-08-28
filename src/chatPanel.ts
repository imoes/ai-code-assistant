import * as vscode from 'vscode';
import {
    AIEngine, ExecutedAction, PlanStep, AssistantMode, ActionMeta, getAssistantMode
} from './aiEngine';
import { SettingsPanel } from './settingsPanel';
import { ActionHistory } from './actionHistory';
import { MCPClient, GenerationStats } from './mcpClient';
import { FileManager } from './fileManager';
import { Logger } from './logger';
import { ConfirmFn, DiffMeta, AppliedChange } from './confirm';

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
        | 'clearHistory';
    text?: string;
    requestId?: string;
    choice?: string;
    mode?: AssistantMode;
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
    /** Diff-Daten pro requestId für den "In Editor öffnen"-Button */
    private pendingDiffs = new Map<string, DiffMeta>();
    /** Läuft gerade eine Aufgabe? Wird für "neue Aufgabe unterbricht" gebraucht. */
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

        // Tastaturfokus in das Panel holen.
        // Wird der Chat über die Befehlspalette geöffnet, gibt VS Code den Fokus
        // danach an die zuvor aktive Ansicht zurück (Explorer, andere Seitenleiste) –
        // man tippt dann ins Leere. reveal(preserveFocus=false) korrigiert das,
        // das Eingabefeld selbst fokussiert sich im WebView-Skript.
        // Verzögert, weil logger.show() das Panel-Layout noch umbaut.
        setTimeout(() => {
            if (ChatPanel.panels.has(this.sessionId)) {
                this.panel.reveal(column, false);
            }
        }, 150);
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
                    // Läuft noch eine Aufgabe? Dann diese abbrechen und die
                    // neue starten. Vorher war das Eingabefeld gesperrt und man
                    // kam zwischen den Iterationen nicht dazwischen.
                    if (this.runningTask) {
                        this.postSystem('⏹ Laufende Aufgabe abgebrochen – neue Aufgabe wird gestartet.');
                        this.aiEngine.cancel();
                        for (const [, resolve] of this.pendingConfirmations) {
                            resolve('Ablehnen');
                        }
                        this.pendingConfirmations.clear();
                        this.pendingDiffs.clear();
                        // Auf das Auslaufen der alten Schleife warten, sonst
                        // schreiben zwei Läufe gleichzeitig in den Verlauf.
                        try { await this.runningTask; } catch { /* egal */ }
                    }
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

            case 'clearHistory': {
                // Löscht die persistierte Historie – irreversibel, daher fragen.
                const answer = await vscode.window.showWarningMessage(
                    'Gesamten Chat-Verlauf löschen?\n'
                    + 'Alle gespeicherten Sessions in ai-code-assistant.json werden entfernt. '
                    + 'Bereits angewandte Codeänderungen bleiben bestehen.',
                    { modal: true },
                    'Verlauf löschen',
                    'Abbrechen'
                );
                if (answer !== 'Verlauf löschen') break;

                const removed = this.aiEngine.clearHistory();
                this.pendingConfirmations.clear();
                this.pendingDiffs.clear();
                this.post({ type: 'clearChat' });
                this.postSystem(`🗑 Verlauf gelöscht (${removed} Session(s)). Neue Session gestartet.`);
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
        // Den Lauf festhalten, damit eine neue Aufgabe darauf warten kann
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

        // Planänderungen der KI live als Checkliste im Chat anzeigen
        this.aiEngine.setPlanCallback((steps: PlanStep[]) => {
            this.post({ type: 'plan', steps });
        });

        // Jede angewandte Dateiänderung mit farbigem Diff zeigen.
        // Im Auto-Modus ist das der EINZIGE Weg, Änderungen zu sehen – dort
        // erscheint keine Bestätigungskarte.
        this.fileManager.setDiffReporter((change: AppliedChange) => {
            this.post({ type: 'fileDiff', change });
        });

        // Laufende Kennzahlen: Fortschritt der Prompt-Auswertung und Tokens/Sekunde.
        // Bei großen Kontexten dauert allein die Eingabe-Auswertung Minuten –
        // ohne diese Anzeige sieht der Benutzer nur "KI denkt…" und weiß nicht,
        // ob überhaupt etwas passiert.
        this.aiEngine.setStatsCallback((stats: GenerationStats) => {
            this.post({ type: 'stats', stats });
        });

        // Ansage jeder Runde im Chat zeigen. process() gibt nur den Text der
        // ersten Runde zurück – ohne diesen Weg stand ab Schritt 2 nur
        // "nächster Schritt…" da, ohne zu sagen, was der Assistent vorhat.
        // Eigener Nachrichtentyp, nicht 'assistantMessage': der gibt das
        // Eingabefeld wieder frei, und der Assistent arbeitet ja noch.
        this.aiEngine.setNarrationCallback((text: string) => {
            this.post({ type: 'narration', text });
        });

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
                    this.post({ type: 'thinking', value: false });
                    this.post({ type: 'iterationMessage', iteration, reason });
                    this.post({ type: 'thinking', value: true });
                },
                0,
                (description: string, output: string, meta?: ActionMeta) => {
                    // Aktion samt Ausgabe im Chat anzeigen. `meta` trägt
                    // Werkzeugname, Ziel und Zustand – ohne das steht in der
                    // Zeile nur "Aktion" und die ganze Beschreibung als Ziel.
                    this.post({ type: 'thinking', value: false });
                    this.post({ type: 'actionProgress', description, output, meta });
                    this.post({ type: 'thinking', value: true });
                }
            );

            if (!streamStarted) {
                if (result.text) {
                    this.post({ type: 'assistantMessage', text: result.text });
                }
            }

            if (result.actions.length > 0) {
                const title = result.iterations > 1
                    ? `Ausgeführte Aktionen (${result.iterations} Schritte)`
                    : 'Ausgeführte Aktionen';
                this.post({ type: 'actions', actions: this.summarizeActions(result.actions), title });
            }

            if (result.contextWarning) {
                this.post({ type: 'contextWarning', text: result.contextWarning });
            }

            // Immer am Ende sicherstellen dass Thinking aus und Input aktiv ist
            this.post({ type: 'thinking', value: false });
            this.post({ type: 'inputEnabled', value: true });

        } catch (err) {
            this.post({ type: 'thinking', value: false });
            this.post({ type: 'inputEnabled', value: true });
            const msg = err instanceof Error ? err.message : String(err);
            this.post({ type: 'errorMessage', text: msg });
            this.logger.error('Fehler bei KI-Verarbeitung', err);
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
                    output: `${a.output.slice(0, LIMIT)}\n… [${a.output.length - LIMIT} Zeichen gekürzt – vollständig im Log]`
                };
            }
            return a;
        });
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
    /* Der aktive Modus soll auf einen Blick erkennbar sein */
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
    /* ── Werkzeugzeile: eine Zeile pro Vorgang, Ausgabe darunter ── */
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

    /* ── Markdown im Antworttext ── */
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
    /* Sprachangabe des Code-Blocks als kleine Marke oben rechts */
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

    /* ── Kennzahlen unter der Eingabe ──
       Bewusst NICHT in der Denk-Leiste: die wird zwischen den Schritten der
       Agenten-Schleife aus- und wieder eingeschaltet, die Zahlen wären dann
       ständig weg. Hier bleiben sie über die ganze Aufgabe stehen. */
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

    /* ── Angewandte Änderung mit Diff ── */
    .diff-card {
      background: var(--bg-msg);
      border: 1px solid var(--border);
      border-left: 3px solid #6dbf6d;
      border-radius: var(--radius);
      padding: 8px 12px;
      font-size: 12px;
    }
    .diff-card.diffgelscht { border-left-color: #f77; }
    .diff-card.differstellt { border-left-color: #8bf; }
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
  <button id="btn-clear"    class="tb-btn danger">🗑 Verlauf löschen</button>
  <span class="tb-spacer"></span>
  <label id="mode-label" for="mode-select">Modus</label>
  <select id="mode-select" title="Arbeitsmodus des Assistenten">
    <option value="ask">🔒 Ask – jede Änderung bestätigen</option>
    <option value="auto">⚡ Auto – ohne Rückfragen</option>
    <option value="plan">📋 Plan – nur lesen und planen</option>
  </select>
  <button id="btn-undo"     class="tb-btn">↩ Undo</button>
  <button id="btn-undo-all" class="tb-btn danger">↩↩ Undo All</button>
  <button id="btn-log"      class="tb-btn">📋 Log</button>
  <button id="btn-settings" class="tb-btn">⚙</button>
</div>

<div id="pending-banner"></div>

<div id="chat"></div>

<div id="thinking">
  <div class="dot"></div><div class="dot"></div><div class="dot"></div>
  <span id="thinking-label">KI denkt...</span>
  <button id="btn-abort">⏹ Abbrechen</button>
</div>

<div id="input-area">
  <div id="input-row">
    <textarea id="prompt-input"
      placeholder="Anweisung eingeben… (z.B. 'Erstelle eine REST API mit Express')"
      rows="1"></textarea>
    <button id="send-btn" title="Senden (Enter)">➤</button>
  </div>
  <div id="input-footer">
    <span id="hint">Enter zum Senden &nbsp;·&nbsp; Shift+Enter für Zeilenumbruch</span>
    <span id="stats-bar">
      <span id="stats-progress"><span id="stats-progress-fill"></span></span>
      <span id="stats-text"></span>
    </span>
  </div>
</div>

<script nonce="${nonce}">
const vscode        = acquireVsCodeApi();
const chat          = document.getElementById('chat');
const promptInput   = document.getElementById('prompt-input');
const sendBtn       = document.getElementById('send-btn');
const thinking      = document.getElementById('thinking');
const pendingBanner = document.getElementById('pending-banner');
const hintEl        = document.getElementById('hint');
const modeSelect    = document.getElementById('mode-select');

const MODE_HINTS = {
  ask:  'Jede Dateiänderung und jeder Shell-Befehl wird im Chat bestätigt.',
  auto: 'Der Assistent arbeitet ohne Rückfragen durch. Alles bleibt per Undo rücknehmbar.',
  plan: 'Nur lesen und planen – Änderungen und Shell-Befehle sind gesperrt.'
};

function setMode(mode) {
  if (!modeSelect) return;
  const value = MODE_HINTS[mode] ? mode : 'ask';
  modeSelect.value = value;
  modeSelect.className = 'mode-' + value;
  modeSelect.title = MODE_HINTS[value];
}

// Aktueller Modus, beim Rendern eingesetzt
setMode('${getAssistantMode()}');

let isBusy = false;
let currentAssistantEl = null;
let pendingCount = 0;

// ── Toolbar (addEventListener – onclick-Attribute werden von CSP blockiert) ──
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

// ── Nachrichten vom Extension-Host ──────────────────────────────────────────
window.addEventListener('message', (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'userMessage':       resetPlan(); resetStats(); append(makeUserMsg(msg.text)); break;
    case 'plan':             renderPlan(msg.steps); break;
    case 'narration':        appendNarration(msg.text); break;
    case 'clearChat':        chat.innerHTML = ''; resetPlan(); resetStats(); break;
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
        updateAssistantEl(currentAssistantEl);
        scrollBottom();
      } break;
    case 'assistantMessageEnd':
      currentAssistantEl = null; setThinking(false); setInputEnabled(true); finalizeProgress(); break;
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
  // isBusy blockiert NICHT mehr: eine neue Aufgabe darf die laufende
  // unterbrechen. Das Abbrechen macht der Extension-Host.
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

// Eingabefeld beim Öffnen fokussieren – man will sofort tippen können.
// Auch nach einem Tab-Wechsel zurück, weil der Fokus dabei verloren geht.
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

// ── Kennzahlen: Prompt-Fortschritt und Tokens/Sekunde ───────────────────────
// Bei großen Kontexten dauert allein die Auswertung der Eingabe Minuten. Ohne
// diese Anzeige steht nur "KI denkt…" da und man weiß nicht, ob es haengt.
const statsBar      = document.getElementById('stats-bar');
const statsProgress = document.getElementById('stats-progress');
const statsFill     = document.getElementById('stats-progress-fill');
const statsText     = document.getElementById('stats-text');

function fmtNum(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n));
}

const thinkingLabel = document.getElementById('thinking-label');

/**
 * Beschriftung der Denk-Leiste an die aktuelle Phase anpassen.
 * "KI denkt…" sagt nichts – waehrend der Eingabe-Auswertung will man wissen,
 * dass gerechnet wird und wie weit.
 */
function setThinkingPhase(text) {
  if (thinkingLabel) thinkingLabel.textContent = text;
}

function renderStats(s) {
  if (!s || !statsBar) return;
  statsBar.classList.add('visible');

  const parts = [];

  // Waehrend der Prompt-Auswertung: Balken + Prozent
  const p = s.promptProgress;
  if (p && p.fraction < 1) {
    statsProgress.classList.add('visible');
    statsFill.style.width = Math.round(p.fraction * 100) + '%';
    const pct = Math.round(p.fraction * 100);
    parts.push('Eingabe ' + pct + '% (' + fmtNum(p.processed) + '/' + fmtNum(p.total) + ')');
    setThinkingPhase('Eingabe wird ausgewertet… ' + pct + '%');
  } else {
    statsProgress.classList.remove('visible');
    if (s.predictedTokens > 0) {
      setThinkingPhase('Antwort wird erzeugt… ' + fmtNum(s.predictedTokens) + ' Tok');
    }
  }

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

// Zeilen der laufenden Runde, nach Schluessel. Eine Map statt "nur die letzte
// Zeile": im Fenster-Lauf holte der Assistent zwei Seiten, und die erste Zeile
// blieb auf "laeuft..." stehen, waehrend die fertige Ausgabe eine zweite Zeile
// mit derselben Adresse bekam. Wer nur die letzte Zeile vergleicht, verliert
// jede Meldung, die nicht unmittelbar auf ihre Vorgaengerin folgt.
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
 * Ansage des Assistenten fuer eine Zwischenrunde.
 *
 * Bewusst nicht als 'assistantMessage': die gibt das Eingabefeld wieder frei,
 * und der Assistent arbeitet ja noch. Ausserdem beendet sie die laufende
 * Werkzeugzeile, damit die naechste Aktion eine neue bekommt.
 */
function appendNarration(text) {
  if (!text || !String(text).trim()) return;
  finalizeProgress();
  append(makeAssistantMsg(text));
}

/** Wie viele Zeilen Ausgabe ohne Aufklappen zu sehen sind. */
const OUTPUT_PREVIEW_LINES = 4;

/**
 * Ausgabe einer Aktion einsetzen: die ersten Zeilen sichtbar, der Rest hinter
 * einem Schalter. Ohne Kuerzung schiebt eine Testausgabe alles andere weg.
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
  more.textContent = '▸ ' + rest + ' weitere Zeilen';
  let open = false;
  more.addEventListener('click', () => {
    open = !open;
    pre.textContent = open ? clean : lines.slice(0, OUTPUT_PREVIEW_LINES).join('\\n');
    more.textContent = (open ? '▾ ' : '▸ ') + rest + ' weitere Zeilen';
    scrollBottom();
  });
  box.appendChild(more);
}

/**
 * Eine Werkzeugzeile bauen: Punkt, Werkzeugname, Ziel, Zusatz.
 * Bewusst wie eine Terminalzeile – eine Zeile pro Vorgang, Ausgabe darunter.
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
  name.textContent = (meta && meta.tool) || 'Aktion';
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

/** Zustand einer Werkzeugzeile setzen: läuft / erfolgreich / fehlgeschlagen. */
function styleToolRow(row, meta) {
  const state = !meta ? 'ok'
    : meta.running ? 'running'
    : meta.ok === false ? 'fail' : 'ok';
  row.className = 'tool-row tool-' + state;

  const detail = row.querySelector('.tool-detail');
  if (detail) {
    detail.textContent = (meta && meta.detail) ? meta.detail
      : (meta && meta.running) ? 'läuft…' : '';
  }
}

function appendOrUpdateProgress(description, output, meta) {
  const key = progressKey((meta && meta.tool ? meta.tool + ' ' : '') + description);

  // Derselbe Vorgang aktualisiert seine Zeile, auch wenn zwischendurch eine
  // andere Aktion gemeldet wurde. Zwei verschiedene Vorgaenge bekommen zwei
  // Zeilen - ohne diese Unterscheidung ueberschrieb jede Meldung die vorherige
  // und man sah am Ende nur eine einzige Zeile.
  const known = progressRows.get(key);
  if (known) {
    styleToolRow(known, meta);
    fillOutput(known.querySelector('.tool-output'), output);
    scrollBottom();
    return;
  }

  const row = buildToolRow(meta, description);
  row.dataset.key = key;
  styleToolRow(row, meta);
  fillOutput(row.querySelector('.tool-output'), output);

  progressRows.set(key, row);
  lastProgressEl = row;
  append(row);
}

// ── Angewandte Dateiänderung mit farbigem Diff ──────────────────────────────
// Im Auto-Modus gibt es keine Bestätigungskarte – ohne diese Anzeige würde man
// nie sehen, was der Assistent geändert hat.
function renderFileDiff(change) {
  if (!change) return;

  const card = document.createElement('div');
  card.className = 'diff-card diff-' + change.kind.replace(/[^a-z]/gi, '');

  const head = document.createElement('div');
  head.className = 'diff-card-head';
  const [removed, added] = change.stats || [0, 0];
  const icon = change.kind === 'erstellt' ? '📄'
    : change.kind === 'gelöscht' ? '🗑' : '✏';
  head.textContent = icon + ' ' + change.path + '  ' + change.kind
    + '   −' + removed + ' / +' + added;
  card.appendChild(head);

  if (change.diffText) {
    const details = document.createElement('details');
    details.open = true;
    const summary = document.createElement('summary');
    summary.textContent = 'Diff anzeigen';
    details.appendChild(summary);
    details.appendChild(buildDiffView(change.diffText));
    card.appendChild(details);
  }

  append(card);
}

// Abschnitt beenden: die bisherigen Werkzeugzeilen bleiben stehen, aber eine
// gleichnamige Aktion danach bekommt eine neue Zeile - ein zweites "npm test"
// nach einer Aenderung ist ein neuer Vorgang und kein Nachtrag zum ersten.
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

// ── Arbeitsplan (Todo-Liste der KI) ─────────────────────────────────────────
// Es gibt immer nur EINE Plan-Karte pro Aufgabe: sie wird an ihrer Stelle
// aktualisiert, damit man den Fortschritt verfolgt statt zehn Kopien zu sehen.
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

/** Plan-Karte freigeben, damit die nächste Aufgabe eine neue erhält. */
function resetPlan() { planEl = null; }
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
// Der Denk-Zustand SPERRT die Eingabe nicht mehr: der Benutzer soll zwischen
// den Iterationen eine neue Aufgabe schicken koennen. Enter unterbricht die
// laufende Aufgabe dann und startet die neue.
function setThinking(v) {
  isBusy = v;
  thinking.classList.toggle("visible", v);
  if (hintEl) hintEl.textContent = v
    ? "Enter unterbricht die laufende Aufgabe und startet die neue"
    : "Enter zum Senden \\u00b7 Shift+Enter f\\u00fcr Zeilenumbruch";
  if (v) scrollBottom();
}
function setInputEnabled(v) {
  // Eingabe und Senden bleiben immer bedienbar
  promptInput.disabled = false;
  sendBtn.disabled = false;
  if (v) isBusy = false;
}

// ── Markdown + Reasoning-Blöcke ─────────────────────────────────────────────

/** Basis-Markdown ohne <think>-Handling */
function renderMdBasic(text) {
  if (!text) return '';

  // Code-Bloecke zuerst herausnehmen und durch Platzhalter ersetzen.
  // Sonst wuerde die Zeilenverarbeitung darin Listen und Ueberschriften sehen.
  const blocks = [];
  let src = String(text).replace(/\\u0060\\u0060\\u0060([\\w+-]*)[ \\t]*\\r?\\n([\\s\\S]*?)\\u0060\\u0060\\u0060/g,
    (_m, lang, code) => {
      const i = blocks.length;
      blocks.push({ lang: lang || '', code: code });
      return '\\u0000BLOCK' + i + '\\u0000';
    });

  // Unvollstaendiger Block (Streaming laeuft noch): Rest als Code zeigen,
  // damit der Text nicht als Markdown zerfaellt und dann umspringt.
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
  // Eine Leerzeile beendet den Absatz. Ohne dieses Merkmal wuerden zwei durch
  // eine Leerzeile getrennte Absaetze zu einem verschmelzen.
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
    // Markdown-Links; nur http(s), damit kein javascript: durchkommt
    h = h.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return h;
  };

  const lines = src.split('\\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    // Platzhalter fuer einen Code-Block
    const ph = /^\\u0000BLOCK(\\d+)\\u0000$/.exec(t);
    if (ph) {
      closeList();
      const b = blocks[Number(ph[1])];
      out.push('<pre' + (b.lang ? ' data-lang="' + esc(b.lang) + '"' : '') +
        '><code>' + esc(b.code.replace(/\\s+$/, '')) + '</code></pre>');
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
      // Trennzeile (|---|---|) gehoert zur Tabelle, wird aber nicht gezeigt
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
 * Aktualisiert ein Assistenten-Element inkrementell während des Streamings.
 * Das <details>-Element wird nur einmal erstellt und danach nie mehr ersetzt,
 * damit der Benutzer es ein-/ausklappen kann ohne dass es zurückgesetzt wird.
 */
function updateAssistantEl(el) {
  const raw = el.dataset.raw || '';
  const thinkStart = raw.indexOf('<think>');

  if (thinkStart === -1) {
    // Kein Reasoning-Block → einfaches Rendering
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

    // Scroll wenn Benutzer manuell aufklappt
    details.addEventListener('toggle', () => {
      if (details.open) requestAnimationFrame(() => {
        details.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
  }

  // Nur Inhalt aktualisieren – open-Status bleibt erhalten
  const contentEl = el.querySelector('.think-content');
  if (contentEl) contentEl.innerHTML = renderMdBasic(thinkText);

  // Umfang in der Kopfzeile: auch zugeklappt soll man sehen, dass (und wie
  // viel) gedacht wird. Sonst wirkt ein zugeklappter Block wie nichts.
  const metaEl = el.querySelector('.think-meta');
  if (metaEl) {
    const lines = thinkText ? thinkText.split('\\n').length : 0;
    metaEl.textContent = isStreaming ? ' · denkt… ' + lines + ' Z.' : ' · ' + lines + ' Z.';
  }

  // Wenn Streaming fertig: einklappen (außer Benutzer hat manuell geöffnet)
  if (!isStreaming) {
    const label = el.querySelector('.think-label');
    if (label) label.textContent = '🧠 Reasoning';

    // Kein automatisches Ein- oder Ausklappen: der Zustand gehoert dem Benutzer.
    // Vorher wurde hier beim Fertigwerden wieder zugeklappt - das hat gegen
    // jeden Klick gearbeitet, den der Benutzer waehrend des Denkens gemacht hat.

    // Text nach </think> rendern
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

/** Für nicht-gestreamte Nachrichten: statisches Rendering */
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

  // Unvollständiger Block (sollte nach Stream nicht mehr vorkommen)
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
