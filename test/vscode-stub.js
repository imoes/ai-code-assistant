// Minimaler vscode-Stub, damit die kompilierte Extension außerhalb von VS Code
// getestet werden kann. Nur die Teile, die AIEngine/CodeAnalyzer wirklich nutzen.
const path = require('path');

const WORKSPACE = process.env.TEST_WORKSPACE || path.resolve(__dirname, '..', '..', '..', '..', '..', '..', '..');

const settings = {
    serverUrl: 'http://localhost:8080',
    apiKey: '',
    mcpEnabled: false,
    model: '',
    maxTokens: 4096,
    temperature: 0.2,
    mode: 'auto',
    autoApply: true,
    allowShellCommands: true,
    confirmDangerousOps: true,
    systemPrompt: 'Du bist ein erfahrener Software-Entwickler und AI Code Assistant.',
    autoTest: false,
    autoFixOnError: true,
    autoFixIterations: 3,
    contextWarningThreshold: 60000,
    agentLoop: true,
    maxAgentSteps: 12,
    planningEnabled: true,
    autoAnalyze: true,
    instructionFiles: ['AGENTS.md', 'CLAUDE.md', 'command.md', '.github/copilot-instructions.md']
};

// Welche Schlüssel als "ausdrücklich gesetzt" gelten (für config.inspect).
// getAssistantMode() prüft damit, ob mode explizit konfiguriert ist oder ob
// noch das alte autoApply gilt.
const explicitKeys = new Set(['mode']);

function makeConfig() {
    return {
        get: (key, def) => (settings[key] !== undefined ? settings[key] : def),
        update: async (key, value) => { settings[key] = value; explicitKeys.add(key); },
        inspect: (key) => ({
            key: 'aiAssistant.' + key,
            defaultValue: undefined,
            globalValue: explicitKeys.has(key) ? settings[key] : undefined,
            workspaceValue: undefined,
            workspaceFolderValue: undefined
        })
    };
}

const outputLines = [];

module.exports = {
    __settings: settings,
    __output: outputLines,
    __setExplicit: (key, on) => { if (on) explicitKeys.add(key); else explicitKeys.delete(key); },
    __setWorkspace: (p) => { module.exports.workspace.workspaceFolders = [{ uri: { fsPath: p } }]; },
    workspace: {
        workspaceFolders: [{ uri: { fsPath: WORKSPACE } }],
        getConfiguration: () => makeConfig(),
        onDidChangeConfiguration: () => ({ dispose() {} }),
        openTextDocument: async () => ({ getText: () => '' }),
        applyEdit: async () => true,
        fs: {}
    },
    window: {
        activeTextEditor: undefined,
        createOutputChannel: () => ({
            appendLine: (l) => outputLines.push(l),
            append: (l) => outputLines.push(l),
            show: () => {}, dispose: () => {}, clear: () => {}
        }),
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        showInputBox: async () => undefined,
        showTextDocument: async () => ({}),
        createStatusBarItem: () => ({ show() {}, dispose() {}, text: '', tooltip: '', command: '' }),
        createWebviewPanel: () => { throw new Error('WebView im Test nicht verfügbar'); },
        createTerminal: () => ({ show() {}, sendText() {}, dispose() {} }),
        withProgress: async (_o, fn) => fn({ report() {} }, { isCancellationRequested: false }),
        registerTreeDataProvider: () => ({ dispose() {} })
    },
    commands: {
        registerCommand: () => ({ dispose() {} }),
        executeCommand: async () => undefined
    },
    Uri: {
        file: (p) => ({ fsPath: p, path: p, scheme: 'file', toString: () => p }),
        parse: (p) => ({ fsPath: p, path: p, scheme: 'file', toString: () => p })
    },
    Range: class { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } },
    Position: class { constructor(l, c) { this.line = l; this.character = c; } },
    WorkspaceEdit: class { replace() {} insert() {} delete() {} },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    TreeItem: class { constructor(label) { this.label = label; } },
    EventEmitter: class {
        constructor() { this.event = () => ({ dispose() {} }); }
        fire() {} dispose() {}
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ViewColumn: { One: 1, Two: 2, Active: -1, Beside: -2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15, Window: 10 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    env: { openExternal: async () => true, clipboard: { writeText: async () => {} } }
};
