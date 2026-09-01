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
                label: isHours ? `${value} hour(s)` : `${minutes} minute(s)`
            },
            task: trimmed.slice(time[0].length).trim()
        };
    }

    const count = /^(\d+)\s*(x|mal|runden?|rounds?|iterations?|durchl[äa]ufe?)\b\.?\s*/i
        .exec(trimmed);
    if (count) {
        const rounds = Math.min(MAX_ROUNDS, Math.max(1, parseInt(count[1], 10)));
        return {
            budget: { minutes: MAX_MINUTES, rounds, label: `${rounds} round(s)` },
            task: trimmed.slice(count[0].length).trim()
        };
    }

    // A bare number without a unit means minutes – that is what people mean
    // when they type "/loop 5".
    const bare = /^(\d+)\s+/.exec(trimmed);
    if (bare) {
        const minutes = Math.min(MAX_MINUTES, Math.max(1, parseInt(bare[1], 10)));
        return {
            budget: { minutes, rounds: MAX_ROUNDS, label: `${minutes} minute(s)` },
            task: trimmed.slice(bare[0].length).trim()
        };
    }

    return {
        budget: {
            minutes: DEFAULT_MINUTES,
            rounds: DEFAULT_ROUNDS,
            label: `${DEFAULT_MINUTES} minutes`
        },
        task: trimmed
    };
}

/**
 * Help text for `/help` – shown in the chat.
 *
 * English, like the rest of the interface. The German spellings of the commands
 * (`/ziel`, `/schleife`) still work – see COMMANDS – they are just not
 * advertised here: someone typing German will find them, and someone reading
 * this list does not need two names for one command.
 */
export const HELP_TEXT = [
    '**Commands**',
    '',
    '| Command | Effect |',
    '|---|---|',
    '| `/goal <text>` | Set the goal. Applies to every further request and outlives the session. |',
    '| `/goal` | Show the current goal. |',
    '| `/goal clear` | Remove the goal. |',
    '| `/loop <budget> <task>` | Works towards the goal repeatedly until the budget is spent. |',
    '| `/help` | This list. |',
    '',
    '**Budget for `/loop`:** `5m`, `30 minutes`, `2h`, `3x`, `3 rounds`.',
    'Left out: 10 minutes, at most 6 rounds.',
    '',
    'The loop ends once the budget is spent, the assistant reports the goal as',
    'reached – or you click **Cancel**. A new instruction in the input field',
    'interrupts it as well.',
    '',
    '**Example**',
    '',
    '```',
    '/goal The parser understands variables and every test is green',
    '/loop 15m Find what is still open and work through it',
    '```'
].join('\n');
