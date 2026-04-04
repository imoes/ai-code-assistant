import * as vscode from 'vscode';
import { ChatPanel } from './chatPanel';
import { SidebarProvider } from './sidebarProvider';
import { ActionHistory } from './actionHistory';
import { MCPClient } from './mcpClient';
import { Logger } from './logger';
import { FileManager } from './fileManager';

export function activate(context: vscode.ExtensionContext): void {
    const logger = Logger.getInstance();
    logger.info('AI Code Assistant wird aktiviert...');

    // ── Sidebar (linke Leiste: Modus, Tests, neue Session) ────────────────────
    const sidebar = new SidebarProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('aiAssistant.sessionsView', sidebar)
    );

    // ── Chat-Tab öffnen ───────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('aiAssistant.openPanel', () => {
            ChatPanel.open(context.extensionUri, true);
        })
    );

    // ── Selektion aus Editor senden ───────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('aiAssistant.sendPrompt', async () => {
            const editor = vscode.window.activeTextEditor;
            let prefill = '';
            if (editor && !editor.selection.isEmpty) {
                const sel = editor.document.getText(editor.selection);
                const lang = editor.document.languageId;
                prefill = `Analysiere und verbessere folgenden ${lang}-Code:\n\`\`\`${lang}\n${sel}\n\`\`\`\n\n`;
            }
            const input = await vscode.window.showInputBox({
                prompt: 'KI-Anweisung eingeben',
                placeHolder: 'z.B. "Füge Unit-Tests hinzu", "Erstelle eine REST API"',
                value: prefill,
                ignoreFocusOut: true
            });
            if (input?.trim()) {
                ChatPanel.open(context.extensionUri, false);
            }
        })
    );

    // ── Modus umschalten (Auto ↔ Manuell) ────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('aiAssistant.toggleMode', async () => {
            const config = vscode.workspace.getConfiguration('aiAssistant');
            const current = config.get<boolean>('autoApply', false);
            const newVal = !current;
            await config.update('autoApply', newVal, vscode.ConfigurationTarget.Global);
            const label = newVal ? 'Automatisch ⚡' : 'Manuell 🔒';
            vscode.window.showInformationMessage(`AI Assistant Modus: ${label}`);
            sidebar.refresh();
            // Alle offenen Tabs über Modusänderung informieren
            ChatPanel.broadcastModeChange(newVal);
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

    // ── Einstellungen öffnen ──────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('aiAssistant.openSettings', () =>
            vscode.commands.executeCommand('workbench.action.openSettings', 'aiAssistant')
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
                'Alle KI-generierten Änderungen rückgängig machen?',
                { modal: true },
                'Ja, alle rückgängig',
                'Abbrechen'
            );
            if (answer === 'Ja, alle rückgängig') {
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
                { location: vscode.ProgressLocation.Notification, title: `Verbinde mit ${url}…`, cancellable: false },
                async () => {
                    const { success, info } = await MCPClient.getInstance().testConnection();
                    if (success) {
                        vscode.window.showInformationMessage(`✅ llama.cpp erreichbar: ${info}`);
                    } else {
                        vscode.window.showErrorMessage(`❌ Nicht erreichbar: ${info}`, 'Einstellungen').then(sel => {
                            if (sel === 'Einstellungen') {
                                vscode.commands.executeCommand('workbench.action.openSettings', 'aiAssistant.serverUrl');
                            }
                        });
                    }
                }
            );
        })
    );

    // ── Konfigurationsänderungen loggen ───────────────────────────────────────
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('aiAssistant')) {
                logger.info(`Konfiguration geändert: serverUrl=${
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
        const isAuto = vscode.workspace.getConfiguration('aiAssistant').get<boolean>('autoApply', false);
        statusBar.text = isAuto ? '$(zap) AI Auto' : '$(robot) AI Chat';
        statusBar.tooltip = isAuto
            ? 'AI Assistant – Automatischer Modus (klicken für neuen Chat)'
            : 'AI Assistant – Manueller Modus (klicken für neuen Chat)';
    };
    updateStatusBar();
    statusBar.show();
    context.subscriptions.push(statusBar);

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('aiAssistant.autoApply')) {
                updateStatusBar();
            }
        })
    );

    // ── Workspace-Check ───────────────────────────────────────────────────────
    try {
        logger.info(`Workspace: ${FileManager.getInstance().getWorkspaceRoot()}`);
    } catch {
        logger.warn('Kein Workspace geöffnet.');
    }

    logger.info('AI Code Assistant aktiviert ✓');

    const firstRun = context.globalState.get<boolean>('aiAssistant.firstRun', true);
    if (firstRun) {
        context.globalState.update('aiAssistant.firstRun', false);
        vscode.window.showInformationMessage(
            'AI Code Assistant bereit! Roboter-Icon links → Neue Chat-Session',
            'Chat öffnen'
        ).then(sel => {
            if (sel === 'Chat öffnen') ChatPanel.open(context.extensionUri);
        });
    }
}

export function deactivate(): void {
    Logger.getInstance().info('AI Code Assistant deaktiviert.');
    Logger.getInstance().dispose();
}
