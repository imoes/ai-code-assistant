/**
 * confirm.ts – Shared-Typen für das In-Chat-Bestätigungssystem.
 */

/**
 * Optionale Diff-Metadaten, die an die Confirm-Karte übergeben werden.
 * Ermöglicht die farbige Diff-Anzeige und den "In Editor öffnen"-Button.
 */
export interface DiffMeta {
    /** Unified-Diff-String für die Inline-Anzeige (formatDiff()) */
    diffText: string;
    /** Absoluter Pfad der alten Datei – für vscode.diff() */
    oldUri: string;
    /** Neuer Inhalt – wird als temp. Datei für vscode.diff() gespeichert */
    newContent: string;
    /** Stats: [entfernte Zeilen, hinzugefügte Zeilen] */
    stats: [number, number];
}

/**
 * Bestätigungs-Funktion: zeigt eine persistente Karte im Chat.
 * Wartet bis der Benutzer einen Button klickt und gibt dessen Label zurück.
 *
 * @param message   Nachricht (Markdown, **fett** erlaubt)
 * @param choices   Buttons (erster = primäre Aktion)
 * @param diff      Optionale Diff-Metadaten für farbige Diff-Anzeige
 */
export type ConfirmFn = (
    message: string,
    choices: string[],
    diff?: DiffMeta
) => Promise<string>;

/** Keine Bestätigung – erste Option sofort wählen (autoApply) */
export const autoConfirmFn: ConfirmFn = async (_msg, choices) => choices[0];
