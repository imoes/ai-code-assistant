import * as fs from 'fs';
import * as path from 'path';
import { FileManager } from './fileManager';
import { Logger } from './logger';

/** Ergebnis einer Analyse-Aktion – wird als Text an die KI zurückgegeben. */
export interface AnalysisResult {
    /** Menschlich lesbare Kurzbeschreibung (Chat-Label) */
    description: string;
    /** Formatierter Text für den KI-Kontext */
    output: string;
    /** false wenn nichts gefunden wurde bzw. ein Fehler auftrat */
    success: boolean;
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
 * CodeAnalyzer: Nur-Lese-Werkzeuge zur Code-Analyse (read_file, grep, glob, list_dir).
 *
 * Alles läuft nativ in Node – kein WSL, keine Shell, keine Bestätigung nötig.
 * Damit kann der Assistent den bestehenden Code untersuchen BEVOR er ihn ändert,
 * genau wie ein menschlicher Entwickler.
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
     * Datei mit Zeilennummern lesen.
     * @param rawPath  Pfad relativ zum Workspace (absolute Pfade werden gekürzt)
     * @param offset   1-basierte Startzeile (Standard 1)
     * @param limit    Maximale Zeilenanzahl (Standard 400)
     */
    readFile(rawPath: string, offset = 1, limit = 400): AnalysisResult {
        const relPath = this.displayPath(rawPath);
        let abs: string;
        try {
            abs = this.fileManager.resolvePath(rawPath);
        } catch (err) {
            return { description: `read_file: ${relPath}`, output: (err as Error).message, success: false };
        }

        if (!fs.existsSync(abs)) {
            // Hilfreiche Alternative anbieten statt nur "nicht gefunden"
            const suggestions = this.findSimilarPaths(relPath);
            const hint = suggestions.length
                ? `\n\nMeintest du eine dieser Dateien?\n${suggestions.join('\n')}`
                : '';
            return {
                description: `read_file: ${relPath}`,
                output: `Datei nicht gefunden: ${relPath}${hint}`,
                success: false
            };
        }

        const stat = fs.statSync(abs);
        if (stat.isDirectory()) {
            return this.listDir(rawPath);
        }
        if (stat.size > MAX_FILE_BYTES) {
            return {
                description: `read_file: ${relPath}`,
                output: `Datei zu groß (${Math.round(stat.size / 1024)} KB). Nutze grep um gezielt zu suchen.`,
                success: false
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
            ? `\n… [Zeile ${end + 1}–${lines.length} nicht angezeigt – read_file mit offset: ${end + 1} fortsetzen]`
            : '';

        this.logger.info(`read_file: ${relPath} (Zeile ${start}–${end} von ${lines.length})`);

        // Die Ausgabe wiederholt den Pfad NICHT: die Anzeige hat ihn schon in
        // der Kopfzeile, und im Chat las man ihn sonst zweimal. Die Gesamtzahl
        // der Zeilen wandert in die Beschreibung, wo sie hingehört.
        const range = end < lines.length || start > 1
            ? `L${start}–${end} von ${lines.length}`
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
     * Regex-Suche über den Workspace (wie ripgrep).
     * @param pattern       JavaScript-Regex
     * @param globPattern   optionaler Datei-Filter, z.B. "*.ts"
     * @param searchPath    optionaler Unterordner
     * @param ignoreCase    Groß-/Kleinschreibung ignorieren
     * @param maxResults    Trefferlimit
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
            return { description: label, output: `Ungültiges Regex-Muster: ${(err as Error).message}`, success: false };
        }

        let root: string;
        let workspaceRoot: string;
        try {
            workspaceRoot = this.fileManager.getWorkspaceRoot();
            root = searchPath ? this.fileManager.resolvePath(searchPath) : workspaceRoot;
        } catch (err) {
            return { description: label, output: (err as Error).message, success: false };
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
            if (this.looksBinary(content)) continue;   // Binärdatei überspringen

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

        this.logger.info(`grep "${pattern}" → ${hits.length} Treffer in ${filesWithHits} Datei(en)`);

        if (hits.length === 0) {
            return {
                description: label,
                output: `Keine Treffer für /${pattern}/${scope ? ` in ${scope}` : ""}.`,
                success: false
            };
        }

        const footer = truncated ? `\n… [Limit ${maxResults} erreicht – Muster verfeinern]` : '';
        return {
            description: `${label} → ${hits.length} Treffer`,
            output: `${hits.length} Treffer in ${filesWithHits} Datei(en):\n${hits.join('\n')}${footer}`,
            success: true
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // glob
    // ──────────────────────────────────────────────────────────────────────────

    /** Dateien nach Glob-Muster finden. */
    glob(globPattern: string, maxResults = 200): AnalysisResult {
        const label = `glob: ${globPattern}`;
        let root: string;
        try { root = this.fileManager.getWorkspaceRoot(); }
        catch (err) { return { description: label, output: (err as Error).message, success: false }; }

        const globRe = this.globToRegex(globPattern);
        const matches: string[] = [];

        for (const abs of this.walk(root)) {
            const rel = path.relative(root, abs).replace(/\\/g, '/');
            if (globRe.test(rel) || globRe.test(path.basename(rel))) {
                matches.push(rel);
                if (matches.length >= maxResults) break;
            }
        }

        this.logger.info(`glob "${globPattern}" → ${matches.length} Datei(en)`);
        if (matches.length === 0) {
            return { description: label, output: `Keine Datei passt auf "${globPattern}".`, success: false };
        }
        return {
            description: `${label} → ${matches.length} Datei(en)`,
            output: `${matches.length} Datei(en):\n${matches.join('\n')}`,
            success: true
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // list_dir
    // ──────────────────────────────────────────────────────────────────────────

    /** Verzeichnisinhalt auflisten (eine Ebene, mit Dateigrößen). */
    listDir(rawPath = '.'): AnalysisResult {
        const relPath = rawPath === '.' ? '.' : this.displayPath(rawPath);
        const label = `list_dir: ${relPath}`;
        let abs: string;
        try { abs = this.fileManager.resolvePath(rawPath); }
        catch (err) { return { description: label, output: (err as Error).message, success: false }; }

        if (!fs.existsSync(abs)) {
            return { description: label, output: `Verzeichnis nicht gefunden: ${relPath}`, success: false };
        }

        const entries: string[] = [];
        try {
            const sorted = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => {
                if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            for (const e of sorted) {
                if (e.isDirectory()) {
                    entries.push(`${e.name}/${IGNORE_DIRS.has(e.name) ? '   (übersprungen)' : ''}`);
                } else {
                    let size = '';
                    try { size = `  ${Math.max(1, Math.round(fs.statSync(path.join(abs, e.name)).size / 1024))} KB`; }
                    catch { /* egal */ }
                    entries.push(`${e.name}${size}`);
                }
            }
        } catch (err) {
            return { description: label, output: `Lesefehler: ${(err as Error).message}`, success: false };
        }

        return {
            description: `${label} → ${entries.length} Einträge`,
            output: `Inhalt von ${relPath}:\n${entries.join('\n')}`,
            success: true
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Projekt-Überblick (für den ersten Prompt)
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Kompakter Projektüberblick: Dateibaum nach Ordner gruppiert + erkannte
     * Sprachen/Build-Tools. Deutlich informativer als eine flache Dateiliste.
     */
    projectOverview(maxFiles = 400): string {
        let root: string;
        try { root = this.fileManager.getWorkspaceRoot(); }
        catch { return '(Kein Workspace geöffnet)'; }

        const files = [...this.walk(root)].slice(0, maxFiles)
            .map(f => path.relative(root, f).replace(/\\/g, '/'));

        // Nach Verzeichnis gruppieren
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
            detected.length ? `\n\nErkanntes Projekt:\n${detected.join('\n')}` : '',
            `\n\nDateistruktur (${files.length}${files.length >= maxFiles ? '+' : ''} Dateien):\n${treeLines.join('\n')}`
        ].join('');
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Interne Helfer
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Pfad für die Anzeige auf Workspace-relativ kürzen.
     *
     * Modelle übergeben oft absolute Pfade. Unverändert übernommen sprengen die
     * jedes Chat-Label und jede Log-Zeile – und sagen nichts, was der relative
     * Pfad nicht kürzer sagt.
     */
    private displayPath(relOrAbs: string): string {
        try {
            const root = this.fileManager.getWorkspaceRoot();
            const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(root, relOrAbs);
            const rel = path.relative(root, abs).replace(/\\/g, '/');
            // Außerhalb des Workspace (beginnt mit ..) → Originalangabe behalten
            return rel && !rel.startsWith('..') ? rel : relOrAbs;
        } catch {
            return relOrAbs;
        }
    }

    /** Heuristik: enthält der Text ein NUL-Byte, ist es keine Quelldatei. */
    private looksBinary(content: string): boolean {
        return content.indexOf(String.fromCharCode(0)) !== -1;
    }

    /** Rekursiver Datei-Iterator, überspringt Ignore-Verzeichnisse. */
    private *walk(dir: string, depth = 0): Generator<string> {
        if (depth > 8) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
            if (IGNORE_DIRS.has(e.name)) continue;
            // Versteckte Verzeichnisse überspringen (außer .claude/.github)
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

    /** Glob-Muster in Regex übersetzen. Unterstützt **, *, ? und {a,b}. */
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

    /** Ähnliche Dateinamen finden (Tippfehler-Hilfe bei read_file). */
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
