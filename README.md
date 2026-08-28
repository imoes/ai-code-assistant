# AI Code Assistant – a VS Code extension

An autonomous coding assistant for VS Code / VSCodium 1.105+. The engine is either a local
**llama.cpp** server or any OpenAI-compatible cloud provider (OpenRouter, OpenAI, Groq,
Together – API key optional).

The assistant works like a developer beside you: it **reads and searches** the existing
code, **plans** multi-step tasks, **changes** files, **runs the tests** and **corrects
itself** from the error output – until the task is done.

> **A note on language.** The user interface is German: buttons, log messages and the
> assistant's answers. The instructions sent to the model are English, because models
> follow them more reliably – but the assistant always answers in the language you asked
> in. Code, comments and this documentation are English.

📋 Changes: [CHANGELOG.md](CHANGELOG.md) · 📖 Project rules: [AGENTS.md](AGENTS.md) ·
⚖ License: [Apache-2.0](LICENSE)

---

## What the assistant can do

**Analyse before writing.** These tools change nothing and therefore run without asking –
the first four directly inside the extension, without WSL and without a shell:

| Tool | Purpose |
|---|---|
| `read_file` | Read a file with line numbers, in sections via `offset`/`limit` |
| `grep` | Regex search across the whole project (like ripgrep), optionally glob-filtered |
| `glob` | Find files by pattern, e.g. `**/*.test.ts` |
| `list_dir` | List a directory |
| `web_search` | Search the web (title, address, excerpt) |
| `web_fetch` | Fetch a web page and read its text |

**Plan.** For tasks with more than two steps the assistant writes a todo list and works
through it. The progress appears in the chat as a checklist with a progress bar.

**Work on its own (agent loop).** Per round: call tools → evaluate the results → next
step. The loop ends when the assistant reports the task as done or the step limit is
reached.

**Two shells.** Build, tests and git run under WSL/bash. For anything that genuinely needs
Windows – services, registry, drivers, WinGet, Windows-only executables – the assistant
switches to PowerShell for that one command.

**Respect the project rules.** `AGENTS.md`, `CLAUDE.md`, `command.md` and
`.github/copilot-instructions.md` are loaded as permanent rules on every request.

**Ask when the decision is yours.** When the choice between two defensible routes is
yours to make, a card appears with two to four options, each with an explanation, plus a
field for something else. It does not ask about things it can read in the code.

**Learn from what worked.** Verified insights are written as rules to
`.ai-assistant/PRACTICES.md` and go into every later request — see
[Learned best practices](#learned-best-practices).

---

## Setting a goal and working in a loop

Two commands you type into the input field. They belong together.

### `/goal` — the standing goal

```
/goal The parser understands variables and all tests are green
```

The goal is not the task of one round; it is what all tasks work towards. It goes into
**every** request, sits as a bar above the chat and outlives the session and a window
restart — it is stored beside the conversation, not inside it. "Verlauf löschen" (clear
history) removes the conversation, not the intention.

| Input | Effect |
|---|---|
| `/goal <text>` | Set the goal |
| `/goal` | Show the current goal |
| `/goal löschen` | Remove the goal (`clear` also works) |

### `/loop` — work towards it repeatedly

```
/loop 15m Find what is still open and work through it
```

One round is a full run including its own agent loop. Afterwards the assistant checks what
is still missing for the goal, and carries on.

| Budget | Examples |
|---|---|
| Time | `5m`, `30 Minuten`, `2h` |
| Rounds | `3x`, `3 Runden` |
| omitted | 10 minutes, at most 6 rounds |

Capped at two hours and 40 rounds — a loop changes files and costs tokens.

**It ends** as soon as one of these happens:

- The assistant reports the goal as reached **and** no plan step is open
- The time or round budget is spent
- You click **Abbrechen** (cancel)
- Two rounds in a row without any action

The last one matters most: without it the budget runs dry while the model explains every
round anew that surely everything is done already.

### Interjecting without interrupting

You can type at any time — including in the middle of a run. The instruction is **queued**
and comes up after the current step, before the step the loop would have planned itself.
It appears in the chat immediately, marked "⏳ eingereiht" (queued).

Why not interrupt straight away: cancelling mid-step leaves half-finished work behind —
file changed, tests not run. At the end of a step the state is clean. If you really do want
to stop at once, click **Abbrechen**.

The addition stays part of the task in later rounds too — otherwise it would be forgotten
one round later.

---

## Learned best practices

The assistant writes down what worked and reads it again next time. The idea comes from
Hermes, which turns successful approaches into reusable procedural knowledge: general
memory is broad and descriptive, procedural knowledge is narrow and actionable. The second
kind is worth keeping.

Stored in `.ai-assistant/PRACTICES.md` — plain Markdown inside the project:

```markdown
# Best Practices

- Run the tests with `npm test`, not `node --test` (pretest compiles first) <!-- 2026-08-28 -->
- Shell commands run under WSL, so paths look like /mnt/d/... <!-- 2026-08-28 -->
```

**The file may be edited by hand.** A rule that is wrong can simply be deleted. It belongs
to the project and can be committed, like `AGENTS.md`.

Only what **verified** worked and still holds next time gets written down: how this
project is built, tested and started; a pitfall that cost a round; a convention that only
became apparent from the code. Explicitly **not** written down: diary entries ("fixed the
bug"), anything unverified, and general programming knowledge. At most one rule per task.

Duplicates are detected even when worded differently — models phrase the same insight
differently every time. In the prompt the block is fenced and explicitly marked as
background knowledge, not as an instruction: the text was written by a model and must not
be able to pose as one.

---

## Requirements

### 1. Start a llama.cpp server (WSL or Linux)

```bash
# Download a model (example: Mistral 7B Instruct GGUF)
wget https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3-Q4_K_M.gguf

# Start the server (OpenAI-compatible API)
./llama-server \
  --model Mistral-7B-Instruct-v0.3-Q4_K_M.gguf \
  --port 8080 \
  --host 0.0.0.0 \
  --ctx-size 8192 \
  --n-predict 2048 \
  --jinja
```

`--jinja` matters: with it the server renders and parses the model's own tool-call format,
which is what makes Qwen, Gemma, Kimi, DeepSeek and Mistral all work through the same
code path. Without it the assistant falls back to parsing tool calls out of the answer
text.

### 2. Install WSL (Windows)

```powershell
wsl --install
```

---

## Installing the extension

### Option A: install the .vsix directly

```bash
# In VS Code / VSCodium:
# Ctrl+Shift+P → "Extensions: Install from VSIX..."
# → pick ai-code-assistant-<version>.vsix
```

Prebuilt packages come from CI as build artefacts; they are not committed to the repo.

### Option B: from source

```bash
git clone <repo>
cd ai-code-assistant
npm install          # on Windows via WSL: wsl npm install
npm run compile      # on Windows via WSL: wsl npm run compile
npm test             # 779 checks, no network and no model server needed
npm run package
```

---

## Configuration

The easiest way is the **settings panel**: the ⚙ button in the chat toolbar, or
`Ctrl+Shift+P` → *AI Assistant: Einstellungen öffnen*. Changes are collected there and only
applied on **💾 Speichern** (or `Ctrl+S`) – that way an API key can be typed in full
without intermediate states being saved. The **🔌 Verbindung testen** button saves first
and then checks the endpoint.

Or the classic way via `Ctrl+,` → `aiAssistant`:

### Connection

| Setting | Default | Description |
|---|---|---|
| `aiAssistant.serverUrl` | `http://localhost:8080` | Endpoint URL. OpenRouter: `https://openrouter.ai/api` |
| `aiAssistant.apiKey` | `` | **Optional.** Cloud providers only; sent as `Authorization: Bearer …` |
| `aiAssistant.model` | `` | Model name (empty = server default) |
| `aiAssistant.mcpEnabled` | `true` | Use the llama.cpp MCP protocol (skipped automatically for cloud providers) |
| `aiAssistant.nativeToolCalls` | `true` | Send tools via the server API (recommended). Off = parse tool calls out of the text |

### Agent

| Setting | Default | Description |
|---|---|---|
| `aiAssistant.mode` | `ask` | Working mode: `ask`, `auto` or `plan` |
| `aiAssistant.agentLoop` | `true` | Agent loop: keep working until done |
| `aiAssistant.maxAgentSteps` | `12` | Maximum steps per task |
| `aiAssistant.planningEnabled` | `true` | Planning (todo list) |
| `aiAssistant.autoAnalyze` | `true` | Read before writing |
| `aiAssistant.showConsole` | `true` | Work log in a terminal |
| `aiAssistant.autoCompact` | `true` | Summarise a long conversation |
| `aiAssistant.compactThresholdPercent` | `89` | Summarise from this share of the context |
| `aiAssistant.instructionFiles` | `AGENTS.md`, `CLAUDE.md`, … | Project instruction files |

### Shell

| Setting | Default | Description |
|---|---|---|
| `aiAssistant.allowShellCommands` | `true` | Allow shell commands at all |
| `aiAssistant.shell` | `auto` | Default shell: `auto`, `wsl` or `powershell` |
| `aiAssistant.allowPowerShell` | `true` | Allow PowerShell commands |
| `aiAssistant.confirmDangerousOps` | `true` | Warn before dangerous operations |

The assistant may pick the other shell per command — some tasks only work in one of them.
It is instructed to prefer WSL; build and test commands belong there.

### Tests, model

| Setting | Default | Description |
|---|---|---|
| `aiAssistant.autoTest` | `false` | Run the tests automatically after changes |
| `aiAssistant.autoFixOnError` | `true` | Analyse error output and correct it |
| `aiAssistant.autoFixIterations` | `3` | Maximum correction rounds |
| `aiAssistant.maxTokens` | `2048` | Maximum tokens per answer |
| `aiAssistant.temperature` | `0.2` | Creativity (0 = deterministic) |
| `aiAssistant.contextWarningThreshold` | `6000` | Context warning from (tokens) |
| `aiAssistant.streamIdleTimeoutSeconds` | `180` | Abort after this much silence mid-answer |
| `aiAssistant.systemPrompt` | (English) | Adjust the system prompt |

### Web search

**There is no free, unlimited general web search.** Every route is either a provider with
a quota, or it scrapes an HTML page and gets blocked beyond a certain volume. Concretely:

- The **Bing Search API was shut down on 2025-08-11.** Microsoft points to *Grounding with
  Bing Search* in Azure AI Foundry – which is not a search API but an agent service, and
  more expensive than what it replaced.
- **Brave** dropped its free tier in February 2026 (from $5/month).
- **Running your own SearXNG** does not lift the limits: SearXNG queries Google, Bing and
  DuckDuckGo on your behalf, and their blocks still apply. It only moves the scraping.
- **DuckDuckGo** works without a key – until the IP gets blocked. Observed: after roughly
  five queries in a row nothing comes back.

So the default is not a single service but a **bundle of independent sources**, queried
together and merged. If one fails, the others carry it:

| Source | Limit | Good for |
|---|---|---|
| **DuckDuckGo** (HTML, else Lite) | IP block after a few queries | general search |
| **Stack Overflow** (official API) | 300 queries/day per IP, no key | programming questions – usually the best source |
| **Wikipedia** (MediaWiki API) | practically none | terms and techniques; last resort only, it is noisy for code questions |

DuckDuckGo Lite is only queried when `/html/` returns nothing – two queries to the same
service bring the block on faster.

With a key it stays more reliable. `aiAssistant.searchProvider` picks one:

| Provider | What it needs |
|---|---|
| **Tavily** (recommended) | `aiAssistant.searchApiKey` – returns text excerpts instead of just links, free quota |
| **Brave Search** | `aiAssistant.searchApiKey` (paid) |
| **Google Programmable Search** | `searchApiKey` + search ID (`cx`) in `aiAssistant.searchEndpoint`, 100 queries/day free |
| **SearXNG** (own instance) | Address in `aiAssistant.searchEndpoint`; `search.formats` in `settings.yml` must include `json`, otherwise the instance answers with HTML instead of JSON |

**Only `web_fetch` is unlimited**: fetch a known address and read it. For documentation
that is the reliable route – and usually the shorter one, because a list of titles and
links does not answer a question anyway. When the search finds nothing, the assistant
names each cause separately and falls back to fetching, instead of repeating the same
search.

### A cloud provider instead of a local server

OpenRouter, for example:

```
aiAssistant.serverUrl = https://openrouter.ai/api
aiAssistant.apiKey    = sk-or-v1-…
aiAssistant.model     = anthropic/claude-sonnet-4.5
```

With an API key set and a non-local URL the MCP protocol is skipped and the
OpenAI-compatible API is used directly.

### Working modes

The dropdown in the chat toolbar switches between three modes (also via `Ctrl+Shift+P` →
*AI Assistant: Arbeitsmodus wählen*):

| Mode | Behaviour |
|---|---|
| 🔒 **Ask** (default) | Every file change and every shell command is confirmed in the chat – with a coloured diff and "In Editor öffnen". |
| ⚡ **Auto** | The assistant works through without asking. Every change still appears as a diff card in the chat, and everything stays revertible via `↩ Undo`. |
| 📋 **Plan** | The assistant may only read and plan. File changes and shell commands are blocked – even if the model attempts them. Good for seeing the plan first and deciding afterwards. |

---

## What you can see while it works

- **The assistant says what it is doing before each step** – one sentence in the first
  person ("The tokenizer only reads a single digit. I'll collect the digits in a loop.").
- **The plan** as a checklist with a progress bar, updated live.
- **Every action** as a compact row: tool, target, and the output behind a toggle.
- **Every change** as a coloured diff card with the path and a `−x / +y` balance.
- **Reasoning** as a collapsible block with a line count – starts collapsed and stays the
  way you leave it.
- **Metrics** under the input, continuously: `↓ 3.1k Tok @ 82/s · ↑ 240 Tok @ 30.4/s`. The
  thinking bar names the phase: "Eingabe wird ausgewertet… 45 %", then "Antwort wird
  erzeugt… 240 Tok". This comes from the llama.cpp server; cloud providers do not supply
  it.

### Work log in a terminal

The assistant also writes everything into a terminal called **AI Assistant**: the task,
every step with its reason, every command with a `$` prompt, every output, every change
with its line balance – coloured and live. That makes a long agent run readable afterwards.

**Nothing is executed there**, it is only displayed (a pseudo-terminal). Can be switched
off via `aiAssistant.showConsole`.

### Long conversations

When the conversation reaches **89 %** of the model's context, the assistant summarises the
older messages automatically and carries on – the last four are kept verbatim. The context
size is queried from the server (`/v1/models` → `meta.n_ctx`). Threshold:
`aiAssistant.compactThresholdPercent`, switched off via `aiAssistant.autoCompact`.

The **🗑 Verlauf löschen** button removes all stored sessions from
`ai-code-assistant.json`. Code changes already applied stay in place, and so does the goal.

---

## Usage

### The chat panel

1. Click the **robot icon** in the activity bar
2. Type an instruction into the text field
3. Send with `Enter` (`Shift+Enter` for a line break)

### Example instructions

```
Erstelle eine REST API mit Express.js und TypeScript
Füge Unit-Tests für alle Funktionen in src/utils.ts hinzu
Analysiere den Code und optimiere die Performance
Führe npm test aus und erkläre eventuelle Fehler
```

(Ask in whichever language you like – the answer comes back in the same one.)

### Commands (Ctrl+Shift+P)

| Command | Description |
|---|---|
| `AI Assistant: Panel öffnen` | Focus the chat panel |
| `AI Assistant: Einstellungen öffnen` | Open the settings panel |
| `AI Assistant: Arbeitsmodus wählen` | Pick Ask / Auto / Plan |
| `AI Assistant: Verbindung testen` | Ping the llama.cpp server |
| `AI Assistant: Letzte KI-Aktion rückgängig machen` | Revert the last change |
| `AI Assistant: Alle KI-Aktionen rückgängig machen` | Revert all changes |
| `AI Assistant: Log anzeigen` | Open the output channel |

### Chat commands

| Command | Description |
|---|---|
| `/goal <text>` | Set the standing goal |
| `/loop <budget> <task>` | Work towards the goal repeatedly |
| `/help` | Show the command overview |

---

## Action format (for developers)

With `nativeToolCalls` (the default) the tools are sent in the OpenAI schema and the
assistant reads `message.tool_calls`. Servers without `--jinja` fall back to these blocks
in the answer text:

````
```action:create_file
path: src/api/routes.ts
---
<file content>
```

```action:patch_file
path: src/index.ts
---
<<<SEARCH
<exact existing code>
>>>REPLACE
<new code>
```

```action:shell
npm install express @types/express
```

```action:shell
shell: powershell
---
Get-Service -Name Spooler | Select-Object Status, Name
```
````

`TOOL_DEFINITIONS` in `src/toolCallParser.ts` is the source of truth for action names and
arguments. A new action has to be registered there – adding it to the prompt text alone is
not enough, because with native tool calls the model only sees the catalogue.

---

## Undo

Every file operation by the AI is recorded:

- **Chat toolbar**: `↩ Undo` / `↩↩ Undo All`
- **Command palette**: `AI Assistant: Letzte KI-Aktion rückgängig machen`
- **Key bindings**: configurable via `keybindings.json`

---

## Architecture

```
src/
├── extension.ts       # activation, command registration
├── chatPanel.ts       # the chat as a webview panel
├── settingsPanel.ts   # settings as a form with a save button
├── sidebarProvider.ts # the tree view in the activity bar
├── aiEngine.ts        # requests, action parser, agent loop
├── commands.ts        # /goal, /loop, /help
├── practices.ts       # learned best practices
├── toolCallParser.ts  # tool catalogue + the models' native formats
├── mcpClient.ts       # HTTP/MCP client, streaming, statistics
├── fileManager.ts     # file operations (with undo support)
├── shellRunner.ts     # WSL/bash and PowerShell
├── codeAnalyzer.ts    # read_file, grep, glob, list_dir
├── webSearch.ts       # search providers and page fetching
├── historyManager.ts  # conversation history and the goal
├── diff.ts            # diff computation for the cards
├── actionHistory.ts   # undo history
├── agentConsole.ts    # the work log terminal
└── logger.ts          # output channel logging
```

---

## Security

- All file operations are restricted to the **open workspace** (path traversal protection)
- Shell commands run in the **workspace directory** only
- Dangerous commands (`rm -rf`, `curl | bash`, `Remove-Item -Recurse -Force`, …) are
  detected and have to be confirmed – separate patterns per shell
- `mode: ask` (default): every action needs the user's consent
- Model-written text never reaches a file unchecked (`cleanCodeForWrite`), and learned
  practices are fenced in the prompt so they cannot pose as user instructions

---

## License

Apache-2.0 – see [LICENSE](LICENSE).
