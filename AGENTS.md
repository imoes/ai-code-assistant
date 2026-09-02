# AGENTS.md – project instructions for the AI Code Assistant

The assistant loads this file as a permanent rule on **every** request (alongside
`CLAUDE.md` and `command.md`).

## Project

VS Code extension "AI Code Assistant" – an autonomous coding assistant that analyses,
plans, writes and tests code through an OpenAI-compatible endpoint (a local llama.cpp
server or a cloud provider such as OpenRouter).

- Source: `src/*.ts`, entry point `src/extension.ts`
- Build: `npm run compile` (TypeScript → `out/`)
- Tests: `npm test` — 837 checks, no network and no model server needed. The suite runs
  the real engine against a `vscode` stub (`test/vscode-stub.js`) and local test servers.
  New feature → add a test under `test/` and register it in `test/run-all.js`.
- Packaging: `npm run package` (produces `ai-code-assistant-<version>.vsix`)
- Repo: see `git remote -v`

## Bump the version on every change

**Mandatory:** raise `version` in `package.json` on every functional change, before a new
`.vsix` is built.

VS Code only updates an extension when the version has changed – with the same version
number the old one stays installed. Without a bump the new `.vsix` cannot be installed
cleanly.

Scheme (semver):

| Kind of change                             | Bump  | Example         |
|--------------------------------------------|-------|-----------------|
| Bug fix, small correction                  | Patch | 0.2.0 → 0.2.1   |
| New feature, new setting                   | Minor | 0.2.1 → 0.3.0   |
| Breaking change (settings removed)         | Major | 0.3.0 → 1.0.0   |

After the bump: `npm run compile && npm run package`, then install the new `.vsix`
(`Extensions: Install from VSIX…`).

## .vsix packages are CI artefacts

Built `.vsix` files are **not** committed (`.gitignore`). They are produced by CI – the
GitLab pipeline (`.gitlab-ci.yml`, job `package`) and the GitHub workflow
(`.github/workflows/build.yml`) – and offered as build artefacts. The file name carries
the version from `package.json`, which is why the version bump above is what makes
artefacts distinguishable.

## Tool calling: the server does the format work

Every model family has its own tool-call format (Qwen3-Coder XML, Hermes JSON,
GLM/laguna `arg_key`, Mistral `[TOOL_CALLS]`, Llama `<|python_tag|>`, Kimi K3 XTML,
DeepSeek with fullwidth bars). Recognising those formats in the answer text is a
bottomless pit – every new model brings a new one.

**So the canonical way is:** send the tools as `tools` in the OpenAI schema and read
`message.tool_calls` from the answer. llama.cpp (with `--jinja`) renders the model's
format and parses it back, which makes every model the server supports work. Hermes
solves it the same way – there every provider transport normalises to a canonical
`ToolCall {id, name, arguments}`; a text parser does not exist at all.

- Tool catalogue: `TOOL_DEFINITIONS` in `src/toolCallParser.ts` – **the** source of truth
  for action names and arguments. New action → add it there, or the model will not know
  about it. Adding it to the prompt text alone is not enough: with native tool calls the
  model only sees the catalogue.
- The text parser in the same module is only the fallback for servers without `--jinja`.
- Map foreign tool names (`write_file`, `bash`, `str_replace_editor`, …) via
  `ACTION_ALIASES` instead of rejecting them.

## With tool calls there is no prose

On native tool calls models return `content: null` – they put everything into the call
and write no accompanying text. Hang the explanation on the prose and you only get it in
the first round.

That is why **every** tool in `TOOL_DEFINITIONS` carries an `absicht` field: one sentence
in the first person saying what the call does and why. `toolCallsToActions()` collects
those announcements and `renderActionBlock()` places them as text before the block (never
as a header line – otherwise they end up inside the file content). New tools need the
field as well.

## Never write unchecked model text into a file

Models leave remnants of their own serialisation inside argument values – observed: a line
`</arg_value>` in the middle of source code, which made the file unusable. Likewise
terminator markers such as `>>>` or `>>>>>>> REPLACE` from the patch format.

`AIEngine.cleanCodeForWrite()` filters that before every write. Only lines consisting
**exclusively** of such markup are removed – `if (a < b)` is left alone.

## The agent loop must report every failure

`planNextStep` in `src/aiEngine.ts` decides whether and how work continues. The rules:

- **Every failure goes back to the model**, with a reason. One test run showed what
  happens otherwise: a patch failed because the change was already in place, the message
  never reached the model – and it sent the same patch 18 times.
- **Only successful actions count as work done.** Count a failed `file_edit` as "file
  changed" and all feedback is suppressed.
- **Error messages must be actionable.** "Search text not found" tells the model nothing.
  `FileManager.explainPatchMiss()` distinguishes: change already present / only the first
  line matches / the file looks different – each with the next sensible step.
- **Cycle detection** via the fingerprint of the actions: the same round three times in a
  row ends the loop instead of burning through the step limit.
- **Shell output always goes back**, even when a file was changed in the same round. It
  used to be suppressed then – and that is the usual case: the model changes and tests in
  one go. A test run that exits 0 but reports red tests never reached the model that way.
  Cycle detection is what guards against endless loops today.
- **A change without verification is not an end state.** With `autoTest`, `planNextStep`
  asks for the tests when a round changed something and tested nothing. The auto-test line
  in the system prompt only *asks* the model to do it; in a real run it patched the
  tokenizer and stopped, although the task had five points.
- **Identical actions in one round run once.** Against laguna every tool call arrived
  twice: `npm test` ran twice, every file was read twice, and each round took twice as
  long. Byte-identical blocks are deduplicated; two `read_file` calls on *different* files
  remain two actions.

## One normalisation for the parser AND the display

`AIEngine.normalizeActionMarkup()` brings every spelling the model uses to
` ```action:name … ``` `. **Both paths use it** – `parseAndExecuteActions` and
`stripActionBlocks`.

When the parser had one stage more than the display, the result showed up in the window: a
`patch_file` block with misplaced fences was executed (the parser could straighten it out)
but stayed in the chat as text – the user read `>>>REPLACE` and the source code instead of
an answer. Add a stage here and you add it for both.

Included: XML and bracket tags, the native tool-call formats, unfenced header lines
(`action:done` without backticks) and missing closing fences between two blocks.

## The task belongs in every round – and nothing else

Two bugs with the same root, both observed in a running window: the assistant was supposed
to fetch a web page and answer three questions, but then resumed the test repair of the
previous session and ran `npm test` – although the task said "change no files".

- **The continuation prompts state the task verbatim.** "Continue working on the original
  task" without the text next to it makes the model look for it in the conversation – and
  what it finds there is yesterday's task. `planNextStep` puts `YOUR TASK:` with
  `this.currentTask` in front of every prompt.
- **The last session arrives as one note, not as conversation turns.**
  `HistoryManager.getLastSessionDigest()` returns a short list, clearly marked as
  finished. Replaying the old rounds one-to-one made the model treat the old task as the
  current one.
- **Never put text into an assistant turn that the assistant did not say.** An earlier
  version prefixed the reasoning summary as `[Vorheriges Reasoning] … [Antwort] …`. The
  model imitated the markers – and they then stood visibly in the answer in the chat.

## Prompts in English, answers in the user's language

The instructions to the model are **English**: models follow English instructions more
reliably, and the tool catalogue is in the prompt on every request.

The answer is unaffected. `LANGUAGE_RULE` sits at the start of every system prompt and is
repeated wherever a slip back into English would be immediately obvious: the announcement
before each action, the plan items and the closing summary.

The interface itself is English, and so are the log and the action descriptions. Only two
kinds of German are left in the code, both on purpose: the **input aliases** (`/ziel`,
`/schleife`, `30 Minuten`, `3 Runden`) so someone typing German is still understood, and
the **recognition patterns** for German requests ("suche im internet", the stop-word lists
in `webSearch.ts` and `practices.ts`). Those are data. Translated, they would simply stop
working.

## Goal, loop and queued instructions

`src/commands.ts` reads `/goal`, `/loop` and `/help` from the input – **before** the
request goes out. Sending a `/loop` to the model produces a description of a loop, not a
loop.

- **The goal lives beside the sessions, not inside one** (`HistoryFile.goal`). It outlives
  the window: someone who sets out to get "all tests green" still means it tomorrow.
  Inside a session it would be gone after the next reload – exactly when a long piece of
  work is starting. `clearAll()` therefore keeps it.
- **`runLoop` stops on four conditions**, and the fourth matters most: two rounds without
  any action. Without it the budget runs dry while the model explains every round that
  everything is done. The other three: cancelled, goal reached (`done` AND no open plan
  step), budget spent.
- **The round prompt says explicitly that "already done" is a valid answer.** Otherwise
  the model invents work to fill the round.
- **An instruction typed during work does not interrupt, it is queued**
  (`queueUserInput`) and inserted at the end of the step – before the step the loop would
  have planned itself. Cancelling mid-step would leave half-finished work behind: file
  changed, tests not run. The addition grows into `currentTask`, otherwise it is forgotten
  a round later.

## Learned best practices

`src/practices.ts` writes proven rules to `.ai-assistant/PRACTICES.md` and puts them into
every prompt. The pattern comes from Hermes, which turns successful approaches into
reusable procedural knowledge.

Four rules decide whether this helps or turns into noise:

1. **Only after something verified.** A "best practice" from a run whose tests never ran
   is a guess in disguise.
2. **Rules, not a diary.** "Fixed the tokenizer" helps nobody next time.
3. **Detect duplicates** – also when worded differently, because models phrase the same
   insight differently every time. Without it the file fills with near-duplicates.
4. **Cap it.** The text is in every request.

The block in the prompt is **fenced and marked as background knowledge**, not as an
instruction from the user – the same guard Hermes puts around its memory. The content was
written by a model and must not be able to pose as a user instruction.

A rejected duplicate reports **success**, not failure: otherwise the model treats it as an
error and tries again in the next round.

## Pitfall: WebView scripts inside template strings

`chatPanel.ts` and `settingsPanel.ts` generate their browser JavaScript inside a
TypeScript template string. In there:

- A `\n` inside a JS string literal must be written as **`\\n`**. A plain `\n` is turned
  into a real line break by the TypeScript compiler – in the middle of the JS string
  literal. The script is then unparseable, the **whole panel goes silent** (no chat
  history, no buttons) and no error appears in the log.
- The same goes for backticks and `${…}`: write them as `` \` `` and `\${…}`.

The test run checks both panels with `new Function(script)` against exactly this bug.

Parseability is not enough, though: `test/webview-rows.js` runs the chat script against a
rebuilt DOM and checks what the user actually sees. Two bugs only surfaced that way – a
tool row that stayed on "läuft…" when two fetches ran at once, and a hint text where a
broken escape sequence showed up as `00b7`. If you change the display, add a check there.

## Conventions

- **Everything the user reads is English**: buttons, settings labels, log messages, action
  descriptions, error texts. So are comments and identifiers. The exceptions are input
  aliases and language-recognition data – see "Prompts in English" above.
- Prompts to the model are English – see "Prompts in English" above.
- Singleton pattern: services offer `static getInstance()` (see `AIEngine`, `FileManager`).
- No file access outside the workspace – always through `FileManager.resolvePath()`.
- Read-only analysis (`read_file`, `grep`, `glob`, `list_dir`) runs natively in Node, not
  through the shell.
- **Never assume a shell exists.** `ShellRunner.environment()` reports the platform and
  whether `wsl.exe` / `powershell.exe` are really installed; `resolveShell()` honours a
  request only where it can run, and `AIEngine.shellManual()` describes only those routes
  in the prompt. Both halves matter: a model told about a missing shell reaches for it, and
  a request honoured verbatim dies on ENOENT. `wsl` was hard-wired once and every command
  failed on Linux; `powershell` had the same hole afterwards. The tests stub the
  environment for all three platforms — do the same rather than testing only your own
  machine.
- New settings belong in `package.json` → `contributes.configuration` **and** in the
  settings panel (`src/settingsPanel.ts`). A test compares the two, because `shell` and
  `allowPowerShell` had gone missing from the panel.
- Keep `CHANGELOG.md` up to date: new features and systemic changes, newest version first.
