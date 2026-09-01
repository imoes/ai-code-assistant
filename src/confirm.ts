/**
 * confirm.ts – Shared types for the in-chat confirmation system.
 */

/**
 * Optional diff metadata passed to the Confirm card.
 * Enables the colored diff display and the "Open in Editor" button.
 */
export interface DiffMeta {
    /** Unified diff string for inline display (formatDiff()) */
    diffText: string;
    /** Absolute path of the old file – for vscode.diff() */
    oldUri: string;
    /** New content – is saved as a temp. file for vscode.diff() */
    newContent: string;
    /** Stats: [removed lines, added lines] */
    stats: [number, number];
}

/**
 * Confirmation function: shows a persistent map in the chat.
 * Waits until the user clicks a button and returns its label.
 *
 * @param message   Nachricht (Markdown, **fett** erlaubt)
 * @param choices   Buttons (first = primary action)
 * @param diff      Optional diff metadata for colored diff display
 */
export type ConfirmFn = (
    message: string,
    choices: string[],
    diff?: DiffMeta
) => Promise<string>;

/** No confirmation – select first option immediately (autoApply) */
export const autoConfirmFn: ConfirmFn = async (_msg, choices) => choices[0];

/** An already applied file change, for display in the chat. */
export interface AppliedChange {
    /** Path relative to the Workspace */
    path: string;
    /** What happened */
    kind: 'created' | 'changed' | 'deleted';
    /** Unified diff for colored display (empty for new/deleted files) */
    diffText: string;
    /** [removed lines, added lines] */
    stats: [number, number];
}

/**
 * Reports an applied change to the interface.
 *
 * Required, because in auto-mode no confirmation card appears – without this
 * The user would never see what the assistant changed.
 */
export type DiffReporter = (change: AppliedChange) => void;
