import * as vscode from 'vscode';
import { ChatPanel } from './chatPanel';
import { AssistantMode, getAssistantMode } from './aiEngine';

/**
 * SidebarProvider – TreeDataProvider for the left Activity Bar.
 *
 * Zeigt interaktiv:
 * - Current mode (Ask / Auto / Plan) with selection
 * - Auto-Test-Toggle (Automatically run tests after AI changes)
 * - Button to open a new chat session
 *
 * All settings are stored in vscode.workspace.getConfiguration,
 * so that they are persistent and appear in the settings UI.
 */
export class SidebarProvider implements vscode.TreeDataProvider<SidebarItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SidebarItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private extensionUri: vscode.Uri;

    constructor(extensionUri: vscode.Uri) {
        this.extensionUri = extensionUri;

        // Automatically re-render on configuration change
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('aiAssistant')) {
                this.refresh();
            }
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SidebarItem): vscode.TreeItem {
        return element;
    }

    getChildren(): SidebarItem[] {
        const config = vscode.workspace.getConfiguration('aiAssistant');
        const mode     = getAssistantMode();
        const autoTest = config.get<boolean>('autoTest', false);

        // Label and icon per mode. Must match the listbox in the chat –
        // two representations of the same state that convey different information are
        // worse than just one.
        const MODES: Record<AssistantMode, { label: string; icon: string; tip: string }> = {
            ask: {
                label: 'Ask – confirm every change',
                icon: 'shield',
                tip: 'Every file change and every shell command is confirmed in the chat.\n'
                    + 'Click for the next mode.'
            },
            auto: {
                label: 'Auto – no questions asked',
                icon: 'zap',
                tip: 'The assistant works through without asking. Everything stays undoable.\n'
                    + 'Click for the next mode.'
            },
            plan: {
                label: 'Plan – read and plan only',
                icon: 'checklist',
                tip: 'The assistant may only read and plan. Changes and shell commands are blocked.\n'
                    + 'Click for the next mode.'
            }
        };
        const current = MODES[mode];

        const items: SidebarItem[] = [

            // ── Neuer Chat ──────────────────────────────────────────────────
            new SidebarItem(
                '➕  New chat session',
                vscode.TreeItemCollapsibleState.None,
                'aiAssistant.openPanel',
                new vscode.ThemeIcon('add'),
                'Opens a new AI chat tab in the editor'
            ),

            new SidebarItem(
                '',   // Trennlinie (leer)
                vscode.TreeItemCollapsibleState.None,
                undefined,
                undefined,
                undefined,
                true
            ),

            // ── Mode ───────────────────────────────────────────────────────
            new SidebarItem(
                `Mode: ${current.label}`,
                vscode.TreeItemCollapsibleState.None,
                'aiAssistant.setMode',
                new vscode.ThemeIcon(current.icon),
                current.tip,
                false,
                mode
            ),

            // ── Auto-Test ───────────────────────────────────────────────────
            new SidebarItem(
                `Auto-test: ${autoTest ? 'on' : 'off'}`,
                vscode.TreeItemCollapsibleState.None,
                'aiAssistant.toggleAutoTest',
                new vscode.ThemeIcon(autoTest ? 'beaker' : 'circle-outline'),
                autoTest
                    ? 'The AI detects the test framework and runs tests after changes. Click to switch off.'
                    : 'Tests are NOT run automatically. Click to switch on.',
                false,
                autoTest ? 'active' : 'inactive'
            ),

            // ── Hinweis: KI erkennt Test-Befehl automatisch ─────────────────
            ...(autoTest ? [new SidebarItem(
                'Command: detected by the AI',
                vscode.TreeItemCollapsibleState.None,
                undefined,
                new vscode.ThemeIcon('info'),
                'The AI works out the right test command from package.json, Cargo.toml, pytest.ini and so on.'
            )] : []),

            new SidebarItem(
                '',
                vscode.TreeItemCollapsibleState.None,
                undefined,
                undefined,
                undefined,
                true
            ),

            // ── Settings ───────────────────────────────────────────────
            new SidebarItem(
                '⚙  Settings',
                vscode.TreeItemCollapsibleState.None,
                'aiAssistant.openSettings',
                new vscode.ThemeIcon('settings-gear'),
                'Open all settings'
            ),
        ];

        return items.filter(i => i.label !== '');  // filter out empty separator rows
    }
}

class SidebarItem extends vscode.TreeItem {
    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        commandId?: string,
        iconPath?: vscode.ThemeIcon,
        tooltip?: string,
        _separator = false,
        contextValue?: string
    ) {
        super(label, collapsibleState);
        this.tooltip = tooltip;
        this.iconPath = iconPath;
        this.contextValue = contextValue;
        if (commandId) {
            this.command = { command: commandId, title: label };
        }
    }
}
