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
                label: 'Ask – jede Änderung bestätigen',
                icon: 'shield',
                tip: 'Jede Dateiänderung und jeder Shell-Befehl wird im Chat bestätigt.\n'
                    + 'Klicken für den nächsten Modus.'
            },
            auto: {
                label: 'Auto – ohne Rückfragen',
                icon: 'zap',
                tip: 'Der Assistent arbeitet ohne Rückfragen durch. Alles bleibt per Undo rücknehmbar.\n'
                    + 'Klicken für den nächsten Modus.'
            },
            plan: {
                label: 'Plan – nur lesen und planen',
                icon: 'checklist',
                tip: 'Der Assistent darf nur lesen und planen. Änderungen und Shell-Befehle sind gesperrt.\n'
                    + 'Klicken für den nächsten Modus.'
            }
        };
        const current = MODES[mode];

        const items: SidebarItem[] = [

            // ── Neuer Chat ──────────────────────────────────────────────────
            new SidebarItem(
                '➕  Neue Chat-Session',
                vscode.TreeItemCollapsibleState.None,
                'aiAssistant.openPanel',
                new vscode.ThemeIcon('add'),
                'Öffnet einen neuen AI-Chat-Tab im Editor'
            ),

            new SidebarItem(
                '',   // Trennlinie (leer)
                vscode.TreeItemCollapsibleState.None,
                undefined,
                undefined,
                undefined,
                true
            ),

            // ── Modus ───────────────────────────────────────────────────────
            new SidebarItem(
                `Modus: ${current.label}`,
                vscode.TreeItemCollapsibleState.None,
                'aiAssistant.setMode',
                new vscode.ThemeIcon(current.icon),
                current.tip,
                false,
                mode
            ),

            // ── Auto-Test ───────────────────────────────────────────────────
            new SidebarItem(
                `Auto-Test: ${autoTest ? 'Aktiv' : 'Inaktiv'}`,
                vscode.TreeItemCollapsibleState.None,
                'aiAssistant.toggleAutoTest',
                new vscode.ThemeIcon(autoTest ? 'beaker' : 'circle-outline'),
                autoTest
                    ? 'KI erkennt Testframework automatisch und führt Tests nach Änderungen aus. Klicken zum Deaktivieren.'
                    : 'Tests werden NICHT automatisch ausgeführt. Klicken zum Aktivieren.',
                false,
                autoTest ? 'active' : 'inactive'
            ),

            // ── Hinweis: KI erkennt Test-Befehl automatisch ─────────────────
            ...(autoTest ? [new SidebarItem(
                'Befehl: von KI erkannt',
                vscode.TreeItemCollapsibleState.None,
                undefined,
                new vscode.ThemeIcon('info'),
                'Die KI erkennt anhand von package.json, Cargo.toml, pytest.ini usw. automatisch den richtigen Test-Befehl.'
            )] : []),

            new SidebarItem(
                '',
                vscode.TreeItemCollapsibleState.None,
                undefined,
                undefined,
                undefined,
                true
            ),

            // ── Einstellungen ───────────────────────────────────────────────
            new SidebarItem(
                '⚙  Einstellungen',
                vscode.TreeItemCollapsibleState.None,
                'aiAssistant.openSettings',
                new vscode.ThemeIcon('settings-gear'),
                'Alle Einstellungen öffnen'
            ),
        ];

        return items.filter(i => i.label !== '');  // Leere Trennzeilen rausfiltern
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
