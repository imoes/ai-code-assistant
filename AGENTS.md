# AGENTS.md – Projekt-Anweisungen für den AI Code Assistant

Diese Datei wird vom Assistenten bei **jeder** Anfrage als permanente Regel geladen
(neben `CLAUDE.md` und `command.md`).

## Projekt

VS Code Extension „AI Code Assistant" – ein autonomer Code-Assistent, der über einen
OpenAI-kompatiblen Endpunkt (lokaler llama.cpp-Server oder Cloud-Provider wie OpenRouter)
Code analysiert, plant, schreibt und testet.

- Quellcode: `src/*.ts`, Einstieg `src/extension.ts`
- Build: `npm run compile` (TypeScript → `out/`)
- Paketieren: `npm run package` (erzeugt `ai-code-assistant-<version>.vsix`)
- Repo: `git@gitlab.ippen.media:mutkluge/ai-code-assistant.git`

## Versionsnummer bei jeder Änderung hochzählen

**Pflicht:** Bei jeder funktionalen Änderung die `version` in `package.json` erhöhen,
bevor eine neue `.vsix` gebaut wird.

VS Code aktualisiert eine Extension nur, wenn sich die Version geändert hat – bei
gleicher Versionsnummer bleibt die alte Version installiert. Ohne Bump lässt sich die
neue `.vsix` also nicht sauber einspielen.

Schema (Semver):

| Art der Änderung                          | Bump  | Beispiel        |
|-------------------------------------------|-------|-----------------|
| Bugfix, Detailkorrektur                   | Patch | 0.2.0 → 0.2.1   |
| Neues Feature, neue Einstellung           | Minor | 0.2.1 → 0.3.0   |
| Breaking Change (Einstellungen entfallen) | Major | 0.3.0 → 1.0.0   |

Nach dem Bump: `npm run compile && npm run package`, dann die neue `.vsix` installieren
(`Extensions: Install from VSIX…`).

## .vsix-Pakete sind CI-Artefakte

Gebaute `.vsix`-Dateien werden **nicht** ins Repo committet (`.gitignore`). Sie entstehen
in der GitLab-Pipeline (`.gitlab-ci.yml`, Job `package`) und werden dort als Job-Artefakt
bereitgestellt: Pipeline → Job `package` → *Download artifacts*. Der Dateiname enthält
die Version aus `package.json` – daher ist der Version-Bump oben Voraussetzung dafür,
dass sich Artefakte unterscheiden lassen.

## Tool-Calling: der Server macht die Formatarbeit

Jede Modellfamilie hat ihr eigenes Tool-Call-Format (Qwen3-Coder XML, Hermes-JSON,
GLM/laguna `arg_key`, Mistral `[TOOL_CALLS]`, Llama `<|python_tag|>`, Kimi K3 XTML,
DeepSeek mit Fullwidth-Balken). Diese Formate im Antworttext zu erkennen ist ein
Fass ohne Boden – jedes neue Modell bringt ein neues.

**Deshalb ist der kanonische Weg:** die Werkzeuge im OpenAI-Schema als `tools` mitsenden
und `message.tool_calls` aus der Antwort lesen. llama.cpp (mit `--jinja`) rendert das
Format des Modells und parst es zurück; damit funktioniert jedes Modell, das der Server
unterstützt. Hermes löst es genauso – dort normalisiert jeder Provider-Transport auf ein
kanonisches `ToolCall {id, name, arguments}`; ein Textparser existiert dort gar nicht.

- Werkzeugkatalog: `TOOL_DEFINITIONS` in `src/toolCallParser.ts` – **die** Quelle der
  Wahrheit für Aktionsnamen und Argumente. Neue Aktion → hier eintragen, sonst kennt
  das Modell sie nicht.
- Der Textparser im selben Modul ist nur der Rückfall für Server ohne `--jinja`.
- Fremde Werkzeugnamen (`write_file`, `bash`, `str_replace_editor`, …) über
  `ACTION_ALIASES` abbilden, statt sie abzulehnen.

## Bei Werkzeugaufrufen gibt es keine Prosa

Modelle liefern bei nativen Tool-Calls `content: null` – sie stecken alles in den Aufruf
und schreiben keinen Begleittext. Wer die Erklärung an der Prosa aufhängt, bekommt sie
nur in der ersten Runde.

Deshalb trägt **jedes** Werkzeug in `TOOL_DEFINITIONS` ein Feld `absicht`: einen Satz in
der Ich-Form, was der Aufruf tut und warum. `toolCallsToActions()` sammelt diese Ansagen,
`renderActionBlock()` setzt sie als Text vor den Block (nie als Kopfzeile – sonst landen
sie im Dateiinhalt). Neue Werkzeuge brauchen dieses Feld ebenfalls.

## Nie ungeprüften Modelltext in eine Datei schreiben

Modelle lassen Reste ihrer eigenen Serialisierung im Argumentwert stehen – beobachtet:
eine Zeile `</arg_value>` mitten im Quellcode, die die Datei unbrauchbar machte. Ebenso
Abschluss-Marker wie `>>>` oder `>>>>>>> REPLACE` aus dem Patch-Format.

`AIEngine.cleanCodeForWrite()` filtert das vor jedem Schreibvorgang. Gefiltert werden nur
Zeilen, die **ausschließlich** aus solchem Markup bestehen – `if (a < b)` bleibt unberührt.

## Die Agenten-Schleife muss jeden Fehlschlag zurückmelden

`planNextStep` in `src/aiEngine.ts` entscheidet, ob und wie weitergearbeitet wird.
Dabei gilt:

- **Jeder Fehlschlag geht zurück ans Modell**, mit Begründung. Ein Testlauf zeigte, was
  sonst passiert: ein Patch schlug fehl, weil die Änderung schon drin war, die Meldung
  erreichte das Modell nie – und es schickte 18-mal denselben Patch.
- **Nur erfolgreiche Aktionen zählen als getane Arbeit.** Zählt ein gescheiterter
  `file_edit` als „Dateiänderung", werden alle Rückmeldungen unterdrückt.
- **Fehlermeldungen müssen handlungsleitend sein.** „Suchtext nicht gefunden" sagt dem
  Modell nichts. `FileManager.explainPatchMiss()` unterscheidet: Änderung bereits
  vorhanden / nur erste Zeile passt / Datei sieht anders aus – jeweils mit dem nächsten
  sinnvollen Schritt.
- **Kreislauf-Erkennung** über den Fingerabdruck der Aktionen: dieselbe Runde dreimal in
  Folge beendet die Schleife, statt das Schrittlimit zu verbrennen.

## Fallstrick: WebView-Skripte in Template-Strings

`chatPanel.ts` und `settingsPanel.ts` erzeugen ihr Browser-JavaScript in einem
TypeScript-Template-String. Darin gilt:

- Ein `\n` in einem JS-String-Literal muss als **`\\n`** geschrieben werden. Ein einfaches
  `\n` wird vom TypeScript-Compiler zu einem echten Zeilenumbruch – mitten im
  JS-String-Literal. Das Skript ist dann unparsebar, das **ganze Panel bleibt stumm**
  (kein Chatverlauf, keine Buttons) und es erscheint keine Fehlermeldung im Log.
- Dasselbe gilt für Backticks und `${…}`: als `` \` `` bzw. `\${…}` schreiben.

Der Testlauf prüft beide Panels mit `new Function(script)` gegen genau diesen Fehler.

## Konventionen

- Kommentare und Benutzertexte auf **Deutsch**, Code-Identifier auf **Englisch**.
- Singleton-Muster: Dienste bieten `static getInstance()` (siehe `AIEngine`, `FileManager`).
- Kein Dateizugriff außerhalb des Workspace – immer über `FileManager.resolvePath()`.
- Nur-Lese-Analyse (`read_file`, `grep`, `glob`, `list_dir`) läuft nativ in Node,
  nicht über die Shell. Shell-Befehle laufen über WSL.
- Neue Einstellungen gehören nach `package.json` → `contributes.configuration`
  **und** in das Einstellungs-Panel (`src/settingsPanel.ts`).
- `CHANGELOG.md` pflegen: neue Features und systemische Änderungen, neueste Version oben.
