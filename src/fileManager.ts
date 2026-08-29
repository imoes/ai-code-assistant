import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ActionHistory } from './actionHistory';
import { Logger } from './logger';
import { ConfirmFn, DiffMeta, DiffReporter, AppliedChange } from './confirm';
import { computeDiff, formatDiff, diffStats, computeMergeSequence } from './diff';
import { AgentConsole } from './agentConsole';

export class FileManager {
    private static instance: FileManager;
    private history = ActionHistory.getInstance();
    private logger = Logger.getInstance();

    /** Receiver for applied changes (chat panel), see setDiffReporter */
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
        const root = path.resolve(this.getWorkspaceRoot());

        // A genuine absolute path that points INTO the workspace is taken as
        // it is. This has to come first: on Linux the workspace itself starts
        // with a slash (/home/runner/…), and stripping that would turn every
        // absolute path into a relative one. On Windows the same test simply
        // does not match for `/src/x`, so the case below takes over.
        if (path.isAbsolute(relOrAbsPath)) {
            const direct = path.resolve(relOrAbsPath);
            if (direct === root || direct.startsWith(root + path.sep)) return direct;
        }

        // Otherwise a leading slash means "from the project root".
        const cleaned = FileManager.stripRootSlash(relOrAbsPath);
        const p = path.isAbsolute(cleaned)
            ? cleaned
            : path.join(root, cleaned);
        this.assertInsideWorkspace(p);
        return p;
    }

    /**
     * Remove a leading slash: `/src/parser.js` means `src/parser.js`.
     *
     * Models write paths with a leading slash all the time, and what they mean
     * is the root of the project. On Windows, though, `/src/parser.js` is
     * drive-relative: `path.isAbsolute()` says true, and it turns into
     * `C:\src\parser.js` – outside the workspace, so it is rejected.
     *
     * Observed in a window run: the model read seven files as `/AGENTS.md`,
     * `/src/tokenizer.js` … and got "Zugriff außerhalb des Workspace
     * verweigert" seven times. It worked a whole round blind, without having
     * seen a single file.
     *
     * A genuine absolute path is left untouched – `C:\…`, `D:/…` and `/mnt/d/…`
     * carry a drive and are still checked, and rejected where appropriate. Only
     * the drive-less leading slash is read as "from the project root".
     */
    static stripRootSlash(p: string): string {
        if (/^[a-zA-Z]:[\\/]/.test(p)) return p;          // C:\… or C:/…
        if (/^[\\/]mnt[\\/][a-zA-Z][\\/]/.test(p)) return p;  // WSL drive
        if (/^[\\/]{2}/.test(p)) return p;                 // UNC: \\server\share
        return p.replace(/^[\\/]+/, '');
    }

    /**
     * Workspace-relative path with forward slashes – for display and for the AI.
     *
     * `path.relative` returns backslashes on Windows. These then appeared in
     * Error messages on (`src\tokenizer.js`), while all other paths
     * Have slashes. The model must be able to recognize paths.
     */
    private relDisplay(absPath: string): string {
        try {
            return path.relative(this.getWorkspaceRoot(), absPath).replace(/\\/g, '/');
        } catch {
            return absPath;
        }
    }

    readFile(filePath: string): string | undefined {
        const abs = this.resolvePath(filePath);
        if (!fs.existsSync(abs)) return undefined;
        return fs.readFileSync(abs, 'utf-8');
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Create file / overwrite
    // ──────────────────────────────────────────────────────────────────────────

    async createFile(
        filePath: string,
        content: string,
        options: { overwrite?: boolean; confirmFn?: ConfirmFn } = {}
    ): Promise<boolean> {
        const abs = this.resolvePath(filePath);
        const exists = fs.existsSync(abs);
        const rel = this.relDisplay(abs);

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

        // Open file in the background editor
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
        const rel = this.relDisplay(abs);

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
    // Delete file
    // ──────────────────────────────────────────────────────────────────────────

    async deleteFile(
        filePath: string,
        confirmFn?: ConfirmFn
    ): Promise<boolean> {
        const abs = this.resolvePath(filePath);
        const rel = this.relDisplay(abs);

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
        const relOld = this.relDisplay(absOld);
        const relNew = this.relDisplay(absNew);

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
    // Open VSCode Diff Editor (for the "Open in Editor" button)
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Opens the built-in VSCode diff editor with the current and the
     * KI-generierten Version einer Datei.
     * Write the new content to a temporary file (deleted upon closing).
     */
    async openDiffEditor(absPath: string, newContent: string, label: string): Promise<void> {
        const oldUri = vscode.Uri.file(absPath);

        // New version as temporary file next to the original
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

        // Delete temporary file after a short delay (editor keeps it in memory)
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
    // Replace lines (for action:replace_lines)
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Replaces a line range [startLine, endLine] (1-based, inclusive)
     * by new code. Leaves all other lines untouched.
     */
    async replaceLines(
        filePath: string,
        startLine: number,
        endLine: number,
        newContent: string,
        confirmFn?: ConfirmFn
    ): Promise<boolean> {
        const abs = this.resolvePath(filePath);
        const rel = this.relDisplay(abs);
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
    // Smart-Merge (Safety net for edit_file with too short content)
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Wendet KI-generierten Inhalt intelligent an:
     * - Additions are adopted
     * - Distances are presented to the user for confirmation
     * (with 3 options: "Only Additions", "Replace Completely", "Reject")
     *
     * Called when edit_file provides a significantly shorter content
     * as the original file has (suspected accidental deletion).
     */
    async smartMergeEdit(
        filePath: string,
        aiContent: string,
        confirmFn?: ConfirmFn
    ): Promise<boolean> {
        const abs = this.resolvePath(filePath);
        const rel = this.relDisplay(abs);
        if (!fs.existsSync(abs)) throw new Error(`Datei nicht gefunden: ${rel}`);

        const originalContent = fs.readFileSync(abs, 'utf-8');
        const sequence = computeMergeSequence(originalContent, aiContent);

        // Count how many lines would be removed
        const removedLines = sequence.filter(l => l.type === 'remove');
        const addedLines   = sequence.filter(l => l.type === 'add');

        // Build "Additions only" content: original + new additions, no deletions
        const additionsOnlyLines: string[] = [];
        for (const l of sequence) {
            if (l.type === 'keep' || l.type === 'add') {
                additionsOnlyLines.push(l.text);
            }
            // 'remove': do not include → remains
        }
        const additionsOnlyContent = additionsOnlyLines.join('\n');

        if (!confirmFn) {
            // No confirm function: be sure → only apply additions
            if (additionsOnlyContent === originalContent) return true;
            this.history.record({ type: 'file_edit', description: 'Smart-Merge (nur Additions)', filePath: abs, previousContent: originalContent });
            fs.writeFileSync(abs, additionsOnlyContent, 'utf-8');
            this.reportChange(abs, originalContent, additionsOnlyContent);
            this.logger.action('FILE_SMART_MERGE', rel);
            return true;
        }

        // Diff for the display: show what "Additions only" changes compared to the original
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
     * Replaces a precisely defined text block in the file with new code.
     * Much safer than editFile() when only a part needs to be changed,
     * since the rest of the file remains untouched.
     */
    async patchFile(
        filePath: string,
        searchText: string,
        replaceText: string,
        confirmFn?: ConfirmFn
    ): Promise<{ success: boolean; error?: string }> {
        const abs = this.resolvePath(filePath);
        const rel = this.relDisplay(abs);

        if (!fs.existsSync(abs)) {
            return { success: false, error: `Datei nicht gefunden: ${rel}` };
        }

        const originalContent = fs.readFileSync(abs, 'utf-8');

        // Try exact match, then whitespace-normalized
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
                    error: this.explainPatchMiss(rel, originalContent, searchText, replaceText)
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

    /**
     * Explains WHY a patch did not take effect – and what to do instead.
     *
     * Without this diagnosis, the model repeatedly attempts the same patch:
     * the old message only said "Search text not found", not that the
     * The change has long been included. The assistant got stuck in a loop exactly like that.
     * from failed patches.
     */
    private explainPatchMiss(
        rel: string,
        content: string,
        searchText: string,
        replaceText: string
    ): string {
        const squish = (s: string) => s.replace(/\s+/g, ' ').trim();

        // 1. Has the change already been applied? If so, nothing needs to be done.
        if (replaceText.trim() && squish(content).includes(squish(replaceText))) {
            return `Die Änderung ist in ${rel} BEREITS VORHANDEN – der neue Code steht `
                + `schon in der Datei. Wiederhole diesen Patch nicht. Prüfe mit read_file, `
                + `was noch offen ist, und arbeite am nächsten Punkt weiter.`;
        }

        // 2. Find the first line of the search text – then it's up to the following lines
        const firstLine = searchText.split('\n').map(l => l.trim()).find(Boolean);
        if (firstLine) {
            const lines = content.split('\n');
            const hits = lines
                .map((l, i) => ({ line: l, no: i + 1 }))
                .filter(x => x.line.trim() === firstLine)
                .slice(0, 3);

            if (hits.length > 0) {
                const near = hits
                    .map(h => `  Zeile ${h.no}: ${h.line.trim().slice(0, 120)}`)
                    .join('\n');
                return `Suchtext nicht gefunden in ${rel}. Die ERSTE Zeile passt, die `
                    + `folgenden nicht – der Text muss ZEICHENGENAU stimmen, inklusive `
                    + `Einrückung und Kommentaren.\n`
                    + `Gefunden hier:\n${near}\n`
                    + `Lies den Bereich mit read_file und kopiere ihn wörtlich, oder nutze `
                    + `replace_lines mit den Zeilennummern.`;
            }
        }

        return `Suchtext nicht gefunden in ${rel} – die Datei sieht anders aus als `
            + `angenommen (vielleicht durch eine frühere Änderung).\n`
            + `Gesuchter Text war:\n${searchText.slice(0, 300)}\n`
            + `Lies die Datei mit read_file neu und patche gegen den tatsächlichen Inhalt.`;
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
    // Report Applied Changes
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Set recipient for applied changes (chat panel).
     *
     * In auto mode there is no confirmation card – without this message it would
     * the user never finds out what the assistant changed.
     */
    setDiffReporter(reporter: DiffReporter | undefined): void {
        this.diffReporter = reporter;
    }

    /**
     * Report a change that has occurred.
     *
     * @param absPath     Absolute path of the file
     * @param oldContent  Inhalt vorher (undefined = Datei war neu)
     * @param newContent  Content afterwards (undefined = file deleted)
     */
    private reportChange(absPath: string, oldContent?: string, newContent?: string): void {
        const rel = this.relDisplay(absPath);

        const kind: AppliedChange['kind'] = newContent === undefined
            ? 'gelöscht'
            : oldContent === undefined ? 'erstellt' : 'geändert';

        // For new files, there is no meaningful diff – only the
        // line count matters. For changes, we show the real colored diff.
        if (kind === 'geändert') {
            const hunks = computeDiff(oldContent!, newContent!);
            const stats = diffStats(hunks);
            AgentConsole.getInstance().change(rel, kind, stats[0], stats[1]);
            this.diffReporter?.({
                path: rel, kind,
                diffText: formatDiff(hunks),
                stats
            });
            return;
        }

        const lines = (newContent ?? oldContent ?? '').split('\n').length;
        const stats: [number, number] = kind === 'erstellt' ? [0, lines] : [lines, 0];
        AgentConsole.getInstance().change(rel, kind, stats[0], stats[1]);
        this.diffReporter?.({ path: rel, kind, diffText: '', stats });
    }
}
