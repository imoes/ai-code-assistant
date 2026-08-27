import * as vscode from 'vscode';
import { MCPClient } from './mcpClient';
import { Logger } from './logger';

/** Ein Eingabefeld im Einstellungs-Panel. */
interface FieldDef {
    /** Schlüssel ohne "aiAssistant."-Präfix */
    key: string;
    label: string;
    kind: 'text' | 'password' | 'number' | 'boolean' | 'textarea' | 'list' | 'select';
    hint?: string;
    /** Nur für kind: 'number' */
    min?: number;
    max?: number;
    /** Nur für kind: 'select' – Wert und Beschriftung je Option */
    options?: { value: string; label: string }[];
}

interface SectionDef {
    title: string;
    hint?: string;
    fields: FieldDef[];
}

/**
 * SettingsPanel – Einstellungen als eigenes Formular mit Speichern-Button.
 *
 * VS Code speichert in seinem eigenen Einstellungs-UI bei jedem Tastendruck.
 * Hier werden Änderungen erst gesammelt und beim Klick auf "Speichern"
 * gemeinsam übernommen – dadurch lässt sich z.B. ein API-Key vollständig
 * eintippen, ohne dass halbfertige Werte gespeichert werden.
 */
export class SettingsPanel {
    public static readonly viewType = 'aiAssistant.settingsPanel';
    private static current: SettingsPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly logger = Logger.getInstance();
    private disposables: vscode.Disposable[] = [];

    private static readonly SECTIONS: SectionDef[] = [
        {
            title: '🔌 Verbindung',
            hint: 'Lokaler llama.cpp-Server oder ein OpenAI-kompatibler Cloud-Anbieter.',
            fields: [
                {
                    key: 'serverUrl', label: 'Server-URL', kind: 'text',
                    hint: 'llama.cpp: http://localhost:8080 · OpenRouter: https://openrouter.ai/api'
                },
                {
                    key: 'apiKey', label: 'API-Key (optional)', kind: 'password',
                    hint: 'Nur für Cloud-Anbieter. Lokaler llama.cpp-Server: leer lassen. '
                        + 'Wird als "Authorization: Bearer <key>" gesendet.'
                },
                {
                    key: 'model', label: 'Modell', kind: 'text',
                    hint: 'Leer = Serverstandard. OpenRouter z.B. anthropic/claude-sonnet-4.5'
                },
                {
                    key: 'mcpEnabled', label: 'llama.cpp MCP-Protokoll verwenden', kind: 'boolean',
                    hint: 'Bei Cloud-Anbietern mit API-Key wird automatisch die OpenAI-API genutzt.'
                },
                {
                    key: 'nativeToolCalls', label: 'Werkzeuge über die Server-API (empfohlen)', kind: 'boolean',
                    hint: 'Der Server übernimmt das modellspezifische Format – so läuft der Assistent '
                        + 'mit Qwen, Gemma, Kimi, laguna, DeepSeek und Mistral gleichermaßen. '
                        + 'Bei llama.cpp ist dafür --jinja nötig. Aus = Aufrufe werden aus dem Text geparst.'
                }
            ]
        },
        {
            title: '🤖 Agent',
            hint: 'Wie selbständig der Assistent arbeitet.',
            fields: [
                {
                    key: 'mode', label: 'Arbeitsmodus', kind: 'select',
                    options: [
                        { value: 'ask', label: '🔒 Ask – jede Änderung bestätigen' },
                        { value: 'auto', label: '⚡ Auto – ohne Rückfragen' },
                        { value: 'plan', label: '📋 Plan – nur lesen und planen' }
                    ],
                    hint: 'Ask: jede Dateiänderung und jeder Shell-Befehl wird im Chat bestätigt. '
                        + 'Auto: der Assistent arbeitet durch (alles per Undo rücknehmbar). '
                        + 'Plan: nur Analyse und Plan, Änderungen sind gesperrt.'
                },
                {
                    key: 'agentLoop', label: 'Agenten-Schleife', kind: 'boolean',
                    hint: 'Analysieren → planen → ändern → testen → korrigieren, bis die Aufgabe erledigt ist.'
                },
                {
                    key: 'maxAgentSteps', label: 'Max. Schritte pro Aufgabe', kind: 'number',
                    min: 1, max: 50
                },
                {
                    key: 'planningEnabled', label: 'Planung (Todo-Liste)', kind: 'boolean',
                    hint: 'Bei mehrschrittigen Aufgaben erst einen Plan erstellen, dann abarbeiten.'
                },
                {
                    key: 'autoAnalyze', label: 'Erst analysieren, dann schreiben', kind: 'boolean',
                    hint: 'Bestehenden Code mit read_file/grep/glob prüfen, bevor er geändert wird.'
                }
            ]
        },
        {
            title: '🧪 Tests & Korrektur',
            fields: [
                {
                    key: 'autoTest', label: 'Nach Änderungen automatisch testen', kind: 'boolean',
                    hint: 'Der Assistent erkennt den Testbefehl (npm test, pytest, cargo test …) selbst.'
                },
                { key: 'autoFixOnError', label: 'Fehler automatisch korrigieren', kind: 'boolean' },
                {
                    key: 'autoFixIterations', label: 'Max. Korrektur-Durchläufe', kind: 'number',
                    min: 1, max: 10
                }
            ]
        },
        {
            title: '🔒 Sicherheit',
            fields: [
                { key: 'allowShellCommands', label: 'Shell-Befehle erlauben (WSL)', kind: 'boolean' },
                { key: 'confirmDangerousOps', label: 'Vor gefährlichen Operationen warnen', kind: 'boolean' }
            ]
        },
        {
            title: '⚙ Modell-Parameter',
            fields: [
                { key: 'maxTokens', label: 'Max. Tokens pro Antwort', kind: 'number', min: 128, max: 200000 },
                {
                    key: 'temperature', label: 'Temperature', kind: 'number', min: 0, max: 2,
                    hint: '0 = deterministisch, 2 = sehr kreativ. Für Code: 0.1 – 0.3'
                },
                {
                    key: 'contextWarningThreshold', label: 'Kontext-Warnung ab (Token)', kind: 'number',
                    min: 1000, max: 1000000
                }
            ]
        },
        {
            title: '📄 Projekt-Anweisungen',
            hint: 'Dateien, die bei jeder Anfrage als permanente Regeln geladen werden.',
            fields: [
                {
                    key: 'instructionFiles', label: 'Anweisungsdateien', kind: 'list',
                    hint: 'Eine pro Zeile, relativ zum Workspace. Nicht vorhandene werden übersprungen.'
                },
                { key: 'systemPrompt', label: 'System-Prompt', kind: 'textarea' }
            ]
        }
    ];

    private constructor(extensionUri: vscode.Uri) {
        this.panel = vscode.window.createWebviewPanel(
            SettingsPanel.viewType,
            'AI Assistant – Einstellungen',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] }
        );
        this.panel.iconPath = new vscode.ThemeIcon('settings-gear');
        this.panel.webview.html = this.buildHtml(this.panel.webview);

        this.panel.webview.onDidReceiveMessage(
            (msg) => this.handleMessage(msg),
            null,
            this.disposables
        );
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    /** Panel öffnen bzw. bestehendes in den Vordergrund holen. */
    static open(extensionUri: vscode.Uri): SettingsPanel {
        if (SettingsPanel.current) {
            SettingsPanel.current.panel.reveal(vscode.ViewColumn.Active);
            return SettingsPanel.current;
        }
        SettingsPanel.current = new SettingsPanel(extensionUri);
        return SettingsPanel.current;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Nachrichten vom WebView
    // ──────────────────────────────────────────────────────────────────────────

    private async handleMessage(msg: {
        type: string;
        values?: Record<string, unknown>;
    }): Promise<void> {
        switch (msg.type) {
            case 'save':
                await this.save(msg.values ?? {});
                break;
            case 'reload':
                this.panel.webview.postMessage({ type: 'values', values: this.readValues() });
                break;
            case 'testConnection': {
                this.panel.webview.postMessage({ type: 'testing' });
                const { success, info } = await MCPClient.getInstance().testConnection();
                this.panel.webview.postMessage({ type: 'testResult', success, info });
                break;
            }
            case 'openRawSettings':
                vscode.commands.executeCommand('workbench.action.openSettings', 'aiAssistant');
                break;
        }
    }

    /**
     * Alle Felder in die VS-Code-Konfiguration schreiben.
     *
     * Geschrieben wird in den Workspace-Bereich, wenn ein Ordner geöffnet ist –
     * sonst global. So bleiben projektspezifische Modelle/Keys beim Projekt.
     */
    private async save(values: Record<string, unknown>): Promise<void> {
        const config = vscode.workspace.getConfiguration('aiAssistant');
        const target = vscode.workspace.workspaceFolders?.length
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;

        const changed: string[] = [];
        const failed: string[] = [];

        for (const section of SettingsPanel.SECTIONS) {
            for (const field of section.fields) {
                if (!(field.key in values)) continue;
                const value = this.coerce(field, values[field.key]);
                const current = config.get(field.key);
                if (JSON.stringify(current) === JSON.stringify(value)) continue;
                try {
                    await config.update(field.key, value, target);
                    changed.push(field.key);
                } catch (err) {
                    failed.push(`${field.key}: ${(err as Error).message}`);
                    this.logger.error(`Einstellung "${field.key}" konnte nicht gespeichert werden`, err);
                }
            }
        }

        if (failed.length > 0) {
            this.panel.webview.postMessage({
                type: 'saved', success: false,
                info: `${failed.length} Einstellung(en) fehlgeschlagen:\n${failed.join('\n')}`
            });
            return;
        }

        const scope = target === vscode.ConfigurationTarget.Workspace ? 'Workspace' : 'global';
        const info = changed.length === 0
            ? 'Keine Änderungen – alles bereits gespeichert.'
            : `${changed.length} Einstellung(en) gespeichert (${scope}): ${changed.join(', ')}`;

        this.logger.info(`Einstellungen gespeichert: ${changed.join(', ') || '(keine Änderung)'}`);
        this.panel.webview.postMessage({ type: 'saved', success: true, info });

        // Modus-Listbox in allen offenen Chat-Tabs aktualisieren
        if (changed.includes('mode') || changed.includes('autoApply')) {
            const { ChatPanel } = require('./chatPanel') as typeof import('./chatPanel');
            const { getAssistantMode } = require('./aiEngine') as typeof import('./aiEngine');
            ChatPanel.broadcastModeChange(getAssistantMode());
        }
    }

    /** Rohwert aus dem Formular in den erwarteten Konfigurationstyp wandeln. */
    private coerce(field: FieldDef, raw: unknown): unknown {
        switch (field.kind) {
            case 'boolean':
                return raw === true || raw === 'true';
            case 'number': {
                const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
                if (isNaN(n)) return vscode.workspace.getConfiguration('aiAssistant').get(field.key);
                const clampedLow = field.min !== undefined ? Math.max(field.min, n) : n;
                return field.max !== undefined ? Math.min(field.max, clampedLow) : clampedLow;
            }
            case 'list':
                return String(raw ?? '')
                    .split('\n')
                    .map(s => s.trim())
                    .filter(Boolean);
            default:
                return String(raw ?? '').trim();
        }
    }

    /** Aktuelle Werte aller Felder aus der Konfiguration lesen. */
    private readValues(): Record<string, unknown> {
        const config = vscode.workspace.getConfiguration('aiAssistant');
        const out: Record<string, unknown> = {};
        for (const section of SettingsPanel.SECTIONS) {
            for (const field of section.fields) {
                const value = config.get(field.key);
                out[field.key] = field.kind === 'list' && Array.isArray(value)
                    ? value.join('\n')
                    : value;
            }
        }
        return out;
    }

    private dispose(): void {
        SettingsPanel.current = undefined;
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }

    // ──────────────────────────────────────────────────────────────────────────
    // HTML
    // ──────────────────────────────────────────────────────────────────────────

    private buildHtml(webview: vscode.Webview): string {
        const nonce = Array.from({ length: 16 }, () => Math.random().toString(36)[2]).join('');
        const csp = [
            `default-src 'none'`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`
        ].join('; ');

        const values = this.readValues();
        const esc = (s: string) => s
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        const renderField = (f: FieldDef): string => {
            const v = values[f.key];
            const hint = f.hint ? `<div class="hint">${esc(f.hint)}</div>` : '';

            if (f.kind === 'boolean') {
                return `
                <div class="field checkbox-field">
                  <label class="cb">
                    <input type="checkbox" data-key="${f.key}" ${v ? 'checked' : ''}>
                    <span>${esc(f.label)}</span>
                  </label>
                  ${hint}
                </div>`;
            }

            if (f.kind === 'select') {
                const opts = (f.options ?? []).map(o =>
                    `<option value="${esc(o.value)}"${String(v) === o.value ? ' selected' : ''}>` +
                    `${esc(o.label)}</option>`).join('');
                return `
                <div class="field">
                  <label>${esc(f.label)}</label>
                  <div class="input-row"><select data-key="${f.key}">${opts}</select></div>
                  ${hint}
                </div>`;
            }

            const inputEl = f.kind === 'textarea' || f.kind === 'list'
                ? `<textarea data-key="${f.key}" rows="${f.kind === 'list' ? 5 : 7}"
                       spellcheck="false">${esc(String(v ?? ''))}</textarea>`
                : `<input type="${f.kind === 'password' ? 'password' : f.kind === 'number' ? 'number' : 'text'}"
                       data-key="${f.key}"
                       ${f.min !== undefined ? `min="${f.min}"` : ''}
                       ${f.max !== undefined ? `max="${f.max}"` : ''}
                       ${f.kind === 'number' ? 'step="any"' : ''}
                       spellcheck="false"
                       value="${esc(String(v ?? ''))}">`;

            const reveal = f.kind === 'password'
                ? `<button class="reveal" data-reveal="${f.key}" title="Anzeigen/Verbergen">👁</button>`
                : '';

            return `
            <div class="field">
              <label>${esc(f.label)}</label>
              <div class="input-row">${inputEl}${reveal}</div>
              ${hint}
            </div>`;
        };

        const sectionsHtml = SettingsPanel.SECTIONS.map(s => `
          <section>
            <h2>${esc(s.title)}</h2>
            ${s.hint ? `<p class="section-hint">${esc(s.hint)}</p>` : ''}
            ${s.fields.map(renderField).join('')}
          </section>`).join('');

        return /* html */`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Assistant – Einstellungen</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:        var(--vscode-editor-background, #1e1e1e);
      --bg-card:   var(--vscode-editorWidget-background, #252526);
      --fg:        var(--vscode-editor-foreground, #d4d4d4);
      --fg-muted:  var(--vscode-descriptionForeground, #8a8a8a);
      --border:    var(--vscode-widget-border, #454545);
      --accent:    var(--vscode-button-background, #0e639c);
      --accent-fg: var(--vscode-button-foreground, #fff);
      --input-bg:  var(--vscode-input-background, #3c3c3c);
      --input-fg:  var(--vscode-input-foreground, #ccc);
      --font:      var(--vscode-font-family, 'Segoe UI', sans-serif);
      --font-mono: var(--vscode-editor-font-family, Consolas, monospace);
      --size:      var(--vscode-font-size, 13px);
    }
    body {
      font-family: var(--font); font-size: var(--size);
      color: var(--fg); background: var(--bg);
      display: flex; flex-direction: column; height: 100vh; overflow: hidden;
    }
    #content { flex: 1; overflow-y: auto; padding: 20px 24px 32px; max-width: 820px; width: 100%; }
    h1 { font-size: 1.35em; font-weight: 600; margin-bottom: 4px; }
    #subtitle { color: var(--fg-muted); font-size: .92em; margin-bottom: 22px; }
    section {
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 8px; padding: 16px 18px; margin-bottom: 16px;
    }
    h2 { font-size: 1.02em; font-weight: 600; margin-bottom: 4px; }
    .section-hint { color: var(--fg-muted); font-size: .88em; margin-bottom: 14px; }
    .field { margin-top: 14px; }
    .field:first-of-type { margin-top: 10px; }
    label { display: block; font-weight: 500; margin-bottom: 5px; }
    .input-row { display: flex; gap: 6px; align-items: stretch; }
    input[type=text], input[type=password], input[type=number], textarea, select {
      flex: 1; width: 100%;
      background: var(--input-bg); color: var(--input-fg);
      border: 1px solid var(--border); border-radius: 4px;
      padding: 7px 9px; font-family: var(--font); font-size: var(--size);
    }
    select {
      background: var(--vscode-dropdown-background, var(--input-bg));
      color: var(--vscode-dropdown-foreground, var(--input-fg));
      cursor: pointer;
    }
    textarea { font-family: var(--font-mono); resize: vertical; line-height: 1.5; }
    input:focus, textarea:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
    .reveal {
      background: transparent; color: var(--fg-muted); border: 1px solid var(--border);
      border-radius: 4px; padding: 0 10px; cursor: pointer; font-size: 13px;
    }
    .reveal:hover { color: var(--fg); border-color: var(--accent); }
    .checkbox-field { margin-top: 12px; }
    .cb { display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: 500; margin: 0; }
    .cb input { width: 15px; height: 15px; accent-color: var(--accent); cursor: pointer; }
    .hint { color: var(--fg-muted); font-size: .85em; margin-top: 4px; line-height: 1.45; }
    .checkbox-field .hint { margin-left: 23px; }

    #footer {
      flex-shrink: 0; display: flex; align-items: center; gap: 10px;
      padding: 12px 24px; background: var(--bg-card);
      border-top: 1px solid var(--border);
    }
    button.primary {
      background: var(--accent); color: var(--accent-fg); border: none;
      border-radius: 4px; padding: 8px 20px; font-size: var(--size);
      font-weight: 600; font-family: var(--font); cursor: pointer;
    }
    button.primary:hover:not(:disabled) { opacity: .88; }
    button.primary:disabled { opacity: .5; cursor: default; }
    button.ghost {
      background: transparent; color: var(--fg-muted);
      border: 1px solid var(--border); border-radius: 4px;
      padding: 8px 14px; font-size: var(--size); font-family: var(--font); cursor: pointer;
    }
    button.ghost:hover { color: var(--fg); border-color: var(--accent); }
    .spacer { flex: 1; }
    #status { font-size: .88em; white-space: pre-wrap; max-width: 46%; line-height: 1.4; }
    #status.ok   { color: #6cc16c; }
    #status.err  { color: #f77; }
    #status.busy { color: var(--fg-muted); }
    #dirty-dot {
      width: 7px; height: 7px; border-radius: 50%; background: #fc0;
      display: none; flex-shrink: 0;
    }
    #dirty-dot.on { display: block; }
  </style>
</head>
<body>

<div id="content">
  <h1>AI Assistant – Einstellungen</h1>
  <div id="subtitle">Änderungen werden erst mit <strong>Speichern</strong> übernommen.</div>
  ${sectionsHtml}
</div>

<div id="footer">
  <button id="btn-save" class="primary">💾 Speichern</button>
  <span id="dirty-dot" title="Nicht gespeicherte Änderungen"></span>
  <button id="btn-test" class="ghost">🔌 Verbindung testen</button>
  <button id="btn-reset" class="ghost">↺ Verwerfen</button>
  <span class="spacer"></span>
  <span id="status"></span>
  <button id="btn-raw" class="ghost">VS Code JSON…</button>
</div>

<script nonce="${nonce}">
const vscode  = acquireVsCodeApi();
const status  = document.getElementById('status');
const saveBtn = document.getElementById('btn-save');
const dot     = document.getElementById('dirty-dot');

function fields() { return Array.from(document.querySelectorAll('[data-key]')); }

function collect() {
  const out = {};
  for (const el of fields()) {
    out[el.dataset.key] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

function setStatus(text, cls) {
  status.textContent = text || '';
  status.className = cls || '';
}

let dirty = false;
function markDirty() {
  dirty = true;
  dot.classList.add('on');
  setStatus('Nicht gespeichert – Strg+S oder Speichern klicken.', 'busy');
}
function clearDirty() {
  dirty = false;
  dot.classList.remove('on');
}

for (const el of fields()) {
  el.addEventListener('input',  markDirty);
  el.addEventListener('change', markDirty);
}

function save() {
  saveBtn.disabled = true;
  setStatus('Speichern…', 'busy');
  vscode.postMessage({ type: 'save', values: collect() });
}

saveBtn.addEventListener('click', save);
document.getElementById('btn-test').addEventListener('click', () => {
  // Erst speichern, dann testen – sonst würde die alte URL getestet
  if (dirty) { vscode.postMessage({ type: 'save', values: collect() }); }
  setStatus('Verbindung wird getestet…', 'busy');
  vscode.postMessage({ type: 'testConnection' });
});
document.getElementById('btn-reset').addEventListener('click', () => {
  vscode.postMessage({ type: 'reload' });
});
document.getElementById('btn-raw').addEventListener('click', () => {
  vscode.postMessage({ type: 'openRawSettings' });
});

// Passwort-Felder ein-/ausblenden
for (const btn of document.querySelectorAll('[data-reveal]')) {
  btn.addEventListener('click', () => {
    const input = document.querySelector('[data-key="' + btn.dataset.reveal + '"]');
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
  });
}

// Strg+S speichert
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
});

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'saved':
      saveBtn.disabled = false;
      if (msg.success) { clearDirty(); setStatus('✅ ' + msg.info, 'ok'); }
      else { setStatus('❌ ' + msg.info, 'err'); }
      break;
    case 'testing':
      setStatus('Verbindung wird getestet…', 'busy');
      break;
    case 'testResult':
      setStatus((msg.success ? '✅ ' : '❌ ') + msg.info, msg.success ? 'ok' : 'err');
      break;
    case 'values':
      for (const el of fields()) {
        const v = msg.values[el.dataset.key];
        if (el.type === 'checkbox') el.checked = !!v;
        else el.value = v === undefined || v === null ? '' : String(v);
      }
      clearDirty();
      setStatus('Änderungen verworfen – gespeicherte Werte geladen.', 'busy');
      break;
  }
});
</script>
</body>
</html>`;
    }
}
