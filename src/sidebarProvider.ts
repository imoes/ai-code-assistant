import * as vscode from 'vscode';
import { ChatPanel } from './chatPanel';

/**
 * SidebarProvider – TreeDataProvider für die linke Activity-Bar-Leiste.
 *
 * Zeigt interaktiv:
 *  - Aktuellen Modus (Auto / Manuell) mit Umschalter
 *  - Auto-Test-Toggle (Tests nach KI-Änderungen automatisch ausführen)
 *  - Button zum Öffnen einer neuen Chat-Session
 *
 * Alle Einstellungen werden in vscode.workspace.getConfiguration gespeichert,
 * damit sie persistent sind und in der Einstellungs-UI auftauchen.
 */
export class SidebarProvider implements vscode.TreeDataProvider<SidebarItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SidebarItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private extensionUri: vscode.Uri;

    constructor(extensionUri: vscode.Uri) {
        this.extensionUri = extensionUri;

        // Bei Konfigurationsänderung automatisch neu rendern
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
        const isAuto   = config.get<boolean>('autoApply', false);
        const autoTest = config.get<boolean>('autoTest', false);

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
                `Modus: ${isAuto ? 'Automatisch' : 'Manuell'}`,
                vscode.TreeItemCollapsibleState.None,
                'aiAssistant.toggleMode',
                new vscode.ThemeIcon(isAuto ? 'zap' : 'gear'),
                isAuto
                    ? 'KI führt alle Aktionen automatisch aus. Klicken zum Wechseln auf Manuell.'
                    : 'KI fragt vor jeder Aktion nach Bestätigung. Klicken zum Wechseln auf Automatisch.',
                false,
                isAuto ? 'auto' : 'manual'
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
