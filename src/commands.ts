/**
 * Slash commands typed into the chat: `/goal`, `/loop`, `/help`.
 *
 * The model never sees these. They are handled before the request goes out –
 * a `/loop` sent to the model would only produce a description of a loop, not
 * a loop.
 *
 * The two that matter work together:
 *
 *   `/goal <text>`  sets a standing objective. It survives every round, every
 *                   loop and the end of the session, and goes into the system
 *                   prompt on every request.
 *   `/loop <budget> <task>`  works towards that objective repeatedly until the
 *                   budget is spent, the assistant reports the objective as
 *                   reached, or the user cancels.
 *
 * Both are modelled on Claude Code, which tracks an `active_goal` alongside the
 * conversation and re-fires the loop prompt on every iteration.
 */

/** A parsed slash command. */
export interface ParsedCommand {
    name: 'goal' | 'loop' | 'help';
    /** Everything after the command word, trimmed. */
    rest: string;
}

/** How long a loop may run. */
export interface LoopBudget {
    /** Wall-clock limit in minutes. */
    minutes: number;
    /** Hard limit on rounds – a second brake in case a round returns instantly. */
    rounds: number;
    /** What the user actually wrote, for the message in the chat. */
    label: string;
}

const DEFAULT_MINUTES = 10;
const DEFAULT_ROUNDS = 6;

/** Upper limits. A loop changes files and costs tokens; it must not run away. */
const MAX_MINUTES = 120;
const MAX_ROUNDS = 40;

/**
 * Read a slash command off the start of a message.
 *
 * Only the very beginning counts. A message that merely mentions `/goal`
 * somewhere in a sentence is an ordinary message.
 */
export function parseCommand(text: string): ParsedCommand | null {
    const m = /^\s*\/(goal|ziel|loop|schleife|help|hilfe)\b\s*([\s\S]*)$/i.exec(text);
    if (!m) return null;

    const word = m[1].toLowerCase();
    const name: ParsedCommand['name'] =
        word === 'ziel' ? 'goal'
            : word === 'schleife' ? 'loop'
                : word === 'hilfe' ? 'help'
                    : word as ParsedCommand['name'];

    return { name, rest: (m[2] ?? '').trim() };
}

/**
 * Read a time or round budget off the start of a `/loop` argument.
 *
 * Accepted: `5m`, `5 min`, `5 Minuten`, `2h`, `2 Stunden`, `3x`, `3 mal`,
 * `3 Runden`. Everything after that is the task.
 *
 * Deliberately forgiving about word order and language: the user types this
 * in a hurry, and a loop that refuses to start over a missing unit is worse
 * than one that assumes minutes.
 */
export function parseBudget(rest: string): { budget: LoopBudget; task: string } {
    const trimmed = rest.trim();

    const time = /^(\d+)\s*(m|min|minute|minuten|minutes|h|std|stunde|stunden|hours?)\b\.?\s*/i
        .exec(trimmed);
    if (time) {
        const value = parseInt(time[1], 10);
        const isHours = /^(h|std|stunde|stunden|hours?)$/i.test(time[2]);
        const minutes = Math.min(MAX_MINUTES, Math.max(1, isHours ? value * 60 : value));
        return {
            budget: {
                minutes,
                rounds: MAX_ROUNDS,
                label: isHours ? `${value} Stunde(n)` : `${minutes} Minute(n)`
            },
            task: trimmed.slice(time[0].length).trim()
        };
    }

    const count = /^(\d+)\s*(x|mal|runden?|rounds?|iterations?|durchl[äa]ufe?)\b\.?\s*/i
        .exec(trimmed);
    if (count) {
        const rounds = Math.min(MAX_ROUNDS, Math.max(1, parseInt(count[1], 10)));
        return {
            budget: { minutes: MAX_MINUTES, rounds, label: `${rounds} Runde(n)` },
            task: trimmed.slice(count[0].length).trim()
        };
    }

    // A bare number without a unit means minutes – that is what people mean
    // when they type "/loop 5".
    const bare = /^(\d+)\s+/.exec(trimmed);
    if (bare) {
        const minutes = Math.min(MAX_MINUTES, Math.max(1, parseInt(bare[1], 10)));
        return {
            budget: { minutes, rounds: MAX_ROUNDS, label: `${minutes} Minute(n)` },
            task: trimmed.slice(bare[0].length).trim()
        };
    }

    return {
        budget: {
            minutes: DEFAULT_MINUTES,
            rounds: DEFAULT_ROUNDS,
            label: `${DEFAULT_MINUTES} Minuten`
        },
        task: trimmed
    };
}

/** Help text for `/help` – shown in the chat, therefore German. */
export const HELP_TEXT = [
    '**Befehle**',
    '',
    '| Befehl | Wirkung |',
    '|---|---|',
    '| `/goal <Text>` | Ziel setzen. Gilt für jede weitere Anfrage und überlebt die Sitzung. |',
    '| `/goal` | Aktuelles Ziel anzeigen. |',
    '| `/goal löschen` | Ziel entfernen. |',
    '| `/loop <Budget> <Aufgabe>` | Arbeitet wiederholt am Ziel, bis das Budget aufgebraucht ist. |',
    '| `/help` | Diese Übersicht. |',
    '',
    '**Budget für `/loop`:** `5m`, `30 Minuten`, `2h`, `3x`, `3 Runden`.',
    'Ohne Angabe: 10 Minuten, höchstens 6 Runden.',
    '',
    'Die Schleife endet, sobald das Budget aufgebraucht ist, der Assistent das Ziel',
    'als erreicht meldet – oder du auf **Abbrechen** klickst. Eine neue Anweisung',
    'im Eingabefeld unterbricht sie ebenfalls.',
    '',
    '**Beispiel**',
    '',
    '```',
    '/goal Der Parser versteht Variablen und alle Tests sind grün',
    '/loop 15m Finde die offenen Punkte und arbeite sie ab',
    '```'
].join('\n');
