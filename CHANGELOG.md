# Changelog

All notable changes to this project. Latest version at the top.

## 0.12.2

- **The Cancel button stays there while work is running.** It used to come and go: a round
  in which the assistant wrote prose took the button with it, a round with nothing but a
  tool call kept it. The reason was that the button and the "thinking" dots were one and
  the same thing — and the dots are meant to disappear once there is something to read. Now
  the two are separate: the dots go, the button stays, and only the end of the whole task
  removes it. The hint below the input field follows the same state, so it no longer claims
  Enter would send while an instruction would in fact be queued.

## 0.12.1

- **The assistant only uses the shell your machine has.** On startup it checks the
  operating system and whether `wsl.exe` and `powershell.exe` are really installed, and it
  is told about those routes only. On Linux and macOS PowerShell is no longer offered — and
  a `shell: powershell` block is no longer taken at face value there either, which used to
  mean trying to start `powershell.exe` and losing a round to the error. On Windows without
  WSL it is the other way round: commands go to PowerShell instead of nowhere, with the
  syntax that belongs to it. The **Run in PowerShell** / **Run in WSL** option appears only
  where the other shell is actually installed.
- The settings window gained the shell settings it was missing — which shell to use and
  whether PowerShell is allowed — with a line above them saying what this machine offers.

## 0.12.0

- **The interface is English.** Every text you read — buttons, settings and their
  explanations, the mode list, tool rows, confirmation dialogs, error messages, the log —
  is now English, so the project reads the same way for anyone who opens it. What has not
  changed is the part that matters most: the assistant still **answers in the language you
  asked in**. Ask in German and the chat, the plan and the closing summary come back in
  German. German input still works too: `/ziel`, `/schleife`, `30 Minuten`, `3 Runden` are
  understood as before.
- **You choose the shell, per command.** Next to **Run**, the confirmation now offers
  **Run in PowerShell** or **Run in WSL** — whichever is the other one. The question belongs
  to the command, not to a setting: `npm test` belongs in WSL, a `Get-Service` only works in
  PowerShell, and you often know which a moment before the assistant does. Switching costs
  one click instead of a whole round through "Something else". In auto mode, where nothing is
  confirmed, the assistant asks by itself when both routes would do.

## 0.11.8

- **You see everything the assistant does.** Every action now leaves a line in the chat:
  the shell command in full, the path it wrote, the output it got back, and the reason
  when something failed. Before, five of the writing actions and every error that was
  thrown reported nothing at all — a file was created, a patch did not apply, and the chat
  showed the announcement and then silence. A `/loop` run closes with a summary of every
  action across all its rounds, so you do not have to scroll back through eight of them.
- **And you see that it is still working.** While the assistant writes a tool call there is
  no text to show — with native tool calling the model puts everything into the call. The
  status line now names what is being written ("Datei wird geschrieben… 2.1k Tok") instead
  of leaving you with a number that does not say what it counts, and it no longer goes
  quiet inside a loop after the first round.

## 0.11.0

- **A goal that sticks: `/goal`.** The goal is not the task of one round; it is what all
  tasks work towards. It goes into every request, sits as a bar above the chat and outlives
  the session and a window restart — "Verlauf löschen" clears the conversation, not the
  intention. `/goal` on its own shows it, `/goal löschen` removes it.
- **Work towards it repeatedly: `/loop 15m <task>`.** After each round the assistant checks
  what is still missing for the goal and carries on. Budget as time (`5m`, `2h`) or rounds
  (`3x`), capped at two hours. The loop ends when the goal is reached, the budget is spent,
  you cancel — or two rounds pass without anything happening. That last one matters most:
  otherwise the budget runs dry while the assistant explains every round anew that surely
  everything is done already.
- **Type without interrupting.** An instruction typed during work is queued and comes up
  after the current step — before the step the assistant would have planned itself. It
  appears in the chat straight away, marked "eingereiht". Previously a new instruction
  aborted the running work and left half-finished changes behind: file changed, tests not
  run. To stop at once, click **Abbrechen** as before.
- **The assistant learns from its successes.** What verifiably worked is written as a rule
  to `.ai-assistant/PRACTICES.md`, and next time it knows again — how this project is
  tested, which pitfall cost a round, which convention only became apparent from the code.
  The file is plain Markdown and may be edited by hand: a rule that is wrong can simply be
  deleted. Only verified insights are recorded, at most one rule per task — no diary
  entries.
- The project is licensed under **Apache-2.0**.

## 0.10.0

- **Answers appear as Markdown, not as raw text.** Lists, emphasis and code blocks are
  rendered, and the tool markup disappears from the display. Until now you would read
  `>>>REPLACE` and source code in the middle of an answer: while writing, the chat showed
  the unprocessed model output. The closing summary is now an answer too, no longer an
  output box, and the block at the end of a run no longer repeats every action — it states
  the balance and what failed.
- **The assistant can run Windows commands, not just WSL.** Services, registry, drivers,
  WinGet, Windows programs — for those it picks PowerShell, while build and tests stay
  under WSL. Switch it off with `aiAssistant.allowPowerShell`, set the default with
  `aiAssistant.shell`.
- **The assistant asks when the decision is yours.** When the choice is between two
  defensible routes — a library, a naming scheme, whether to touch a file at all — a card
  appears with two to four options, each with an explanation, plus a field for something
  else. It deliberately does not ask about things it can read in the code, and not for
  permission to keep working.
- **The instructions to the model are now English — the answer stays German.** Models
  follow English instructions more reliably and the prompt gets shorter. Nothing changes
  for you: asked in German means answered in German, including the announcements, the plan
  items and the closing text.

## 0.9.0

- **The web search finds something again without a key.** Instead of one source, several
  independent ones are now queried at the same time and their hits merged: DuckDuckGo (the
  Lite interface when blocked), Stack Overflow through the official API, and Wikipedia. If
  one fails the others carry it — in the test run DuckDuckGo was blocked outright for this
  connection, and four out of five questions still returned hits.

  The background: there is no free, unlimited web search. The Bing Search API was shut
  down in August 2025, Brave has been paid since February 2026, and running your own
  SearXNG only moves the problem — it queries Google and Bing on your behalf, and their
  blocks still apply. Only "fetch page" (`web_fetch`) is unlimited, and for documentation
  that is the shorter route anyway.
- **The assistant verifies its own change.** Previously the work ended after the first
  successful file change: given a task with five points, the first was implemented and
  never tested. Now the tests run, and it carries on until every point is done and the
  tests are green. The assistant also sees the output of a test run when it changed a file
  in the same round — which is the usual case.
- **Cancel works between the iterations, and a new task interrupts the running one.** The
  input field stays usable during a run; Enter stops the old task and starts the new one.
  Previously "Abbrechen" only ended the current request while the loop kept going.
- **The assistant says what it intends to do in every round**, not just at the start. And
  it no longer picks up a task from an earlier session: the last session arrives as a
  short note, clearly marked as finished, instead of a replayed conversation.
- **Raw tool markup disappears from the answers.** `action:done`, `>>>REPLACE` and
  truncated blocks used to stand in the chat as text whenever the model left out a
  backtick fence.

## 0.8.0

- **Answers are displayed as Markdown:** bullet lists, numbered lists,
  Headings, blockquotes, tables, links, and code blocks with language specification. Previously,
  Lists as bare hyphens in the text.
- **Every action is a compact line** – period, tool name, target – as in a
  Terminal. The output shows four lines; the rest is hidden behind “+N more lines”.
- **New tool "Fetch Webpage" (`web_fetch`):** fetches a webpage and returns its text
  to the assistant. A search results list consists only of titles and addresses – with
  cannot answer a question. Only the page content helps.
- **Web search across multiple providers:** Tavily, Brave, Google, or a custom one
  SearXNG instance (each with key or address), DuckDuckGo as a last resort.
  Without a key, only DuckDuckGo remains, and it throttles heavily – if the search yields nothing,
  the assistant now says so clearly and falls back to `web_fetch` instead of repeating
  the same search.
- **Search results include text excerpts.** The evaluation of the DuckDuckGo page had
  only title and links provided because several nested elements have the same
  Carry class prefix.
- **Page view follows redirects.** Almost every documentation page responds with
  301 or 302; previously, an empty body was returned.
- The mode in the sidebar shows all three modes instead of "Automatic / Manual".
- `npm test` runs the complete test suite (381 checks), as does the CI pipeline.

## 0.7.3

- **No more endless waiting when the server goes silent.** The streaming request had
  no time limit at all: the connection dropped in the middle of the answer (VPN disconnected, server
  overloaded), the assistant waited indefinitely – without notification, without any way out except
  "Cancel". Now, after 180 seconds of silence, it cancels and says what's going on.
  The pause between two response parts is measured, not the total duration – a
  Long responses remain permitted. Configurable via `aiAssistant.streamIdleTimeoutSeconds`.

## 0.7.1

- **Shell commands now also run on Linux and macOS.** `wsl` was hardcoded,
  as a result, every command failed there – including `echo test`. Under Windows, it continues to run
  all about WSL. Without a working shell, the assistant cannot apply its changes
  test and does not find its own errors.

## 0.7.0

- **The assistant announces what it is doing at each step** – not just at the first one.
  Each tool has an `intent` field that the model populates with the call.
  Previously, the announcement depended on the model's prose, and that remains the case
  Tool invocations are mostly empty (`content: null`) – you only saw a list of actions.
- **The thinking bar indicates what is currently happening:** "Evaluating input... 45 %"
  during prompt evaluation, then "Response is being generated… 240 tokens".
  For large contexts, input alone takes minutes – previously, only “AI is thinking…” was displayed.
- **Serialization residues no longer end up in the source code.** A model had a line
  `</arg_value>` written into a file, rendering it unusable.
  Such lines are removed before writing and reported in the log.

## 0.6.1

- **Working log in the terminal** "AI Assistant": every step with justification, every
  Command with `$` prompt, every output, every change with line count – colored and
  running. Previously, it was not clear what the assistant was doing between the steps.
  (Nothing is executed there, only displayed.)
- **The assistant states what it is doing** before it does it – a sentence in the first person
  each tool call, and at most three actions per round.
- **No more infinite loops.** If a change failed, the assistant did not know
  and repeated it – applying the same patch 18 times in a test run. Now it is:
  Failed changes are reported back with a reason, only successful
  count as completed work, and ending the same round three times in a row terminates the loop.
- **Understandable patch errors:** The assistant now learns whether the change has already
  is present, whether only the first line fits (with line numbers) or whether the file
  looks different than expected – instead of just "Search text not found".
- The token statistics remain constant throughout the entire task (previously located in the
  Thinking bar and disappeared at each step).
- The reasoning block starts collapsed and remains as you set it – before
  it would automatically close again upon completion.

## 0.5.0

- **Three work modes** as a listbox in the chat toolbar: **Ask** (every change is
  confirmed), **Auto** (proceeds without asking questions) and **Plan** (is allowed to read only and
  plan – file changes and shell commands are blocked, even if the model attempts them).
- **Diffs even in auto mode:** every applied change appears in the chat as a colored
  Diff map with path and line balance. Previously, in auto mode,
  what has been changed.
- **Live metrics** in the thinking bar: progress of input evaluation in percent
  as well as tokens and tokens/second for input and output. With large contexts, one knows
  jetzt, ob etwas passiert.
- **Conversation history is automatically summarized** when it reaches 89% of the model context
  (Threshold adjustable). The context size is queried from the server instead of being guessed.
  Long agent runs no longer terminate as a result.
- **Clear History** button in the chat toolbar.
- Each action gets its own progress card in the chat. Previously, they
  all messages mutually, so that test and search outputs remained invisible.
- Changes with `patch_file` are reliable: model end markers (`>>>`,
  `>>>>>>> REPLACE`, `=======`) no longer appear in the source code. The git conflict notation
  is also accepted.

## 0.3.0

- The assistant now works with **all** common models – Qwen, Gemma, Kimi,
  laguna, DeepSeek, Mistral, Llama. The tools are sent to the server in the OpenAI schema
  sent, which generates the model-specific format and translates it back.
  Previously, the assistant remained silent for models with its own tool format: it described,
  what he would do, but did not carry out anything.
- For servers without tool support, there is a fallback that uses the calls from the
  Response text reads – all common formats are recognized there as well.
- New setting **Tools via the Server API** (on by default; with llama.cpp is
  for `--jinja` necessary).
- Tool names of other assistants (`write_file`, `bash`, `str_replace_editor`, …) are
  accepted – a model that was trained on a different harness still works here.

## 0.2.2

- The chat is working again: an error in the panel script had the entire
  Chat interface disabled (no history, no mode badge, no response to inputs).
- When opening a chat session, the keyboard focus is now in the input field – you can
  tap immediately, even if the chat was opened via the command palette.

## 0.2.1

- File paths displayed during analysis are now short and project-relative instead of absolute.

## 0.2.0

- The assistant now analyzes the existing code itself: it searches the project
  via regex, finds files by pattern and reads them in sections – before making any changes.
- Multi-step tasks are created as a plan and processed step by step;
  The progress appears in the chat as a checklist.
- The assistant continues to work independently until the task is completed: analyze →
  plan → change → test → correct. Step count can be limited via `aiAssistant.maxAgentSteps`.
- Own settings panel with **Save** button (⚙ in the chat toolbar or
  `Ctrl+S` in the panel), including a connection test and a hideable API key field.
- Cloud provider usable: optional API key (`aiAssistant.apiKey`) for OpenRouter,
  OpenAI, Groq, and Together – instead of a local llama.cpp server.
- The auto mode can be toggled by clicking the mode badge in the chat toolbar.
- Project rules from `AGENTS.md`, `CLAUDE.md`, `command.md`, and
  `.github/copilot-instructions.md` are considered with every request.

## 0.1.0

- First version: Chat panel as editor tab, create/edit/delete files with
  Diff confirmation, shell commands via WSL, undo for all AI actions, web search,
  automatic error correction based on shell output.
