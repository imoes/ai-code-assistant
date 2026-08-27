import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ActionHistory } from './actionHistory';
import { Logger } from './logger';
import { ConfirmFn, DiffMeta, DiffReporter, AppliedChange } from './confirm';
import { computeDiff, formatDiff, diffStats, computeMergeSequence } from './diff';

export class FileManager {
    private static instance: FileManager;
    private history = ActionHistory.getInstance();
    private logger = Logger.getInstance();

    /** Empfänger für angewandte Änderungen (Chat-Panel), siehe setDiffReporter */
    private diffReporter?: DiffReporter;

    private constructor() {}

    static getInstance(): FileManager {
        if (!FileManager.instance) {
            FileManager.instance = new FileManager();
        }
        return FileManager.instance;
    }

    getWorkspaceRoot(): string {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            throw new Error('Kein Workspace-Ordner geöffnet.');
        }
        return folders[0].uri.fsPath;
    }

    private assertInsideWorkspace(filePath: string): void {
        const root = this.getWorkspaceRoot();
        const resolved = path.resolve(filePath);
        if (!resolved.startsWith(path.resolve(root))) {
            throw new Error(
                `Sicherheitsfehler: Zugriff außerhalb des Workspace verweigert.\n` +
                `Angefragt: ${resolved}`
            );
        }
    }

    resolvePath(relOrAbsPath: string): string {
        const p = path.isAbsolute(relOrAbsPath)
            ? relOrAbsPath
            : path.join(this.getWorkspaceRoot(), relOrAbsPath);
        this.assertInsideWorkspace(p);
        return p;
    }

    readFile(filePath: string): string | undefined {
        const abs = this.resolvePath(filePath);
        if (!fs.existsSync(abs)) return undefined;
        return fs.readFileSync(abs, 'utf-8');
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Datei erstellen / überschreiben
    // ──────────────────────────────────────────────────────────────────────────

    async createFile(
        filePath: string,
        content: string,
        options: { overwrite?: boolean; confirmFn?: ConfirmFn } = {}
    ): Promise<boolean> {
        const abs = this.resolvePath(filePath);
        const exists = fs.existsSync(abs);
        const rel = path.relative(this.getWorkspaceRoot(), abs);

        if (exists && !options.overwrite && options.confirmFn) {
            const existing = fs.readFileSync(abs, 'utf-8');
            const diff = this.makeDiffMeta(abs, existing, content);
            const [rm, add] = diff.stats;
            const choice = await options.confirmFn(
                `Datei überschreiben: **${rel}**\n−${rm} / +${add} Zeilen`,
                ['Überschreiben', 'Ablehnen'],
                diff
            );
            if (choice !== 'Überschreiben') return false;
        }

        const previousContent = exists ? fs.readFileSync(abs, 'utf-8') : undefined;
        this.history.record({
            type: exists ? 'file_edit' : 'file_create',
            description: exists ? 'Datei überschrieben' : 'Datei erstellt',
            filePath: abs,
            previousContent
        });

        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf-8');
        this.logger.action('FILE_WRITE', abs);
        this.reportChange(abs, previousContent, content);

        // Datei im Editor im Hintergrund öffnen
        vscode.workspace.openTextDocument(vscode.Uri.file(abs)).then(doc =>
            vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.One })
        );

        return true;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Datei bearbeiten
    // ──────────────────────────────────────────────────────────────────────────

    async editFile(
        filePath: string,
        newContent: string,
        confirmFn?: ConfirmFn
    ): Promise<boolean> {
        const abs = this.resolvePath(filePath);
        const rel = path.relative(this.getWorkspaceRoot(), abs);

        if (!fs.existsSync(abs)) {
            throw new Error(`Datei nicht gefunden: ${rel}`);
        }

        const previousContent = fs.readFileSync(abs, 'utf-8');

        if (confirmFn) {
            const diff = this.makeDiffMeta(abs, previousContent, newContent);
            const [rm, add] = diff.stats;
            const choice = await confirmFn(
                `Datei bearbeiten: **${rel}**\n−${rm} / +${add} Zeilen`,
                ['Anwenden', 'Ablehnen'],
                diff
            );
            if (choice !== 'Anwenden') return false;
        }

        this.history.record({
            type: 'file_edit',
            description: 'Datei bearbeitet',
            filePath: abs,
            previousContent
        });

        fs.writeFileSync(abs, newContent, 'utf-8');
        this.logger.action('FILE_EDIT', abs);
        this.reportChange(abs, previousContent, newContent);
        return true;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Datei löschen
    // ──────────────────────────────────────────────────────────────────────────

    async deleteFile(
        filePath: string,
        confirmFn?: ConfirmFn
    ): Promise<boolean> {
        const abs = this.resolvePath(filePath);
        const rel = path.relative(this.getWorkspaceRoot(), abs);

        if (!fs.existsSync(abs)) {
            this.logger.warn(`Datei zum Löschen nicht gefunden: ${abs}`);
            return false;
        }

        if (confirmFn) {
            const choice = await confirmFn(
                `⚠ Datei löschen: **${rel}**\n(Kann mit "Undo All" wiederhergestellt werden)`,
                ['Löschen', 'Ablehnen']
            );
            if (choice !== 'Löschen') return false;
        }

        const previousContent = fs.readFileSync(abs, 'utf-8');
        this.history.record({ type: 'file_delete', description: 'Datei gelöscht', filePath: abs, previousContent });

        fs.unlinkSync(abs);
        this.logger.action('FILE_DELETE', abs);
        this.reportChange(abs, previousContent, undefined);
        return true;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Datei umbenennen
    // ──────────────────────────────────────────────────────────────────────────

    async renameFile(
        oldPath: string,
        newPath: string,
        confirmFn?: ConfirmFn
    ): Promise<boolean> {
        const absOld = this.resolvePath(oldPath);
        const absNew = this.resolvePath(newPath);
        const relOld = path.relative(this.getWorkspaceRoot(), absOld);
        const relNew = path.relative(this.getWorkspaceRoot(), absNew);

        if (!fs.existsSync(absOld)) {
            throw new Error(`Quelldatei nicht gefunden: ${relOld}`);
        }

        if (confirmFn) {
            const choice = await confirmFn(
                `Datei umbenennen:\n**${relOld}** → **${relNew}**`,
                ['Umbenennen', 'Ablehnen']
            );
            if (choice !== 'Umbenennen') return false;
        }

        this.history.record({
            type: 'file_rename',
            description: `Umbenannt nach ${relNew}`,
            filePath: absOld,
            newFilePath: absNew
        });

        fs.mkdirSync(path.dirname(absNew), { recursive: true });
        fs.renameSync(absOld, absNew);
        this.logger.action('FILE_RENAME', `${absOld} → ${absNew}`);
        return true;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // VSCode Diff-Editor öffnen (für den "In Editor öffnen"-Button)
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Öffnet den eingebauten VSCode-Diff-Editor mit der aktuellen und der
     * KI-generierten Version einer Datei.
     * Schreibt den neuen Inhalt in eine temporäre Datei (wird beim Schließen gelöscht).
     */
    async openDiffEditor(absPath: string, newContent: string, label: string): Promise<void> {
        const oldUri = vscode.Uri.file(absPath);

        // Neue Version als temp. Datei neben dem Original
        const ext = path.extname(absPath);
        const tmpPath = path.join(os.tmpdir(), `ai-diff-${Date.now()}${ext}`);
        fs.writeFileSync(tmpPath, newContent, 'utf-8');
        const newUri = vscode.Uri.file(tmpPath);

        await vscode.commands.executeCommand(
            'vscode.diff',
            oldUri,
            newUri,
            `${label} (KI-Änderung)`,
            { preview: true, preserveFocus: true }
        );

        // Temp-Datei nach kurzem Delay löschen (Editor hält sie im Speicher)
        setTimeout(() => {
            try { fs.unlinkSync(tmpPath); } catch { /* ignorieren */ }
        }, 60_000);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Workspace-Listing
    // ──────────────────────────────────────────────────────────────────────────

    listFiles(dir?: string, maxDepth = 4, _depth = 0): string[] {
        const root = dir ?? this.getWorkspaceRoot();
        const IGNORE = new Set([
            'node_modules', '.git', 'out', 'dist', '.next',
            '__pycache__', '.venv', 'venv', 'target', '.cache',
            'build', 'coverage', '.nyc_output'
        ]);
        if (_depth > maxDepth) return [];
        const results: string[] = [];
        try {
            for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
                if (IGNORE.has(entry.name)) continue;
                const full = path.join(root, entry.name);
                if (entry.isDirectory()) {
                    results.push(...this.listFiles(full, maxDepth, _depth + 1));
                } else {
                    results.push(full);
                }
            }
        } catch { /* kein Zugriff */ }
        return results;
    }

    getWorkspaceTree(maxFiles = 100): string {
        const root = this.getWorkspaceRoot();
        return this.listFiles().slice(0, maxFiles)
            .map(f => path.relative(root, f)).join('\n');
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Zeilen ersetzen (für action:replace_lines)
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Ersetzt einen Zeilenbereich [startLine, endLine] (1-basiert, inklusiv)
     * durch neuen Code. Lässt alle anderen Zeilen unangetastet.
     */
    async replaceLines(
        filePath: string,
        startLine: number,
        endLine: number,
        newContent: string,
        confirmFn?: ConfirmFn
    ): Promise<boolean> {
        const abs = this.resolvePath(filePath);
        const rel = path.relative(this.getWorkspaceRoot(), abs);
        if (!fs.existsSync(abs)) throw new Error(`Datei nicht gefunden: ${rel}`);

        const originalContent = fs.readFileSync(abs, 'utf-8');
        const lines = originalContent.split('\n');
        const totalLines = lines.length;

        const start0 = Math.max(0, startLine - 1);          // 0-basiert inklusiv
        const end0   = Math.min(totalLines, endLine);        // 0-basiert exklusiv

        const newLines = newContent === '' ? [] : newContent.split('\n');
        const merged = [
            ...lines.slice(0, start0),
            ...newLines,
            ...lines.slice(end0)
        ];
        const newFileContent = merged.join('\n');

        if (confirmFn) {
            const diff = this.makeDiffMeta(abs, originalContent, newFileContent);
            const [rm, add] = diff.stats;
            const choice = await confirmFn(
                `Zeilen ${startLine}–${endLine} ersetzen: **${rel}**\n−${rm} / +${add} Zeilen`,
                ['Anwenden', 'Ablehnen'],
                diff
            );
            if (choice !== 'Anwenden') return false;
        }

        this.history.record({
            type: 'file_edit',
            description: `Zeilen ${startLine}–${endLine} ersetzt`,
            filePath: abs,
            previousContent: originalContent
        });
        fs.writeFileSync(abs, newFileContent, 'utf-8');
        this.reportChange(abs, originalContent, newFileContent);
        this.logger.action('FILE_REPLACE_LINES', `${rel} L${startLine}-${endLine}`);
        return true;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Smart-Merge (Sicherheitsnetz für edit_file mit zu kurzem Inhalt)
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Wendet KI-generierten Inhalt intelligent an:
     * - Additionen werden übernommen
     * - Entfernungen werden dem User zur Bestätigung vorgelegt
     *   (mit 3 Optionen: "Nur Additions", "Komplett ersetzen", "Ablehnen")
     *
     * Wird aufgerufen wenn edit_file einen deutlich kürzeren Inhalt liefert
     * als die Originaldatei hat (Verdacht auf ungewollte Löschung).
     */
    async smartMergeEdit(
        filePath: string,
        aiContent: string,
        confirmFn?: ConfirmFn
    ): Promise<boolean> {
        const abs = this.resolvePath(filePath);
        const rel = path.relative(this.getWorkspaceRoot(), abs);
        if (!fs.existsSync(abs)) throw new Error(`Datei nicht gefunden: ${rel}`);

        const originalContent = fs.readFileSync(abs, 'utf-8');
        const sequence = computeMergeSequence(originalContent, aiContent);

        // Zähle wie viele Zeilen entfernt würden
        const removedLines = sequence.filter(l => l.type === 'remove');
        const addedLines   = sequence.filter(l => l.type === 'add');

        // "Nur Additions" Inhalt aufbauen: original + new additions, keine Löschungen
        const additionsOnlyLines: string[] = [];
        for (const l of sequence) {
            if (l.type === 'keep' || l.type === 'add') {
                additionsOnlyLines.push(l.text);
            }
            // 'remove': nicht aufnehmen → bleibt erhalten
        }
        const additionsOnlyContent = additionsOnlyLines.join('\n');

        if (!confirmFn) {
            // Kein Confirm-Fn: sicher sein → nur Additions anwenden
            if (additionsOnlyContent === originalContent) return true;
            this.history.record({ type: 'file_edit', description: 'Smart-Merge (nur Additions)', filePath: abs, previousContent: originalContent });
            fs.writeFileSync(abs, additionsOnlyContent, 'utf-8');
            this.reportChange(abs, originalContent, additionsOnlyContent);
            this.logger.action('FILE_SMART_MERGE', rel);
            return true;
        }

        // Diff für die Anzeige: zeige was "Nur Additions" gegenüber Original ändert
        const diff = this.makeDiffMeta(abs, originalContent, additionsOnlyContent);
        const [rm, add] = diff.stats;

        const choice = await confirmFn(
            `⚠ KI hat ${removedLines.length} Zeile(n) entfernt und ${addedLines.length} hinzugefügt in **${rel}**.\n\n` +
            `**"Nur Additions"** übernimmt nur die neuen Zeilen (sicher).\n` +
            `**"Komplett ersetzen"** wendet alles an inkl. Löschungen.\n\n` +
            `Diff zeigt "Nur Additions" (−${rm} / +${add}):`,
            ['Nur Additions', 'Komplett ersetzen', 'Ablehnen'],
            diff
        );

        if (choice === 'Ablehnen') return false;

        const finalContent = choice === 'Komplett ersetzen' ? aiContent : additionsOnlyContent;

        this.history.record({ type: 'file_edit', description: `Smart-Merge (${choice})`, filePath: abs, previousContent: originalContent });
        fs.writeFileSync(abs, finalContent, 'utf-8');
        this.reportChange(abs, originalContent, finalContent);
        this.logger.action('FILE_SMART_MERGE', `${rel} (${choice})`);
        return true;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Datei patchen (gezieltes SEARCH → REPLACE)
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Ersetzt einen genau definierten Textblock in der Datei durch neuen Code.
     * Deutlich sicherer als editFile() wenn nur ein Teil verändert werden soll,
     * da der Rest der Datei unangetastet bleibt.
     */
    async patchFile(
        filePath: string,
        searchText: string,
        replaceText: string,
        confirmFn?: ConfirmFn
    ): Promise<{ success: boolean; error?: string }> {
        const abs = this.resolvePath(filePath);
        const rel = path.relative(this.getWorkspaceRoot(), abs);

        if (!fs.existsSync(abs)) {
            return { success: false, error: `Datei nicht gefunden: ${rel}` };
        }

        const originalContent = fs.readFileSync(abs, 'utf-8');

        // Exact-match versuchen, dann whitespace-normalisiert
        let newContent: string;
        if (originalContent.includes(searchText)) {
            newContent = originalContent.replace(searchText, replaceText);
        } else {
            // Whitespace normalisiert suchen
            const normalizedOriginal = originalContent.replace(/\r\n/g, '\n');
            const normalizedSearch   = searchText.replace(/\r\n/g, '\n').trim();
            if (normalizedOriginal.includes(normalizedSearch)) {
                newContent = normalizedOriginal.replace(normalizedSearch, replaceText);
            } else {
                return {
                    success: false,
                    error: `Suchtext nicht gefunden in ${rel}:\n${searchText.slice(0, 200)}`
                };
            }
        }

        if (confirmFn) {
            const diff = this.makeDiffMeta(abs, originalContent, newContent);
            const [rm, add] = diff.stats;
            const choice = await confirmFn(
                `Patch anwenden: **${rel}**\n−${rm} / +${add} Zeilen`,
                ['Anwenden', 'Ablehnen'],
                diff
            );
            if (choice !== 'Anwenden') return { success: false };
        }

        this.history.record({
            type: 'file_edit',
            description: `Patch angewendet`,
            filePath: abs,
            previousContent: originalContent
        });

        fs.writeFileSync(abs, newContent, 'utf-8');
        this.reportChange(abs, originalContent, newContent);
        this.logger.action('FILE_PATCH', abs);
        return { success: true };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Diff-Hilfsmethode
    // ──────────────────────────────────────────────────────────────────────────

    private makeDiffMeta(absPath: string, oldContent: string, newContent: string): DiffMeta {
        const hunks = computeDiff(oldContent, newContent);
        return {
            diffText: formatDiff(hunks),
            oldUri: absPath,
            newContent,
            stats: diffStats(hunks)
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Angewandte Änderungen melden
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Empfänger für angewandte Änderungen setzen (Chat-Panel).
     *
     * Im Auto-Modus gibt es keine Bestätigungskarte – ohne diese Meldung würde
     * der Benutzer nie erfahren, was der Assistent geändert hat.
     */
    setDiffReporter(reporter: DiffReporter | undefined): void {
        this.diffReporter = reporter;
    }

    /**
     * Eine erfolgte Änderung melden.
     *
     * @param absPath     Absoluter Pfad der Datei
     * @param oldContent  Inhalt vorher (undefined = Datei war neu)
     * @param newContent  Inhalt nachher (undefined = Datei gelöscht)
     */
    private reportChange(absPath: string, oldContent?: string, newContent?: string): void {
        if (!this.diffReporter) return;

        let rel = absPath;
        try { rel = path.relative(this.getWorkspaceRoot(), absPath).replace(/\\/g, '/'); }
        catch { /* kein Workspace – dann eben der absolute Pfad */ }

        const kind: AppliedChange['kind'] = newContent === undefined
            ? 'gelöscht'
            : oldContent === undefined ? 'erstellt' : 'geändert';

        // Bei neuen Dateien gibt es keinen sinnvollen Diff – dort zählt nur die
        // Zeilenzahl. Bei Änderungen zeigen wir den echten farbigen Diff.
        if (kind === 'geändert') {
            const hunks = computeDiff(oldContent!, newContent!);
            this.diffReporter({
                path: rel, kind,
                diffText: formatDiff(hunks),
                stats: diffStats(hunks)
            });
            return;
        }

        const lines = (newContent ?? oldContent ?? '').split('\n').length;
        this.diffReporter({
            path: rel, kind,
            diffText: '',
            stats: kind === 'erstellt' ? [0, lines] : [lines, 0]
        });
    }
}
