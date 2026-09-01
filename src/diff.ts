/**
 * diff.ts – LCS-basierter Zeilen-Diff-Algorithmus.
 *
 * Returns structured diff lines that are rendered in color in the WebView
 * and can be opened in the VSCode-Diff-Editor.
 */

export type DiffLineType = 'add' | 'remove' | 'context' | 'hunk';

export interface DiffLine {
    type: DiffLineType;
    text: string;
    oldNo?: number;   // Zeilennummer in der alten Datei
    newNo?: number;   // Zeilennummer in der neuen Datei
}

export interface DiffHunk {
    oldStart: number;
    newStart: number;
    lines: DiffLine[];
}

/**
 * Calculates the line diff between two texts using LCS.
 * Returns hunks (contiguous change blocks) each with `contextLines`
 * Context lines above and below.
 *
 * @param oldText      Alter Dateiinhalt
 * @param newText      Neuer Dateiinhalt
 * @param contextLines Anzahl Kontext-Zeilen pro Hunk (Standard: 3)
 * @param maxLines     Maximum number of lines per page (protection against huge diffs)
 */
export function computeDiff(
    oldText: string,
    newText: string,
    contextLines = 3,
    maxLines = 400
): DiffHunk[] {
    const oldLines = oldText.split('\n').slice(0, maxLines);
    const newLines = newText.split('\n').slice(0, maxLines);

    const raw = lcs(oldLines, newLines);
    return buildHunks(raw, contextLines);
}

/**
 * Returns the diff as a formatted string (unified-diff-like).
 * Is passed as the `detail` string to the Confirm card.
 */
export function formatDiff(hunks: DiffHunk[]): string {
    if (hunks.length === 0) return '(no changes)';

    const lines: string[] = [];
    for (const hunk of hunks) {
        const oldCount = hunk.lines.filter(l => l.type !== 'add').length;
        const newCount = hunk.lines.filter(l => l.type !== 'remove').length;
        lines.push(`@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`);
        for (const l of hunk.lines) {
            const prefix = l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' ';
            lines.push(`${prefix}${l.text}`);
        }
    }
    return lines.join('\n');
}

/**
 * Counts changed lines: [removed, added]
 */
export function diffStats(hunks: DiffHunk[]): [number, number] {
    let removed = 0, added = 0;
    for (const h of hunks) {
        for (const l of h.lines) {
            if (l.type === 'remove') removed++;
            else if (l.type === 'add') added++;
        }
    }
    return [removed, added];
}

// ──────────────────────────────────────────────────────────────────────────────
// Merge sequence (for SmartMerge in fileManager)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Eine einzelne Zeile im Merge-Ergebnis.
 * 'keep' = in beiden Versionen vorhanden
 * 'add'  = KI hat sie hinzugefügt
 * 'remove' = KI hat sie entfernt (war im Original)
 */
export interface MergeLine {
    type: 'keep' | 'add' | 'remove';
    text: string;
    oldLineNo: number;  // 1-basiert; 0 für 'add'
    newLineNo: number;  // 1-basiert; 0 für 'remove'
}

/**
 * Returns the complete LCS sequence (no hunk grouping).
 * Used by fileManager.smartMergeEdit() to only apply additions.
 */
export function computeMergeSequence(oldText: string, newText: string, maxLines = 500): MergeLine[] {
    const oldLines = oldText.split('\n').slice(0, maxLines);
    const newLines = newText.split('\n').slice(0, maxLines);
    const raw = lcs(oldLines, newLines);
    return raw.map(r => ({
        type: r.type === 'context' ? 'keep' : r.type,
        text: r.text,
        oldLineNo: r.oldNo,
        newLineNo: r.newNo
    }));
}

// ──────────────────────────────────────────────────────────────────────────────
// Interner LCS + Hunk-Bau
// ──────────────────────────────────────────────────────────────────────────────

interface RawLine {
    type: 'add' | 'remove' | 'context';
    text: string;
    oldNo: number;
    newNo: number;
}

function lcs(oldLines: string[], newLines: string[]): RawLine[] {
    const m = oldLines.length;
    const n = newLines.length;

    // DP table: Memory requirement O(m*n) – with maxLines=400 → 160k entries, ok
    const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    // Backtracking
    const result: RawLine[] = [];
    let i = m, j = n;
    let oldNo = m, newNo = n;

    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
            result.unshift({ type: 'context', text: oldLines[i - 1], oldNo: i, newNo: j });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            result.unshift({ type: 'add', text: newLines[j - 1], oldNo: 0, newNo: j });
            j--;
        } else {
            result.unshift({ type: 'remove', text: oldLines[i - 1], oldNo: i, newNo: 0 });
            i--;
        }
        void oldNo; void newNo; // suppress unused warning
    }

    return result;
}

function buildHunks(raw: RawLine[], ctx: number): DiffHunk[] {
    // Find indices of the changed lines
    const changed = raw
        .map((l, i) => ({ i, changed: l.type !== 'context' }))
        .filter(x => x.changed)
        .map(x => x.i);

    if (changed.length === 0) return [];

    // Summarize changes to groups
    const groups: [number, number][] = [];
    let start = changed[0], end = changed[0];

    for (let k = 1; k < changed.length; k++) {
        if (changed[k] - end <= ctx * 2 + 1) {
            end = changed[k];
        } else {
            groups.push([start, end]);
            start = changed[k];
            end = changed[k];
        }
    }
    groups.push([start, end]);

    // Build hunks from groups
    const hunks: DiffHunk[] = [];
    for (const [gs, ge] of groups) {
        const from = Math.max(0, gs - ctx);
        const to   = Math.min(raw.length - 1, ge + ctx);
        const slice = raw.slice(from, to + 1);

        const firstOld = slice.find(l => l.oldNo > 0)?.oldNo ?? 1;
        const firstNew = slice.find(l => l.newNo > 0)?.newNo ?? 1;

        hunks.push({
            oldStart: firstOld,
            newStart: firstNew,
            lines: slice.map(l => ({
                type: l.type,
                text: l.text,
                oldNo: l.oldNo,
                newNo: l.newNo
            }))
        });
    }

    return hunks;
}
