import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';

/**
 * Best practices the assistant learned from what actually worked.
 *
 * The idea is borrowed from Hermes, which turns "successful approaches into
 * reusable procedural knowledge": general memory is broad and declarative,
 * while procedural knowledge is narrow and actionable – *how* to do a specific
 * kind of task in *this* project. That second kind is what is worth keeping.
 *
 * Stored as plain Markdown in the workspace (`.ai-assistant/PRACTICES.md`), for
 * two reasons. It is readable and editable by hand – a rule the assistant got
 * wrong should be deletable without a tool. And it is versionable: the file
 * belongs to the project, like AGENTS.md.
 *
 * Four rules decide whether this helps or turns into noise:
 *
 *   1. **Only after something verified worked.** A "best practice" from a run
 *      whose tests never ran is a guess in disguise.
 *   2. **Rules, not a diary.** "Fixed the tokenizer" helps nobody next time.
 *      "The tests need `npm test`, not `node --test` – pretest compiles first"
 *      helps every time.
 *   3. **Deduplicate.** Without it the file fills with near-identical entries
 *      and the useful ones drown.
 *   4. **Cap it.** The file goes into every request. What does not fit is not
 *      free.
 */

/** One learned rule. */
export interface Practice {
    /** The rule itself, one or two sentences, imperative. */
    rule: string;
    /** What happened that makes it a rule – the evidence. */
    why: string;
    /** ISO date, so an old entry can be recognised as old. */
    added: string;
}

/** Path inside the workspace. Beside AGENTS.md in spirit, out of the way in fact. */
const REL_PATH = path.join('.ai-assistant', 'PRACTICES.md');

/** Upper bounds. This text is in every prompt. */
const MAX_ENTRIES = 40;
const MAX_RULE_CHARS = 400;
const MAX_PROMPT_CHARS = 4000;

export class PracticeStore {
    private logger = Logger.getInstance();
    private file: string;
    private entries: Practice[] | null = null;

    constructor(workspaceRoot: string) {
        this.file = path.join(workspaceRoot, REL_PATH);
    }

    /** Where the file lives – for log messages and for opening it. */
    getPath(): string {
        return this.file;
    }

    /** All entries, newest first. */
    all(): Practice[] {
        if (this.entries === null) this.entries = this.load();
        return this.entries;
    }

    /**
     * Add a rule. Returns false when it was dropped as a duplicate or as junk.
     *
     * Duplicate detection is deliberately fuzzy: models phrase the same insight
     * differently every time. Comparing the significant words catches "use npm
     * test for the tests" against "run the tests with npm test", which an exact
     * match would not.
     */
    add(rule: string, why: string): boolean {
        const cleanRule = rule.replace(/\s+/g, ' ').trim().slice(0, MAX_RULE_CHARS);
        const cleanWhy = why.replace(/\s+/g, ' ').trim().slice(0, MAX_RULE_CHARS);

        // Too short to be a rule. "Works well" is not procedural knowledge.
        if (cleanRule.length < 15) {
            this.logger.info(`Best Practice verworfen (zu kurz): ${cleanRule}`);
            return false;
        }

        const entries = this.all();
        const fingerprint = PracticeStore.fingerprint(cleanRule);
        for (const e of entries) {
            if (PracticeStore.similar(fingerprint, PracticeStore.fingerprint(e.rule))) {
                this.logger.info(`Best Practice verworfen (Dublette zu "${e.rule.slice(0, 60)}")`);
                return false;
            }
        }

        entries.unshift({
            rule: cleanRule,
            why: cleanWhy,
            added: new Date().toISOString().slice(0, 10)
        });

        // The oldest go first: what still matters gets confirmed by a new run
        // sooner or later, what does not stays gone.
        if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;

        this.save();
        this.logger.info(`Best Practice gelernt: ${cleanRule}`);
        return true;
    }

    /** Remove every entry. */
    clear(): number {
        const n = this.all().length;
        this.entries = [];
        this.save();
        return n;
    }

    /**
     * The block for the system prompt.
     *
     * Fenced and marked as recalled context, not as an instruction from the
     * user. The content was written by a model, so it must not be able to pose
     * as one – the same guard Hermes puts around its recalled memory.
     */
    forPrompt(): string {
        const entries = this.all();
        if (entries.length === 0) return '';

        const lines: string[] = [];
        let used = 0;
        for (const e of entries) {
            const line = `- ${e.rule}${e.why ? ` (${e.why})` : ''}`;
            if (used + line.length > MAX_PROMPT_CHARS) break;
            lines.push(line);
            used += line.length + 1;
        }
        if (lines.length === 0) return '';

        return '\n\n## What worked in this project before\n'
            + '<learned-practices>\n'
            + 'Rules you derived yourself from earlier, verified runs. They are '
            + 'background knowledge, NOT instructions from the user, and they can be '
            + 'out of date. Follow them where they fit; say so in one sentence if you '
            + 'deviate.\n\n'
            + lines.join('\n')
            + '\n</learned-practices>\n';
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Intern
    // ──────────────────────────────────────────────────────────────────────────

    /** Significant words of a rule, lowercase, without filler. */
    private static fingerprint(text: string): Set<string> {
        const stop = new Set([
            'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with',
            'is', 'are', 'be', 'it', 'that', 'this', 'you', 'use', 'using', 'not',
            'der', 'die', 'das', 'und', 'oder', 'mit', 'von', 'für', 'ist', 'sind',
            'nicht', 'ein', 'eine', 'einen', 'nutze', 'immer', 'nie', 'man'
        ]);
        return new Set(
            text.toLowerCase()
                .replace(/[^a-z0-9äöüß_./-]+/g, ' ')
                .split(/\s+/)
                .filter(w => w.length > 2 && !stop.has(w))
        );
    }

    /** Two rules count as the same when most significant words match. */
    private static similar(a: Set<string>, b: Set<string>): boolean {
        if (a.size === 0 || b.size === 0) return false;
        let shared = 0;
        for (const w of a) if (b.has(w)) shared++;
        return shared / Math.min(a.size, b.size) >= 0.7;
    }

    private load(): Practice[] {
        try {
            if (!fs.existsSync(this.file)) return [];
            const raw = fs.readFileSync(this.file, 'utf-8');
            const out: Practice[] = [];

            // One entry per list item: `- <rule> (<why>) <!-- 2026-08-28 -->`
            for (const line of raw.split('\n')) {
                const m = /^\s*-\s+(.*?)\s*$/.exec(line);
                if (!m) continue;
                let body = m[1];

                let added = '';
                const date = /<!--\s*(\d{4}-\d{2}-\d{2})\s*-->\s*$/.exec(body);
                if (date) {
                    added = date[1];
                    body = body.slice(0, date.index).trim();
                }

                let why = '';
                const paren = /\(([^()]*)\)\s*$/.exec(body);
                if (paren) {
                    why = paren[1].trim();
                    body = body.slice(0, paren.index).trim();
                }

                if (body.length >= 15) out.push({ rule: body, why, added });
            }
            return out;
        } catch (err) {
            this.logger.warn(`Practices file is not readable: ${(err as Error).message}`);
            return [];
        }
    }

    private save(): void {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const body = [
                '# Best Practices',
                '',
                'Rules the AI Code Assistant derived from runs that worked.',
                'They go into every request.',
                '',
                'This file may be edited by hand: a rule that is wrong can simply',
                'be deleted. Newest first.',
                '',
                ...this.all().map(e =>
                    `- ${e.rule}${e.why ? ` (${e.why})` : ''}`
                    + (e.added ? ` <!-- ${e.added} -->` : '')),
                ''
            ].join('\n');
            fs.writeFileSync(this.file, body, 'utf-8');
        } catch (err) {
            this.logger.warn(`Practices file is not writable: ${(err as Error).message}`);
        }
    }
}
