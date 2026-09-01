import * as vscode from 'vscode';
import { ChatPanel } from './chatPanel';
import { SettingsPanel } from './settingsPanel';
import { AssistantMode, getAssistantMode } from './aiEngine';
import { SidebarProvider } from './sidebarProvider';
import { ActionHistory } from './actionHistory';
import { MCPClient } from './mcpClient';
import { Logger } from './logger';
import { FileManager } from './fileManager';

export function activate(context: vscode.ExtensionContext): void {
    const logger = Logger.getInstance();
    logger.info('AI Code Assistant is activating...');

    // ── Sidebar (linke Leiste: Modus, Tests, neue Session) ────────────────────
    const sidebar = new SidebarProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('aiAssistant.sessionsView', sidebar)
    );

    // ── Open Chat-Tab ───────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('aiAssistant.openPanel', () => {
            ChatPanel.open(context.extensionUri, true);
        })
    );

    // ── Send selection from editor ───────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('aiAssistant.sendPrompt', async () => {
            const editor = vscode.window.activeTextEditor;
            let prefill = '';
            if (editor && !editor.selection.isEmpty) {
                const sel = editor.document.getText(editor.selection);
                const lang = editor.document.languageId;
                prefill = `Analyse and improve the following ${lang} code:\n\`\`\`${lang}\n${sel}\n\`\`\`\n\n`;
            }
            const input = await vscode.window.showInputBox({
                prompt: 'Enter an instruction for the AI',
                placeHolder: 'e.g. "Add unit tests", "Build a REST API"',
                value: prefill,
                ignoreFocusOut: true
            });
            if (input?.trim()) {
                ChatPanel.open(context.extensionUri, false);
            }
        })
    );

    // ── Arbeitsmodus setzen (ask / auto / plan) ──────────────────────────────
    const MODE_LABELS: Record<AssistantMode, string> = {
        ask: 'Ask 🔒 – every change is confirmed',
        auto: 'Auto ⚡ – no questions asked',
        plan: 'Plan 📋 – read and plan only'
    };

    const applyMode = async (mode: AssistantMode, notify = true) => {
        const config = vscode.workspace.getConfiguration('aiAssistant');
        // Workspace area, when a folder is open: the mode belongs to the
        // project, not to the installation.
        const target = vscode.workspace.workspaceFolders?.length
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
        await config.update('mode', mode, target);
        // Keep autoApply so that older queries remain consistent
        await config.update('autoApply', mode === 'auto', target);

        logger.info(`Arbeitsmodus gesetzt: ${mode}`);
        if (notify) {
            vscode.window.showInformationMessage(`AI Assistant Modus: ${MODE_LABELS[mode]}`);
        }
        sidebar.refresh();
        ChatPanel.broadcastModeChange(mode);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('aiAssistant.setMode', async (mode?: string) => {
            let target = mode as AssistantMode | undefined;

            if (target !== 'ask' && target !== 'auto' && target !== 'plan') {
                const picked = await vscode.window.showQuickPick(
                    (['ask', 'auto', 'plan'] as AssistantMode[]).map(m => ({
                        label: MODE_LABELS[m],
                        mode: m,
                        picked: m === getAssistantMode()
                    })),
                    { title: 'AI Assistant – working mode', placeHolder: 'Choose a mode' }
                );
                if (!picked) return;
                target = picked.mode;
            }

            await applyMode(target);
        })
    );

    // Old command: now cycles through all three modes
    context.subscriptions.push(
        vscode.commands.registerCommand('aiAssistant.toggleMode', async () => {
            const order: AssistantMode[] = ['ask', 'auto', 'plan'];
            const next = order[(order.indexOf(getAssistantMode()) + 1) % order.length];
            await applyMode(next);
        })
    );

    // ── Auto-Test umschalten ──────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('aiAssistant.toggleAutoTest', async () => {
            const config = vscode.workspace.getConfiguration('aiAssistant');
            const current = config.get<boolean>('autoTest', false);
            const newVal = !current;
            await config.update('autoTest', newVal, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                `Auto-Test: ${newVal ? 'Aktiviert 🧪' : 'Deaktiviert'}`
            );
            sidebar.refresh();
        })
    );

    // ── Open settings ──────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('aiAssistant.openSettings', () =>
            SettingsPanel.open(context.extensionUri)
        )
    );

    // ── Undo-Commands ─────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('aiAssistant.undoLastAction', () =>
            ActionHistory.getInstance().undoLast()
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('aiAssistant.undoAllActions', async () => {
            const answer = await vscode.window.showWarningMessage(
                'Undo every change the AI made?',
                { modal: true },
                'Yes, undo all',
                'Cancel'
            );
            if (answer === 'Yes, undo all') {
                await ActionHistory.getInstance().undoAll();
            }
        })
    );

    // ── Log & Verbindungstest ─────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('aiAssistant.showLog', () =>
            Logger.getInstance().show()
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('aiAssistant.testConnection', async () => {
            const url = vscode.workspace.getConfiguration('aiAssistant')
                .get<string>('serverUrl', 'http://localhost:8080');
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Connecting to ${url}…`, cancellable: false },
                async () => {
                    const { success, info } = await MCPClient.getInstance().testConnection();
                    if (success) {
                        vscode.window.showInformationMessage(`✅ llama.cpp erreichbar: ${info}`);
                    } else {
                        vscode.window.showErrorMessage(`❌ Not reachable: ${info}`, 'Einstellungen').then(sel => {
                            if (sel === 'Einstellungen') {
                                SettingsPanel.open(context.extensionUri);
                            }
                        });
                    }
                }
            );
        })
    );

    // ── Log configuration changes ───────────────────────────────────────
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('aiAssistant')) {
                logger.info(`Configuration changed: serverUrl=${
                    vscode.workspace.getConfiguration('aiAssistant').get('serverUrl')
                }`);
            }
        })
    );

    // ── Status Bar ────────────────────────────────────────────────────────────
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'aiAssistant.openPanel';

    // Status Bar zeigt aktuellen Modus
    const updateStatusBar = () => {
        const mode = getAssistantMode();
        const icons: Record<AssistantMode, string> = {
            auto: '$(zap) AI Auto',
            plan: '$(checklist) AI Plan',
            ask: '$(robot) AI Ask'
        };
        statusBar.text = icons[mode];
        statusBar.tooltip = `AI Assistant – mode ${mode}: ${MODE_LABELS[mode]}\n(click for a new chat)`;
    };
    updateStatusBar();
    statusBar.show();
    context.subscriptions.push(statusBar);

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('aiAssistant.mode') || e.affectsConfiguration('aiAssistant.autoApply')) {
                updateStatusBar();
            }
        })
    );

    // ── Workspace-Check ───────────────────────────────────────────────────────
    try {
        logger.info(`Workspace: ${FileManager.getInstance().getWorkspaceRoot()}`);
    } catch {
        logger.warn('No workspace is open.');
    }

    logger.info('AI Code Assistant activated ✓');

    const firstRun = context.globalState.get<boolean>('aiAssistant.firstRun', true);
    if (firstRun) {
        context.globalState.update('aiAssistant.firstRun', false);
        vscode.window.showInformationMessage(
            'AI Code Assistant is ready. Robot icon on the left → new chat session',
            'Open chat'
        ).then(sel => {
            if (sel === 'Open chat') ChatPanel.open(context.extensionUri);
        });
    }
}

export function deactivate(): void {
    Logger.getInstance().info('AI Code Assistant deaktiviert.');
    Logger.getInstance().dispose();
}
