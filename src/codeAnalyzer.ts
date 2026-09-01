import * as fs from 'fs';
import * as path from 'path';
import { FileManager } from './fileManager';
import { Logger } from './logger';

/** Result of an analysis action – returned as text to the AI. */
export interface AnalysisResult {
    /** Menschlich lesbare Kurzbeschreibung (Chat-Label) */
    description: string;
    /** Formatted text for the AI context */
    output: string;
    /** false wenn nichts gefunden wurde bzw. ein Fehler auftrat */
    success: boolean;
    /**
     * true, wenn die Analyse gar nicht durchgeführt werden konnte – Datei fehlt,
     * Pfad außerhalb des Workspace, ungültiges Muster.
     *
     * Nötig, weil `success: false` zwei sehr verschiedene Dinge bedeutet: „keine
     * Treffer" (ein gültiges Ergebnis) und „ging nicht" (ein Fehlschlag). Die
     * Engine hat deshalb pauschal `success: true` gemeldet – und im Fenster-Lauf
     * galten sieben abgelehnte Lesevorgänge als erfolgreiche Analyse. Das Modell
     * arbeitete eine Runde blind, und die Schleife hielt das für getane Arbeit.
     */
    error?: boolean;
}

const IGNORE_DIRS = new Set([
    'node_modules', '.git', 'out', 'dist', '.next', '__pycache__',
    '.venv', 'venv', 'target', '.cache', 'build', 'coverage',
    '.nyc_output', '.idea', '.vscode-test', 'vendor', '.gradle'
]);

const BINARY_EXT = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svgz',
    '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so',
    '.dylib', '.class', '.jar', '.wasm', '.mp3', '.mp4', '.avi', '.mov',
    '.woff', '.woff2', '.ttf', '.eot', '.vsix', '.bin'
]);

const MAX_FILE_BYTES = 2_000_000;

/**
 * CodeAnalyzer: Read-only tools for code analysis (read_file, grep, glob, list_dir).
 *
 * Everything runs natively in Node – no WSL, no shell, no confirmation required.
 * This allows the assistant to examine the existing code BEFORE modifying it,
 * just like a human developer.
 */
export class CodeAnalyzer {
    private static instance: CodeAnalyzer;
    private fileManager = FileManager.getInstance();
    private logger = Logger.getInstance();

    static getInstance(): CodeAnalyzer {
        if (!CodeAnalyzer.instance) {
            CodeAnalyzer.instance = new CodeAnalyzer();
        }
        return CodeAnalyzer.instance;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // read_file
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Read file with line numbers.
     * @param rawPath  Path relative to the workspace (absolute paths are truncated)
     * @param offset   1-basierte Startzeile (Standard 1)
     * @param limit    Maximale Zeilenanzahl (Standard 400)
     */
    readFile(rawPath: string, offset = 1, limit = 400): AnalysisResult {
        const relPath = this.displayPath(rawPath);
        let abs: string;
        try {
            abs = this.fileManager.resolvePath(rawPath);
        } catch (err) {
            return { description: `read_file: ${relPath}`, output: (err as Error).message, success: false, error: true };
        }

        if (!fs.existsSync(abs)) {
            // Offer a helpful alternative instead of just "not found"
            const suggestions = this.findSimilarPaths(relPath);
            const hint = suggestions.length
                ? `\n\nDid you mean one of these files?\n${suggestions.join('\n')}`
                : '';
            return {
                description: `read_file: ${relPath}`,
                output: `File not found: ${relPath}${hint}`,
                success: false,
                error: true
            };
        }

        const stat = fs.statSync(abs);
        if (stat.isDirectory()) {
            return this.listDir(rawPath);
        }
        if (stat.size > MAX_FILE_BYTES) {
            return {
                description: `read_file: ${relPath}`,
                output: `File too large (${Math.round(stat.size / 1024)} KB). Use grep to search for what you need.`,
                success: false,
                error: true
            };
        }

        const lines = fs.readFileSync(abs, 'utf-8').split('\n');
        const start = Math.max(1, offset);
        const end = Math.min(lines.length, start + Math.max(1, limit) - 1);
        const width = String(end).length;

        const body = lines.slice(start - 1, end)
            .map((l, i) => `${String(start + i).padStart(width)} | ${l}`)
            .join('\n');

        const footer = end < lines.length
            ? `\n… [lines ${end + 1}–${lines.length} not shown – continue with read_file offset: ${end + 1}]`
            : '';

        this.logger.info(`read_file: ${relPath} (lines ${start}–${end} of ${lines.length})`);

        // The output does NOT repeat the path: the display already shows it in
        // the header, and otherwise it would appear twice in the chat. The total number
        // of lines moves to the description, where it belongs.
        const range = end < lines.length || start > 1
            ? `L${start}–${end} of ${lines.length}`
            : `${lines.length} Zeilen`;
        return {
            description: `read_file: ${relPath} (${range})`,
            output: `${body}${footer}`,
            success: true
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // grep
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Regex search across the workspace (like ripgrep).
     * @param pattern       JavaScript-Regex
     * @param globPattern   optionaler Datei-Filter, z.B. "*.ts"
     * @param searchPath    optionaler Unterordner
     * @param ignoreCase    ignore case
     * @param maxResults    limit on the number of hits
     */
    grep(
        pattern: string,
        globPattern?: string,
        searchPath?: string,
        ignoreCase = false,
        maxResults = 120
    ): AnalysisResult {
        const scope = globPattern ?? (searchPath ? this.displayPath(searchPath) : undefined);
        const label = `grep: /${pattern}/${scope ? ` in ${scope}` : ''}`;

        let regex: RegExp;
        try {
            regex = new RegExp(pattern, ignoreCase ? 'i' : '');
        } catch (err) {
            return { description: label, output: `Invalid regular expression: ${(err as Error).message}`, success: false, error: true };
        }

        let root: string;
        let workspaceRoot: string;
        try {
            workspaceRoot = this.fileManager.getWorkspaceRoot();
            root = searchPath ? this.fileManager.resolvePath(searchPath) : workspaceRoot;
        } catch (err) {
            return { description: label, output: (err as Error).message, success: false, error: true };
        }

        const globRe = globPattern ? this.globToRegex(globPattern) : null;
        const hits: string[] = [];
        let filesWithHits = 0;
        let truncated = false;

        for (const abs of this.walk(root)) {
            if (hits.length >= maxResults) { truncated = true; break; }

            const rel = path.relative(workspaceRoot, abs).replace(/\\/g, '/');
            if (globRe && !globRe.test(rel) && !globRe.test(path.basename(rel))) continue;
            if (BINARY_EXT.has(path.extname(abs).toLowerCase())) continue;

            let content: string;
            try {
                if (fs.statSync(abs).size > MAX_FILE_BYTES) continue;
                content = fs.readFileSync(abs, 'utf-8');
            } catch { continue; }
            if (this.looksBinary(content)) continue;   // skip binary files

            const lines = content.split('\n');
            let fileHit = false;
            for (let i = 0; i < lines.length; i++) {
                if (!regex.test(lines[i])) continue;
                fileHit = true;
                hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
                if (hits.length >= maxResults) { truncated = true; break; }
            }
            if (fileHit) filesWithHits++;
        }

        this.logger.info(`grep "${pattern}" → ${hits.length} match(es) in ${filesWithHits} file(s)`);

        if (hits.length === 0) {
            return {
                description: label,
                output: `No matches for /${pattern}/${scope ? ` in ${scope}` : ""}.`,
                success: false
            };
        }

        const footer = truncated ? `\n… [Limit ${maxResults} erreicht – Muster verfeinern]` : '';
        return {
            description: `${label} → ${hits.length} match(es)`,
            output: `${hits.length} match(es) in ${filesWithHits} file(s):\n${hits.join('\n')}${footer}`,
            success: true
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // glob
    // ──────────────────────────────────────────────────────────────────────────

    /** Find files matching the glob pattern. */
    glob(globPattern: string, maxResults = 200): AnalysisResult {
        const label = `glob: ${globPattern}`;
        let root: string;
        try { root = this.fileManager.getWorkspaceRoot(); }
        catch (err) { return { description: label, output: (err as Error).message, success: false, error: true }; }

        const globRe = this.globToRegex(globPattern);
        const matches: string[] = [];

        for (const abs of this.walk(root)) {
            const rel = path.relative(root, abs).replace(/\\/g, '/');
            if (globRe.test(rel) || globRe.test(path.basename(rel))) {
                matches.push(rel);
                if (matches.length >= maxResults) break;
            }
        }

        this.logger.info(`glob "${globPattern}" → ${matches.length} file(s)`);
        if (matches.length === 0) {
            return { description: label, output: `No file matches "${globPattern}".`, success: false };
        }
        return {
            description: `${label} → ${matches.length} file(s)`,
            output: `${matches.length} file(s):\n${matches.join('\n')}`,
            success: true
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // list_dir
    // ──────────────────────────────────────────────────────────────────────────

    /** List directory contents (one level, with file sizes). */
    listDir(rawPath = '.'): AnalysisResult {
        const relPath = rawPath === '.' ? '.' : this.displayPath(rawPath);
        const label = `list_dir: ${relPath}`;
        let abs: string;
        try { abs = this.fileManager.resolvePath(rawPath); }
        catch (err) { return { description: label, output: (err as Error).message, success: false, error: true }; }

        if (!fs.existsSync(abs)) {
            return { description: label, output: `Directory not found: ${relPath}`, success: false, error: true };
        }

        const entries: string[] = [];
        try {
            const sorted = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => {
                if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            for (const e of sorted) {
                if (e.isDirectory()) {
                    entries.push(`${e.name}/${IGNORE_DIRS.has(e.name) ? '   (skipped)' : ''}`);
                } else {
                    let size = '';
                    try { size = `  ${Math.max(1, Math.round(fs.statSync(path.join(abs, e.name)).size / 1024))} KB`; }
                    catch { /* egal */ }
                    entries.push(`${e.name}${size}`);
                }
            }
        } catch (err) {
            return { description: label, output: `Lesefehler: ${(err as Error).message}`, success: false, error: true };
        }

        return {
            description: `${label} → ${entries.length} entries`,
            output: `Contents of ${relPath}:\n${entries.join('\n')}`,
            success: true
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Project Overview (for the first prompt)
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Compact project overview: file tree grouped by folder + detected
     * Languages/Build Tools. Much more informative than a flat file list.
     */
    projectOverview(maxFiles = 400): string {
        let root: string;
        try { root = this.fileManager.getWorkspaceRoot(); }
        catch { return '(no workspace open)'; }

        const files = [...this.walk(root)].slice(0, maxFiles)
            .map(f => path.relative(root, f).replace(/\\/g, '/'));

        // Group by directory
        const byDir = new Map<string, string[]>();
        for (const f of files) {
            const dir = path.posix.dirname(f);
            const list = byDir.get(dir) ?? [];
            list.push(path.posix.basename(f));
            byDir.set(dir, list);
        }

        const treeLines: string[] = [];
        for (const dir of [...byDir.keys()].sort()) {
            const names = byDir.get(dir)!;
            const shown = names.slice(0, 25).join(', ');
            const more = names.length > 25 ? `, … (+${names.length - 25})` : '';
            treeLines.push(`${dir === '.' ? '(root)' : dir + '/'}: ${shown}${more}`);
        }

        const markers: Record<string, string> = {
            'package.json': 'Node/npm  (Tests: npm test)',
            'tsconfig.json': 'TypeScript  (Build: npx tsc -p ./)',
            'Cargo.toml': 'Rust  (Tests: cargo test)',
            'pyproject.toml': 'Python  (Tests: pytest)',
            'requirements.txt': 'Python',
            'go.mod': 'Go  (Tests: go test ./...)',
            'pom.xml': 'Maven  (Tests: mvn test)',
            'build.gradle': 'Gradle  (Tests: ./gradlew test)',
            'Makefile': 'Make',
            'Dockerfile': 'Docker'
        };
        const detected = Object.keys(markers)
            .filter(m => fs.existsSync(path.join(root, m)))
            .map(m => `- ${m} → ${markers[m]}`);

        return [
            `Workspace: ${root}`,
            detected.length ? `\n\nProject detected:\n${detected.join('\n')}` : '',
            `\n\nDateistruktur (${files.length}${files.length >= maxFiles ? '+' : ''} Dateien):\n${treeLines.join('\n')}`
        ].join('');
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Interne Helfer
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Shorten the path for display to be workspace-relative.
     *
     * Models often pass absolute paths. Taken unchanged, they exceed
     * each chat label and each log line – and say nothing about the relative
     * Path not shorter says.
     */
    private displayPath(relOrAbs: string): string {
        try {
            const root = this.fileManager.getWorkspaceRoot();
            const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(root, relOrAbs);
            const rel = path.relative(root, abs).replace(/\\/g, '/');
            // Outside the workspace (starts with ..) → Keep original specification
            return rel && !rel.startsWith('..') ? rel : relOrAbs;
        } catch {
            return relOrAbs;
        }
    }

    /** Heuristic: if the text contains a NUL byte, it is not a source file. */
    private looksBinary(content: string): boolean {
        return content.indexOf(String.fromCharCode(0)) !== -1;
    }

    /** Recursive file iterator, skips ignore directories. */
    private *walk(dir: string, depth = 0): Generator<string> {
        if (depth > 8) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
            if (IGNORE_DIRS.has(e.name)) continue;
            // Skip hidden directories (except .claude/.github)
            if (e.isDirectory() && e.name.startsWith('.')
                && e.name !== '.claude' && e.name !== '.github') continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                yield* this.walk(full, depth + 1);
            } else if (e.isFile()) {
                yield full;
            }
        }
    }

    /** Translate glob patterns into regex. Supports **, *, ? and {a,b}. */
    private globToRegex(pattern: string): RegExp {
        const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
        let re = '';
        for (let i = 0; i < normalized.length; i++) {
            const c = normalized[i];
            if (c === '*') {
                if (normalized[i + 1] === '*') {
                    // ** → beliebig viele Pfadsegmente
                    if (normalized[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
                    else { re += '.*'; i += 1; }
                } else {
                    re += '[^/]*';
                }
            } else if (c === '?') {
                re += '[^/]';
            } else if (c === '{') {
                re += '(?:';
            } else if (c === '}') {
                re += ')';
            } else if (c === ',') {
                re += '|';
            } else {
                re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
            }
        }
        return new RegExp(`^${re}$`);
    }

    /** Find similar filenames (typo assistance for read_file). */
    private findSimilarPaths(relPath: string, max = 5): string[] {
        let root: string;
        try { root = this.fileManager.getWorkspaceRoot(); } catch { return []; }
        const target = path.basename(relPath).toLowerCase();
        const stem = target.replace(/\.[^.]+$/, '');
        const out: string[] = [];
        for (const abs of this.walk(root)) {
            const base = path.basename(abs).toLowerCase();
            const baseStem = base.replace(/\.[^.]+$/, '');
            if (base === target || (stem.length > 2 && (base.includes(stem) || stem.includes(baseStem)))) {
                out.push(path.relative(root, abs).replace(/\\/g, '/'));
                if (out.length >= max) break;
            }
        }
        return out;
    }
}
