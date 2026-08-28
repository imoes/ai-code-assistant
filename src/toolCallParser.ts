/**
 * Übersetzt die nativen Tool-Call-Formate der Modelle in unsere Aktions-Blöcke.
 *
 * Warum das nötig ist: Auf Tool-Use trainierte Modelle greifen auf ihr
 * eingelerntes Format zurück, auch wenn der System-Prompt Backtick-Blöcke
 * verlangt. Ohne Übersetzung findet der Aktions-Parser nichts und der Assistent
 * redet nur über die Aufgabe, statt sie zu erledigen.
 *
 * Jede Modellfamilie hat ihr eigenes Format:
 *
 *   Hermes / Qwen2.5 / Qwen3-Instruct
 *     <tool_call>{"name": "grep", "arguments": {"pattern": "foo"}}</tool_call>
 *
 *   Qwen3-Coder (eigenes XML)
 *     <tool_call><function=grep><parameter=pattern>foo</parameter></function></tool_call>
 *
 *   GLM-4 / laguna
 *     <tool_call>grep<arg_key>pattern</arg_key><arg_value>foo</arg_value></tool_call>
 *
 *   Mistral Nemo
 *     [TOOL_CALLS] [{"name": "grep", "arguments": {"pattern": "foo"}}]
 *
 *   Llama 3.1 (JSON) / 3.2 (pythonic)
 *     <|python_tag|>{"name": "grep", "parameters": {"pattern": "foo"}}
 *     [grep(pattern="foo")]
 *
 *   DeepSeek R1 / V3
 *     <|tool_calls_begin|><|tool_call_begin|>function<|tool_sep|>grep
 *     ```json
 *     {"pattern": "foo"}
 *     ```<|tool_call_end|><|tool_calls_end|>
 *     (mit Fullwidth-Balken U+FF5C und U+2581, nicht ASCII)
 *
 * Quellen: llama.cpp docs/function-calling.md, ggml-org/llama.cpp#15012,
 * vLLM Tool-Calling-Doku, netclaw.dev Troubleshooting-Guide.
 */

/** Ein erkannter Werkzeugaufruf. */
export interface ToolCall {
    name: string;
    args: Record<string, string>;
}

/** Minimales Logger-Interface, damit dieses Modul ohne vscode auskommt. */
export interface ToolCallLogger {
    info(msg: string): void;
    warn(msg: string): void;
}

/**
 * Aktionen, die der Assistent tatsächlich ausführen kann.
 * Nur diese Namen werden übersetzt – so wird aus einem beliebigen
 * JSON-Array im Antworttext nie versehentlich eine Aktion.
 */
export const KNOWN_ACTIONS = new Set([
    'read_file', 'grep', 'glob', 'list_dir',
    'create_file', 'edit_file', 'replace_lines', 'patch_file', 'delete_file',
    'shell', 'web_search', 'web_fetch', 'plan', 'todo', 'done', 'finish', 'ask_user'
]);

/**
 * Werkzeugnamen anderer Assistenten auf unsere Aktionen abbilden.
 *
 * Modelle sind auf die Werkzeugnamen ihres jeweiligen Trainings-Harness
 * geprägt (Cline, Aider, OpenHands, Claude Code, Codex …). Ein Modell, das
 * `write_file` gelernt hat, wird das auch hier aufrufen – dann soll es wirken.
 */
export const ACTION_ALIASES: Record<string, string> = {
    // Lesen
    read: 'read_file', view: 'read_file', cat: 'read_file',
    open_file: 'read_file', view_file: 'read_file', get_file: 'read_file',
    read_lines: 'read_file', str_replace_editor_view: 'read_file',
    // Suchen
    search: 'grep', search_files: 'grep', file_search: 'grep',
    grep_search: 'grep', find_in_files: 'grep', ripgrep: 'grep', rg: 'grep',
    codebase_search: 'grep', search_code: 'grep',
    // Dateien finden
    find_files: 'glob', list_files: 'glob', file_glob: 'glob',
    // Verzeichnis
    ls: 'list_dir', list_directory: 'list_dir', dir: 'list_dir',
    list_dirs: 'list_dir',
    // Schreiben
    write: 'create_file', write_file: 'create_file', create: 'create_file',
    new_file: 'create_file', write_to_file: 'create_file',
    // Ersetzen
    edit: 'patch_file', str_replace: 'patch_file',
    str_replace_editor: 'patch_file', apply_patch: 'patch_file',
    apply_diff: 'patch_file', replace_in_file: 'patch_file',
    search_replace: 'patch_file', edit_range: 'replace_lines',
    // Löschen
    remove_file: 'delete_file', rm: 'delete_file', delete: 'delete_file',
    // Shell
    bash: 'shell', sh: 'shell', run: 'shell', exec: 'shell',
    execute: 'shell', terminal: 'shell', run_command: 'shell',
    execute_command: 'shell', run_shell_command: 'shell',
    run_terminal_cmd: 'shell', shell_command: 'shell',
    // Web
    search_web: 'web_search', web: 'web_search', browse: 'web_search',
    fetch: 'web_fetch', fetch_url: 'web_fetch', open_url: 'web_fetch',
    read_url: 'web_fetch', webfetch: 'web_fetch', url_fetch: 'web_fetch',
    // Planung
    todo_write: 'plan', update_plan: 'plan', write_todos: 'plan',
    task_list: 'plan', todos: 'plan',
    // Abschluss
    complete: 'done', attempt_completion: 'done', task_complete: 'done',
    submit: 'done'
};

/** Argumentnamen anderer Harnesses auf unsere Feldnamen abbilden. */
export const ARG_ALIASES: Record<string, string> = {
    file_path: 'path', filepath: 'path', filename: 'path', file: 'path',
    file_name: 'path', target_file: 'path', uri: 'path',
    regex: 'pattern', search_pattern: 'pattern', q: 'pattern',
    include: 'glob', file_pattern: 'glob', include_pattern: 'glob',
    directory: 'path', dir_path: 'path', folder: 'path',
    start: 'start_line', from_line: 'start_line',
    end: 'end_line', to_line: 'end_line',
    contents: 'content', file_text: 'content', new_str: 'content',
    diff: 'patch', edits: 'patch',
    summary: 'zusammenfassung',
    search_query: 'query'
};

// ──────────────────────────────────────────────────────────────────────────────
// Werkzeugkatalog für serverseitiges Tool-Calling
// ──────────────────────────────────────────────────────────────────────────────

/** Eine Werkzeugdefinition im OpenAI-Schema. */
export interface ToolDefinition {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, { type: string; description: string }>;
        required?: string[];
    };
}

function strProp(description: string) {
    return { type: 'string', description };
}
function numProp(description: string) {
    return { type: 'number', description };
}

/**
 * Beschreibung des Feldes `absicht` – steht in JEDEM Werkzeug.
 *
 * Englisch wie der ganze Katalog, aber mit dem ausdrücklichen Hinweis, dass der
 * WERT in der Sprache des Benutzers zu schreiben ist: der Satz landet direkt im
 * Chat. Ohne den Hinweis antwortet ein Modell auf eine deutsche Frage plötzlich
 * mit englischen Ansagen.
 */
const INTENT_PROP = 'ONE short sentence in the first person: what you are doing '
    + 'here and why. It is shown to the user, so write it in the language the '
    + 'user used in their request.';

/**
 * Unsere Aktionen als Werkzeuge im OpenAI-Schema.
 *
 * Damit kann llama.cpp das modellspezifische Format selbst erzeugen und parsen –
 * das ist der einzige Weg, der ohne Formatpflege für Qwen, Gemma, Kimi, laguna,
 * DeepSeek, Mistral und alles Künftige funktioniert.
 *
 * Die Beschreibungen sind **englisch**: Modelle folgen englischen Instruktionen
 * zuverlässiger, und der Katalog steht in jeder Anfrage im Prompt. Die Antwort
 * des Modells bleibt in der Sprache des Benutzers – siehe LANGUAGE_RULE und
 * INTENT_PROP.
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
    {
        name: 'read_file',
        description: 'Reads a file from the workspace with line numbers. '
            + 'Use it to understand existing code BEFORE you change it.',
        parameters: {
            type: 'object',
            properties: {
                absicht: strProp(INTENT_PROP),
                path: strProp('Path relative to the workspace, e.g. src/parser.js'),
                offset: numProp('1-based start line (optional, default 1)'),
                limit: numProp('Maximum number of lines (optional, default 400)')
            },
            required: ['absicht', 'path']
        }
    },
    {
        name: 'grep',
        description: 'Searches the whole project with a regular expression '
            + '(like ripgrep) and returns file, line number and line content.',
        parameters: {
            type: 'object',
            properties: {
                absicht: strProp(INTENT_PROP),
                pattern: strProp('Regular expression, e.g. class\\s+\\w+Service'),
                glob: strProp('File filter (optional), e.g. **/*.ts'),
                path: strProp('Restrict to this subfolder (optional)'),
                ignore_case: strProp('"true" to ignore case (optional)')
            },
            required: ['absicht', 'pattern']
        }
    },
    {
        name: 'glob',
        description: 'Finds files by name pattern, e.g. all test files.',
        parameters: {
            type: 'object',
            properties: {
                absicht: strProp(INTENT_PROP),
                pattern: strProp('Glob pattern, e.g. **/*.test.js')
            },
            required: ['absicht', 'pattern']
        }
    },
    {
        name: 'list_dir',
        description: 'Lists the contents of a directory.',
        parameters: {
            type: 'object',
            properties: {
                absicht: strProp(INTENT_PROP),
                path: strProp('Directory relative to the workspace, e.g. src')
            },
            required: ['absicht', 'path']
        }
    },
    {
        name: 'plan',
        description: 'Creates or updates the work plan as a todo list. '
            + 'Call it first for tasks with more than two steps. '
            + 'Always pass the COMPLETE list.',
        parameters: {
            type: 'object',
            properties: {
                absicht: strProp(INTENT_PROP),
                steps: strProp('One line per step: "- [ ] open", "- [>] in progress", '
                    + '"- [x] done". The user reads these, so write them in the '
                    + 'language the user used.')
            },
            required: ['absicht', 'steps']
        }
    },
    {
        name: 'patch_file',
        description: 'Changes part of a file in place. The preferred tool for changes.',
        parameters: {
            type: 'object',
            properties: {
                absicht: strProp(INTENT_PROP),
                path: strProp('Path relative to the workspace'),
                patch: strProp('One or more blocks of the form: '
                    + '<<<SEARCH\\n<exact existing code>\\n>>>REPLACE\\n<new code>')
            },
            required: ['absicht', 'path', 'patch']
        }
    },
    {
        name: 'replace_lines',
        description: 'Replaces a range of lines. Line numbers come from read_file.',
        parameters: {
            type: 'object',
            properties: {
                absicht: strProp(INTENT_PROP),
                path: strProp('Path relative to the workspace'),
                start_line: numProp('First line to replace (1-based, inclusive)'),
                end_line: numProp('Last line to replace (inclusive)'),
                content: strProp('New code for that range')
            },
            required: ['absicht', 'path', 'start_line', 'end_line', 'content']
        }
    },
    {
        name: 'create_file',
        description: 'Creates a new file with its complete content.',
        parameters: {
            type: 'object',
            properties: {
                absicht: strProp(INTENT_PROP),
                path: strProp('Path relative to the workspace'),
                content: strProp('Complete file content')
            },
            required: ['absicht', 'path', 'content']
        }
    },
    {
        name: 'edit_file',
        description: 'Replaces a whole file. Only use it when patch_file is not enough – '
            + 'the content must be COMPLETE, with no placeholders like "... existing code ...".',
        parameters: {
            type: 'object',
            properties: {
                absicht: strProp(INTENT_PROP),
                path: strProp('Path relative to the workspace'),
                content: strProp('Complete new file content, every line included')
            },
            required: ['absicht', 'path', 'content']
        }
    },
    {
        name: 'delete_file',
        description: 'Deletes a file.',
        parameters: {
            type: 'object',
            properties: {
                absicht: strProp(INTENT_PROP),
                path: strProp('Path relative to the workspace')
            },
            required: ['absicht', 'path']
        }
    },
    {
        name: 'shell',
        description: 'Runs a command in the workspace. Two shells are available: '
            + 'WSL/bash (default – build, tests, git, everything POSIX) and Windows '
            + 'PowerShell. For build and tests, NOT for reading files.',
        parameters: {
            type: 'object',
            properties: {
                absicht: strProp(INTENT_PROP),
                command: strProp('The command, e.g. npm test'),
                shell: strProp('Which shell: "wsl" (default, POSIX) or "powershell" '
                    + '(Windows: services, registry, drivers, WinGet, Windows-only '
                    + 'executables, COM). Pick powershell only when the command '
                    + 'genuinely needs Windows – the syntax differs (no && , '
                    + 'Get-ChildItem instead of ls).')
            },
            required: ['absicht', 'command']
        }
    },
    {
        name: 'ask_user',
        description: 'Asks the user a decision question and waits for the answer. '
            + 'Use it when the task allows several defensible routes and the choice '
            + 'is the user\'s to make – a library, a naming scheme, whether to touch '
            + 'a file at all. Do NOT use it for things you can find out yourself by '
            + 'reading the code, and not to ask for permission to keep working.',
        parameters: {
            type: 'object',
            properties: {
                absicht: strProp(INTENT_PROP),
                question: strProp('The question, one sentence, in the user\'s language.'),
                options: strProp('One option per line: "Label — short explanation of '
                    + 'what happens if chosen". 2 to 4 options, mutually exclusive '
                    + 'unless multi is true. Put your recommendation first. In the '
                    + 'user\'s language.'),
                header: strProp('2–3 word label for this decision, e.g. "Library" '
                    + '(optional)'),
                multi: strProp('"true" if several options may be picked at once '
                    + '(optional, default false)')
            },
            required: ['absicht', 'question', 'options']
        }
    },
    {
        name: 'web_search',
        description: 'Searches the web when current knowledge is missing.',
        parameters: {
            type: 'object',
            properties: {
                absicht: strProp(INTENT_PROP),
                query: strProp('Search terms')
            },
            required: ['absicht', 'query']
        }
    },
    {
        name: 'web_fetch',
        description: 'Fetches a web page and returns its text. '
            + 'Use it after a search: the result list holds only titles and '
            + 'addresses, the answer is on the page itself.',
        parameters: {
            type: 'object',
            properties: {
                absicht: strProp(INTENT_PROP),
                url: strProp('Full http(s) address')
            },
            required: ['absicht', 'url']
        }
    },
    {
        name: 'done',
        description: 'Reports the task as finished. Only call it when there is '
            + 'genuinely nothing left to do.',
        parameters: {
            type: 'object',
            properties: {
                absicht: strProp(INTENT_PROP),
                zusammenfassung: strProp('What was done. This is the closing answer to '
                    + 'the user – write it in the language the user used, and use '
                    + 'Markdown where it helps (lists, `code`).')
            },
            required: ['absicht', 'zusammenfassung']
        }
    }
];

/**
 * Aktionen, die nichts verändern.
 *
 * Im Plan-Modus bekommt das Modell ausschließlich diese – dann kann es die
 * Aufgabe untersuchen und planen, aber nichts anfassen.
 */
export const READ_ONLY_ACTIONS = new Set([
    'read_file', 'grep', 'glob', 'list_dir', 'plan', 'web_search', 'web_fetch', 'done',
    'ask_user'
]);

/** Werkzeugkatalog für einen Modus: im Plan-Modus nur die lesenden Werkzeuge. */
export function toolsForMode(mode: 'ask' | 'auto' | 'plan'): ToolDefinition[] {
    if (mode !== 'plan') return TOOL_DEFINITIONS;
    return TOOL_DEFINITIONS.filter(t => READ_ONLY_ACTIONS.has(t.name));
}

/** Ein vom Server geparster Werkzeugaufruf (OpenAI-Antwortformat). */
export interface NativeToolCall {
    name: string;
    /** JSON-String, so wie die OpenAI-API ihn liefert */
    arguments: string;
    id?: string;
}

/**
 * Serverseitig geparste Werkzeugaufrufe in Aktions-Blöcke übersetzen.
 *
 * Der Server hat die Modellsyntax schon aufgelöst – hier bleibt nur die
 * Abbildung auf unser Blockformat.
 */
export function toolCallsToActionBlocks(
    calls: NativeToolCall[],
    logger?: ToolCallLogger
): string {
    return toolCallsToActions(calls, logger).blocks;
}

/** Ergebnis der Übersetzung: Aktions-Blöcke plus die Ansagen des Modells. */
export interface ConvertedToolCalls {
    /** Aktions-Blöcke zum Ausführen */
    blocks: string;
    /**
     * Was das Modell zu jedem Aufruf gesagt hat (`absicht`).
     *
     * Nötig, weil Modelle bei nativen Werkzeugaufrufen `content: null` liefern:
     * sie stecken alles in den Aufruf und schreiben keine Prosa. Ohne diese
     * Ansagen sähe der Benutzer nur eine Liste von Aktionen ohne Begründung.
     */
    intents: string[];
}

/** Serverseitig geparste Werkzeugaufrufe übersetzen, inklusive Ansagen. */
export function toolCallsToActions(
    calls: NativeToolCall[],
    logger?: ToolCallLogger
): ConvertedToolCalls {
    const blocks: string[] = [];
    const intents: string[] = [];
    const unknown: string[] = [];

    for (const call of calls) {
        const name = resolveActionName(call.name);
        if (!name) {
            unknown.push(call.name);
            continue;
        }

        const args = normalizeArgs(toStringMap(call.arguments));

        // Die Ansage sammeln – renderActionBlock setzt sie vor den Block und
        // entfernt sie aus den Argumenten.
        const intent = (args.absicht ?? '').replace(/\s+/g, ' ').trim();
        if (intent) intents.push(intent);

        blocks.push(renderActionBlock(name, args));
    }

    if (blocks.length > 0) {
        logger?.info(`Tool-Calling: ${blocks.length} Aufruf(e) vom Server erhalten.`);
    }
    if (unknown.length > 0) {
        logger?.warn(`Tool-Calling: unbekannte Werkzeuge ignoriert: ${unknown.join(', ')}.`);
    }
    return { blocks: blocks.join(''), intents };
}

/** Argumente, die als Blockinhalt (nach dem "---") gehören, nicht als Kopfzeile. */
const BODY_ARGS = new Set([
    'content', 'new_content', 'file_content', 'body', 'text', 'code',
    'patch', 'patches', 'steps', 'plan', 'items', 'command', 'cmd'
]);

/**
 * Aktionen, deren Block AUSSCHLIESSLICH aus dem Wert besteht.
 *
 * `shell` gehört seit dem Shell-Wahlschalter NICHT mehr dazu: mit zwei
 * Argumenten würde `Object.values().join()` sonst „npm test\npowershell"
 * ergeben – und der Assistent versuchte, das als Befehl auszuführen.
 */
const BODY_ONLY = new Set(['plan', 'todo']);

// DeepSeek nutzt Fullwidth-Balken (U+FF5C) und Lower-One-Eighth-Block (U+2581).
// Als Escapes geschrieben, damit die Datei nicht von der Kodierung abhängt.
const DS = {
    B: '｜', // ｜
    U: '▁'  // ▁
};

/**
 * Alle nativen Tool-Call-Formate im Text durch Aktions-Blöcke ersetzen.
 *
 * @param text    Rohantwort des Modells
 * @param logger  optional, für Diagnose im Ausgabekanal
 */
export function normalizeToolCalls(text: string, logger?: ToolCallLogger): string {
    if (!looksLikeToolCall(text)) return text;

    let out = text;
    let total = 0;
    const unknown = new Set<string>();

    const emit = (call: ToolCall | null): string => {
        if (!call) return '';
        const name = resolveActionName(call.name);
        if (!name) {
            unknown.add(call.name);
            return '';
        }
        total++;
        return renderActionBlock(name, normalizeArgs(call.args));
    };

    // ── DeepSeek R1 / V3 ────────────────────────────────────────────────────
    // Der äußere <|tool_calls_begin|>-Rahmen wird verworfen, die inneren Aufrufe
    // einzeln übersetzt.
    const dsCall = new RegExp(
        `<${DS.B}tool${DS.U}call${DS.U}begin${DS.B}>\\s*\\w*\\s*` +
        `<${DS.B}tool${DS.U}sep${DS.B}>\\s*([\\w.\\-]+)\\s*([\\s\\S]*?)` +
        `<${DS.B}tool${DS.U}call${DS.U}end${DS.B}>`,
        'g'
    );
    out = out.replace(dsCall, (_m, name: string, body: string) =>
        emit({ name, args: parseJsonArgs(stripJsonFence(body)) }));
    out = out.replace(
        new RegExp(`<${DS.B}tool${DS.U}calls?${DS.U}(begin|end)${DS.B}>`, 'g'), '');

    // ── Mistral Nemo: [TOOL_CALLS] [ … ] ────────────────────────────────────
    // Klammer-Bilanz statt Regex: eine nicht-greedy Regex bricht am ersten "]",
    // das auch mitten in einem Argumentwert wie "[a-z]" stehen kann.
    out = replaceWithBalancedJson(out, /\[TOOL_CALLS\]\s*/g, '[', ']', json => {
        const arr = tryJson(json);
        if (!Array.isArray(arr)) return '';
        return arr.map(o => emit(callFromJsonObject(o))).join('');
    });

    // ── Llama 3.1: <|python_tag|>{ … } ──────────────────────────────────────
    out = replaceWithBalancedJson(out, /<\|python_tag\|>\s*/g, '{', '}',
        json => emit(callFromJsonObject(tryJson(json))));
    out = out.replace(/<\|eom_id\|>/g, '');

    // ── Umschlossene Aufrufe: <tool_call> / <function_call> / <invoke> ──────
    out = out.replace(
        /<(tool_call|function_call|tool_use|invoke)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi,
        (_m, _tag, attrs: string | undefined, inner: string) =>
            emit(parseWrappedCall(inner, attrs))
    );

    // ── Qwen3-Coder ohne Umschlag: <function=name>…</function> ──────────────
    out = out.replace(/<function=([\w.\-]+)>([\s\S]*?)<\/function>/gi,
        (_m, name: string, inner: string) =>
            emit({ name, args: parseParameterTags(inner) }));

    // ── Llama 3.2 pythonic: [read_file(path="src/a.ts")] ───────────────────
    // Nur für bekannte Aktionsnamen, sonst würde jedes Array-Literal getroffen.
    out = out.replace(/\[([\w.\-]+)\(([^)]*)\)\]/g, (full, name: string, argStr: string) => {
        if (!resolveActionName(name)) return full;
        return emit({ name, args: parsePythonicArgs(argStr) });
    });

    // Verwaiste Marker aufräumen, damit kein XML im Chat landet
    out = out.replace(/<\/?(tool_call|function_call|tool_use|invoke|arg_key|arg_value|parameter|function)[^>]*>/gi, '');

    if (total > 0) {
        logger?.info(`Tool-Call-Parser: ${total} nativen Aufruf(e) übersetzt.`);
    }
    if (unknown.size > 0) {
        logger?.warn(
            `Tool-Call-Parser: unbekannte Werkzeuge ignoriert: ${[...unknown].join(', ')}. ` +
            `Verfügbar sind: ${[...KNOWN_ACTIONS].join(', ')}.`
        );
    }
    return out;
}

/**
 * Tool-Call-Markup aus Code entfernen, der in eine Datei geschrieben werden soll.
 *
 * Modelle lassen gelegentlich Reste ihrer eigenen Serialisierung im
 * Argumentwert stehen – beobachtet: eine Zeile `</arg_value>` mitten im
 * Quellcode, die die Datei unbrauchbar machte. Solche Zeilen sind in keiner
 * Programmiersprache gültig, also raus damit, bevor geschrieben wird.
 *
 * Entfernt werden nur Zeilen, die AUSSCHLIESSLICH aus solchem Markup bestehen –
 * eine Zeile wie `if (a < b)` bleibt unangetastet.
 */
export function stripToolMarkupFromCode(code: string): { code: string; removed: string[] } {
    const MARKUP = /^[ \t]*<\/?(tool_call|function_call|tool_use|invoke|arg_key|arg_value|parameter|function|arguments|parameters|name)\b[^>]*>[ \t]*$/i;

    const removed: string[] = [];
    const kept = code.split('\n').filter(line => {
        if (MARKUP.test(line)) {
            removed.push(line.trim());
            return false;
        }
        return true;
    });

    return { code: removed.length > 0 ? kept.join('\n') : code, removed };
}

/** Rohes Tool-Call-Markup aus dem Anzeigetext entfernen. */
export function stripToolCallMarkup(text: string): string {
    return text
        .replace(/<(tool_call|function_call|tool_use|invoke)(\s[^>]*)?>[\s\S]*?<\/\1>/gi, '')
        .replace(/\[TOOL_CALLS\]\s*\[[\s\S]*?\]/g, '')
        .replace(/<\|python_tag\|>\s*\{[\s\S]*?\}\s*(?:<\|eom_id\|>)?/g, '')
        .replace(new RegExp(`<${DS.B}tool${DS.U}[\\w${DS.U}]*${DS.B}>`, 'g'), '')
        .replace(/<\/?(tool_call|function_call|tool_use|invoke|arg_key|arg_value|parameter|function)[^>]*>/gi, '');
}

// ──────────────────────────────────────────────────────────────────────────────
// Interne Helfer
// ──────────────────────────────────────────────────────────────────────────────

/** Schnelltest, damit der Normalfall (Backtick-Blöcke) keine Regex-Arbeit kostet. */
function looksLikeToolCall(text: string): boolean {
    return /<tool_call|<function_call|<tool_use|<invoke|<function=|\[TOOL_CALLS\]|<\|python_tag\|>/i.test(text)
        // Llama 3.2 schreibt Aufrufe pythonisch: [read_file(path="a.js")]
        || /\[[\w.\-]+\(/.test(text)
        || text.includes(`${DS.B}tool${DS.U}`);
}

/**
 * Vorkommen von `marker` samt darauf folgendem, klammer-balancierten
 * JSON-Ausdruck ersetzen.
 *
 * Nötig, weil verschachteltes JSON eine nicht-greedy Regex aushebelt:
 * `\{[\s\S]*?\}` endet bei `{"a":{"b":1}}` schon nach dem inneren Objekt.
 */
function replaceWithBalancedJson(
    text: string,
    marker: RegExp,
    open: string,
    close: string,
    render: (json: string) => string
): string {
    const pattern = new RegExp(marker.source, marker.flags.includes('g') ? marker.flags : marker.flags + 'g');
    let result = '';
    let cursor = 0;
    let m: RegExpExecArray | null;

    while ((m = pattern.exec(text)) !== null) {
        const jsonStart = text.indexOf(open, m.index + m[0].length - 1);
        if (jsonStart === -1) break;

        const jsonEnd = findBalancedEnd(text, jsonStart, open, close);
        if (jsonEnd === -1) break;

        result += text.slice(cursor, m.index);
        result += render(text.slice(jsonStart, jsonEnd + 1));
        cursor = jsonEnd + 1;
        pattern.lastIndex = cursor;
    }

    return cursor === 0 ? text : result + text.slice(cursor);
}

/**
 * Index der schließenden Klammer zum Öffner an `start`.
 * Zeichenketten werden übersprungen, damit eine Klammer im Wert nicht zählt.
 */
function findBalancedEnd(text: string, start: number, open: string, close: string): number {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
        const c = text[i];

        if (inString) {
            if (escaped) { escaped = false; continue; }
            if (c === '\\') { escaped = true; continue; }
            if (c === '"') inString = false;
            continue;
        }

        if (c === '"') { inString = true; continue; }
        if (c === open) depth++;
        else if (c === close) {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/** Werkzeugname → Aktionsname, oder null wenn unbekannt. */
function resolveActionName(raw: string): string | null {
    const name = raw
        .replace(/^(functions?|tools?|action|default_api)[.:]/i, '')
        .trim()
        .toLowerCase();
    if (KNOWN_ACTIONS.has(name)) return name;
    const alias = ACTION_ALIASES[name];
    return alias && KNOWN_ACTIONS.has(alias) ? alias : null;
}

/** Argumentnamen auf unsere Feldnamen bringen. */
function normalizeArgs(args: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [rawKey, value] of Object.entries(args)) {
        const key = rawKey.trim().toLowerCase();
        out[ARG_ALIASES[key] ?? key] = value;
    }
    return out;
}

/**
 * Aktions-Block aus Name und Argumenten bauen.
 *
 * Die `absicht` wird als normaler Text VOR den Block gesetzt, nicht als
 * Kopfzeile: sie ist für den Benutzer bestimmt und hätte im Dateiinhalt
 * oder im Shell-Befehl nichts zu suchen.
 */
function renderActionBlock(name: string, argsIn: Record<string, string>): string {
    const args = { ...argsIn };
    const intent = (args.absicht ?? '').replace(/\s+/g, ' ').trim();
    delete args.absicht;
    const prefix = intent ? `\n${intent}\n` : '\n';

    if (BODY_ONLY.has(name)) {
        const body = Object.values(args).join('\n').trim();
        return `${prefix}\`\`\`action:${name}\n${body}\n\`\`\`\n`;
    }

    const headers: string[] = [];
    const bodies: string[] = [];
    for (const [k, v] of Object.entries(args)) {
        if (BODY_ARGS.has(k)) bodies.push(v);
        // Kopfzeilen sind einzeilig – ein umgebrochener Wert würde den Parser stören
        else headers.push(`${k}: ${v.replace(/\r?\n/g, ' ').trim()}`);
    }

    // Der Trenner `---` steht nur zwischen Kopfzeilen und Rumpf. Ohne
    // Kopfzeilen begann der Block sonst mit einer Leerzeile und einem nackten
    // `---` – und der landete beim `shell`-Werkzeug im Befehl.
    const block = bodies.length > 0
        ? (headers.length > 0 ? `${headers.join('\n')}\n---\n` : '') + bodies.join('\n')
        : headers.join('\n');

    return `${prefix}\`\`\`action:${name}\n${block}\n\`\`\`\n`;
}

/** Inhalt eines <tool_call>-Umschlags zerlegen – vier bekannte Varianten. */
function parseWrappedCall(inner: string, attrs?: string): ToolCall | null {
    const trimmed = inner.trim();

    // <invoke name="read_file"> – Name steht im Attribut
    const attrName = attrs?.match(/name\s*=\s*["']([^"']+)["']/i)?.[1];

    // Qwen3-Coder: <function=name><parameter=key>value</parameter>
    const fnTag = trimmed.match(/<function=([\w.\-]+)>/i);
    if (fnTag) {
        return { name: fnTag[1], args: parseParameterTags(trimmed) };
    }

    // <name>x</name><arguments>{…}</arguments>
    const tagName = trimmed.match(/<(?:function_)?name>([\s\S]*?)<\/(?:function_)?name>/i)?.[1];
    const tagArgs = trimmed.match(/<(?:arguments|parameters)>([\s\S]*?)<\/(?:arguments|parameters)>/i)?.[1];
    if (tagName) {
        return {
            name: tagName.trim(),
            args: tagArgs ? parseJsonArgs(stripJsonFence(tagArgs)) : parseParameterTags(trimmed)
        };
    }

    // JSON
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const obj = tryJson(trimmed);
        const call = Array.isArray(obj)
            ? callFromJsonObject(obj[0])
            : callFromJsonObject(obj);
        if (call) return call;
    }

    // GLM-4 / laguna: name<arg_key>k</arg_key><arg_value>v</arg_value>
    const leading = trimmed.match(/^([\w.\-]+)/);
    if (leading || attrName) {
        const args = parseArgKeyValue(trimmed);
        // <parameter name="k">v</parameter> als weitere Variante
        const paramArgs = parseParameterTags(trimmed);
        return {
            name: attrName ?? leading![1],
            args: Object.keys(args).length > 0 ? args : paramArgs
        };
    }

    return null;
}

/** <arg_key>k</arg_key><arg_value>v</arg_value> Paare. */
function parseArgKeyValue(text: string): Record<string, string> {
    const args: Record<string, string> = {};
    const p = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi;
    let m: RegExpExecArray | null;
    while ((m = p.exec(text)) !== null) {
        args[m[1].trim()] = trimOuterNewlines(m[2]);
    }
    return args;
}

/**
 * <parameter=key>value</parameter> (Qwen3-Coder) und
 * <parameter name="key">value</parameter> (Claude-Stil).
 */
function parseParameterTags(text: string): Record<string, string> {
    const args: Record<string, string> = {};

    const eqForm = /<parameter=([\w.\-]+)>([\s\S]*?)<\/parameter>/gi;
    let m: RegExpExecArray | null;
    while ((m = eqForm.exec(text)) !== null) {
        args[m[1].trim()] = trimOuterNewlines(m[2]);
    }

    const attrForm = /<parameter\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/gi;
    while ((m = attrForm.exec(text)) !== null) {
        args[m[1].trim()] = trimOuterNewlines(m[2]);
    }

    return args;
}

/** {"name": "x", "arguments": {…}} in einen ToolCall wandeln. */
function callFromJsonObject(obj: unknown): ToolCall | null {
    if (!obj || typeof obj !== 'object') return null;
    const o = obj as Record<string, unknown>;

    // OpenAI-Form: { function: { name, arguments } }
    const fn = o.function as Record<string, unknown> | undefined;
    const nameRaw = o.name ?? o.tool ?? o.tool_name ?? o.recipient_name ?? fn?.name;
    if (typeof nameRaw !== 'string' || !nameRaw.trim()) return null;

    const rawArgs = o.arguments ?? o.args ?? o.parameters ?? o.input
        ?? o.tool_input ?? fn?.arguments ?? {};

    return { name: nameRaw, args: toStringMap(rawArgs) };
}

/** JSON-Argumentobjekt in flache String-Map wandeln. */
function parseJsonArgs(json: string): Record<string, string> {
    return toStringMap(tryJson(json));
}

function toStringMap(value: unknown): Record<string, string> {
    // arguments ist bei OpenAI ein JSON-String, bei anderen ein Objekt
    if (typeof value === 'string') {
        const parsed = tryJson(value);
        return parsed && typeof parsed === 'object' ? toStringMap(parsed) : {};
    }
    if (!value || typeof value !== 'object') return {};

    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return out;
}

/** pythonic: path="src/a.ts", limit=50 */
function parsePythonicArgs(argStr: string): Record<string, string> {
    const args: Record<string, string> = {};
    const p = /([\w.\-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,]+))/g;
    let m: RegExpExecArray | null;
    while ((m = p.exec(argStr)) !== null) {
        args[m[1]] = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    }
    return args;
}

/** ```json … ``` Umschlag entfernen (DeepSeek legt die Argumente so ab). */
function stripJsonFence(text: string): string {
    return text.replace(/```[\w]*\s*\r?\n?/g, '').replace(/```/g, '').trim();
}

/** Führende/abschließende Leerzeilen entfernen, Einrückung im Inhalt behalten. */
function trimOuterNewlines(text: string): string {
    return text.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
}

function tryJson(text: string): unknown {
    try { return JSON.parse(text); } catch { return null; }
}
