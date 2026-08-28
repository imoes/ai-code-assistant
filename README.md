# AI Code Assistant – VSCodium Extension

Ein autonomer AI Code Assistant für VSCodium 1.105+. Als KI-Engine dient entweder ein
lokaler **llama.cpp**-Server oder ein OpenAI-kompatibler Cloud-Anbieter (OpenRouter,
OpenAI, Groq, Together – API-Key optional).

Der Assistent arbeitet wie ein Entwickler an deiner Seite: er **liest und durchsucht**
den bestehenden Code, **plant** mehrschrittige Aufgaben, **ändert** Dateien, **führt
Tests aus** und **korrigiert** sich anhand der Fehlerausgabe – bis die Aufgabe erledigt ist.

📋 Änderungen siehe [CHANGELOG.md](CHANGELOG.md) · 📖 Projektregeln siehe [AGENTS.md](AGENTS.md)

---

## Was der Assistent kann

**Analysieren, bevor er schreibt.** Vier Nur-Lese-Werkzeuge laufen ohne Rückfrage direkt
in der Extension (kein WSL, keine Shell):

| Werkzeug | Zweck |
|---|---|
| `read_file` | Datei mit Zeilennummern lesen, abschnittsweise per `offset`/`limit` |
| `grep` | Regex-Suche über das ganze Projekt (wie ripgrep), optional Glob-gefiltert |
| `glob` | Dateien nach Muster finden, z.B. `**/*.test.ts` |
| `list_dir` | Verzeichnis auflisten |
| `web_search` | Im Internet suchen (Titel, Adresse, Textauszug) |
| `web_fetch` | Eine Webseite abrufen und ihren Text lesen |

**Planen.** Bei Aufgaben mit mehr als zwei Schritten legt der Assistent eine Todo-Liste an
und arbeitet sie ab. Der Fortschritt erscheint im Chat als Checkliste mit Fortschrittsbalken.

**Selbständig arbeiten (Agenten-Schleife).** Pro Runde: Werkzeuge aufrufen → Ergebnisse
auswerten → nächster Schritt. Die Schleife endet, wenn der Assistent die Aufgabe als
erledigt meldet oder das Schrittlimit erreicht ist.

**Projektregeln beachten.** `AGENTS.md`, `CLAUDE.md`, `command.md` und
`.github/copilot-instructions.md` werden bei jeder Anfrage als permanente Regeln geladen.

---

## Voraussetzungen

### 1. llama.cpp Server starten (WSL oder Linux)

```bash
# Modell herunterladen (Beispiel: Mistral 7B Instruct GGUF)
wget https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3-Q4_K_M.gguf

# Server starten (OpenAI-kompatible API)
./llama-server \
  --model Mistral-7B-Instruct-v0.3-Q4_K_M.gguf \
  --port 8080 \
  --host 0.0.0.0 \
  --ctx-size 8192 \
  --n-predict 2048

# OPTIONAL: Mit MCP-Server-Support (experimentell)
./llama-server \
  --model Mistral-7B-Instruct-v0.3-Q4_K_M.gguf \
  --port 8080 \
  --mcp-server
```

### 2. WSL installieren (Windows)
```powershell
wsl --install
```

---

## Installation der Extension

### Option A: .vsix direkt installieren

```bash
# In VSCodium:
# Strg+Shift+P → "Extensions: Install from VSIX..."
# → ai-code-assistant-0.1.0.vsix auswählen
```

### Option B: Aus dem Quellcode

```bash
git clone <repo>
cd ai-code-assistant
npm install          # via WSL: wsl npm install
npm run compile      # via WSL: wsl npm run compile
```

---

## Konfiguration

Am einfachsten über das **Einstellungs-Panel**: ⚙-Button in der Chat-Toolbar oder
`Strg+Shift+P` → *AI Assistant: Einstellungen öffnen*. Änderungen werden dort gesammelt
und erst per **💾 Speichern** (oder `Strg+S`) übernommen – so lässt sich ein API-Key
vollständig eintippen, ohne dass Zwischenstände gespeichert werden. Der Button
**🔌 Verbindung testen** speichert vorher und prüft dann den Endpunkt.

Alternativ klassisch über `Strg+,` → `aiAssistant`:

### Verbindung

| Einstellung | Standard | Beschreibung |
|---|---|---|
| `aiAssistant.serverUrl` | `http://localhost:8080` | Endpunkt-URL. OpenRouter: `https://openrouter.ai/api` |
| `aiAssistant.apiKey` | `` | **Optional.** Nur für Cloud-Anbieter, wird als `Authorization: Bearer …` gesendet |
| `aiAssistant.model` | `` | Modellname (leer = Serverstandard) |
| `aiAssistant.mcpEnabled` | `true` | llama.cpp MCP-Protokoll nutzen (bei Cloud-Anbietern automatisch übersprungen) |

### Agent

| Einstellung | Standard | Beschreibung |
|---|---|---|
| `aiAssistant.agentLoop` | `true` | Agenten-Schleife: selbständig weiterarbeiten bis fertig |
| `aiAssistant.maxAgentSteps` | `12` | Maximale Schritte pro Aufgabe |
| `aiAssistant.planningEnabled` | `true` | Planungsfunktion (Todo-Liste) |
| `aiAssistant.autoAnalyze` | `true` | Erst lesen, dann schreiben |
| `aiAssistant.autoApply` | `false` | **Auto-Modus:** Änderungen ohne Rückfrage anwenden |
| `aiAssistant.instructionFiles` | `AGENTS.md`, `CLAUDE.md`, … | Projekt-Anweisungsdateien |

### Tests, Sicherheit, Modell

| Einstellung | Standard | Beschreibung |
|---|---|---|
| `aiAssistant.autoTest` | `false` | Nach Änderungen automatisch Tests ausführen |
| `aiAssistant.autoFixOnError` | `true` | Fehlerausgaben analysieren und korrigieren |
| `aiAssistant.autoFixIterations` | `3` | Max. Korrektur-Durchläufe |
| `aiAssistant.allowShellCommands` | `true` | Shell-Befehle erlauben (via WSL) |
| `aiAssistant.confirmDangerousOps` | `true` | Vor gefährlichen Aktionen warnen |
| `aiAssistant.maxTokens` | `2048` | Max. Token pro Antwort |
| `aiAssistant.temperature` | `0.2` | Kreativität (0 = deterministisch) |
| `aiAssistant.contextWarningThreshold` | `6000` | Kontext-Warnung ab (Token) |
| `aiAssistant.systemPrompt` | (Deutsch) | System-Prompt anpassen |

### Web-Suche

**Es gibt keine kostenlose, unbegrenzte allgemeine Websuche.** Jeder Weg ist entweder ein
Anbieter mit Kontingent oder er kratzt eine HTML-Seite ab und wird ab einem gewissen
Volumen gesperrt. Konkret:

- Die **Bing-Such-API ist seit dem 11.08.2025 abgeschaltet.** Microsoft verweist auf
  *Grounding with Bing Search* in Azure AI Foundry – das ist keine Such-API, sondern ein
  Agenten-Dienst, und teurer als das Alte.
- **Brave** hat im Februar 2026 den kostenlosen Tarif gestrichen (ab 5 $/Monat).
- Ein **eigener SearXNG** hebt die Grenzen nicht auf: SearXNG befragt Google, Bing und
  DuckDuckGo für dich, deren Sperren gelten weiter. Er verlagert das Abkratzen nur.
- **DuckDuckGo** ohne Schlüssel geht – bis die IP gesperrt wird. Beobachtet: nach etwa
  fünf Abfragen in Folge kommt nichts mehr zurück.

Deshalb ist die Voreinstellung kein einzelner Dienst, sondern ein **Bündel unabhängiger
Quellen**, die gleichzeitig gefragt und deren Treffer zusammengeführt werden. Fällt eine
aus, tragen die anderen:

| Quelle | Grenze | Wofür |
|---|---|---|
| **DuckDuckGo** (HTML, sonst Lite) | IP-Sperre nach wenigen Abfragen | allgemeine Suche |
| **Stack Overflow** (offizielle API) | 300 Abfragen/Tag pro IP, ohne Schlüssel | Programmierfragen – meist die beste Quelle |
| **Wikipedia** (MediaWiki-API) | praktisch keine | Begriffe und Verfahren; nur als letzter Ausweg, weil sie bei Code-Fragen rauscht |

DuckDuckGo Lite wird nur gefragt, wenn `/html/` nichts liefert – zwei Abfragen an
denselben Dienst beschleunigen die Sperre.

Mit Schlüssel bleibt es verlässlicher. `aiAssistant.searchProvider` wählt gezielt:

| Anbieter | Was nötig ist |
|---|---|
| **Tavily** (empfohlen) | `aiAssistant.searchApiKey` – liefert Textauszüge statt nur Links, kostenloses Kontingent |
| **Brave Search** | `aiAssistant.searchApiKey` (kostenpflichtig) |
| **Google Programmable Search** | `searchApiKey` + Such-ID (`cx`) in `aiAssistant.searchEndpoint`, 100 Abfragen/Tag frei |
| **SearXNG** (eigene Instanz) | Adresse in `aiAssistant.searchEndpoint`; in `settings.yml` muss `search.formats` auch `json` enthalten, sonst antwortet die Instanz mit HTML statt JSON |

**Unbegrenzt ist nur `web_fetch`**: eine bekannte Adresse direkt abrufen und lesen. Für
Dokumentation ist das der verlässliche Weg – und meist der kürzere, weil eine
Trefferliste aus Titeln und Links eine Frage ohnehin nicht beantwortet. Findet die Suche
nichts, nennt der Assistent jede Ursache einzeln und greift darauf zurück, statt dieselbe
Suche zu wiederholen.

### Cloud-Anbieter statt lokalem Server

Beispiel OpenRouter:

```
aiAssistant.serverUrl = https://openrouter.ai/api
aiAssistant.apiKey    = sk-or-v1-…
aiAssistant.model     = anthropic/claude-sonnet-4.5
```

Bei gesetztem API-Key und nicht-lokaler URL wird das MCP-Protokoll übersprungen und
direkt die OpenAI-kompatible API genutzt.

### Arbeitsmodi

Die Listbox in der Chat-Toolbar schaltet zwischen drei Modi um (auch per
`Strg+Shift+P` → *AI Assistant: Arbeitsmodus wählen*):

| Modus | Verhalten |
|---|---|
| 🔒 **Ask** (Standard) | Jede Dateiänderung und jeder Shell-Befehl wird im Chat bestätigt – mit farbigem Diff und „In Editor öffnen". |
| ⚡ **Auto** | Der Assistent arbeitet ohne Rückfragen durch. Jede Änderung erscheint trotzdem als Diff-Karte im Chat, alles bleibt per `↩ Undo` rücknehmbar. |
| 📋 **Plan** | Der Assistent darf nur lesen und planen. Dateiänderungen und Shell-Befehle sind gesperrt – auch wenn das Modell sie versucht. Gut, um erst den Plan zu sehen und dann zu entscheiden. |

---

## Was während der Arbeit sichtbar ist

- **Der Assistent sagt vor jedem Schritt an, was er tut** – ein Satz in der Ich-Form
  („Der Tokenizer liest nur eine Ziffer. Ich sammle die Ziffern in einer Schleife.").
- **Plan** als Checkliste mit Fortschrittsbalken, live aktualisiert.
- **Jede Aktion** mit eigener Karte: gelesene Dateien, Suchtreffer, Shell-Ausgabe.
- **Jede Änderung** als farbige Diff-Karte mit Pfad und `−x / +y`-Bilanz.
- **Reasoning** als aufklappbarer Block mit Zeilenzahl – startet zugeklappt und bleibt
  so, wie du ihn stellst.
- **Kennzahlen** unter der Eingabe, durchgehend: `↓ 3.1k Tok @ 82/s · ↑ 240 Tok @ 30.4/s`.
  Die Denk-Leiste nennt die Phase: „Eingabe wird ausgewertet… 45 %", dann
  „Antwort wird erzeugt… 240 Tok". Kommt vom llama.cpp-Server; Cloud-Anbieter liefern das nicht.

### Arbeitsprotokoll im Terminal

Zusätzlich schreibt der Assistent alles in ein Terminal namens **AI Assistant**:
Aufgabe, jeder Schritt mit Begründung, jeder Befehl mit `$`-Prompt, jede Ausgabe, jede
Änderung mit Zeilenbilanz – farbig und mitlaufend. Damit lässt sich ein langer
Agenten-Lauf hinterher nachlesen.

Dort wird **nichts ausgeführt**, nur angezeigt (ein Pseudo-Terminal). Abschaltbar über
`aiAssistant.showConsole`.

### Langer Verlauf

Erreicht der Verlauf **89 %** des Modell-Kontexts, fasst der Assistent die älteren
Nachrichten automatisch zusammen und arbeitet weiter – die letzten vier bleiben wörtlich
erhalten. Die Kontextgröße wird beim Server erfragt (`/v1/models` → `meta.n_ctx`).
Schwelle: `aiAssistant.compactThresholdPercent`, abschaltbar über `aiAssistant.autoCompact`.

Der Button **🗑 Verlauf löschen** entfernt alle gespeicherten Sessions aus
`ai-code-assistant.json`. Bereits angewandte Codeänderungen bleiben bestehen.

---

## Verwendung

### Chat-Panel (Hauptinterface)
1. Klicke das **Roboter-Icon** in der Activity Bar
2. Tippe eine Anweisung ins Textfeld
3. Sende mit `Enter` oder `Strg+Enter`

### Beispiel-Anweisungen

```
Erstelle eine REST API mit Express.js und TypeScript
Füge Unit-Tests für alle Funktionen in src/utils.ts hinzu
Analysiere den Code und optimiere die Performance
Erstelle eine Docker-Konfiguration für dieses Projekt
Führe npm test aus und erkläre eventuelle Fehler
```

### Commands (Strg+Shift+P)

| Command | Beschreibung |
|---|---|
| `AI Assistant: Panel öffnen` | Chat-Panel fokussieren |
| `AI Assistant: Verbindung testen` | llama.cpp Server pingen |
| `AI Assistant: Letzte KI-Aktion rückgängig` | Letzte Änderung revertieren |
| `AI Assistant: Alle KI-Aktionen rückgängig` | Alle Änderungen revertieren |
| `AI Assistant: Log anzeigen` | Output-Channel öffnen |

---

## Aktions-Format (für Entwickler)

Die KI kann folgende Aktions-Blöcke in ihrer Antwort ausgeben:

````
```action:create_file
path: src/api/routes.ts
---
<Dateiinhalt>
```

```action:edit_file
path: src/index.ts
---
<Neuer vollständiger Inhalt>
```

```action:delete_file
path: src/old-file.ts
```

```action:shell
npm install express @types/express
```
````

---

## Undo / KI-Aktionen rückgängig machen

Alle KI-Dateioperationen werden automatisch gespeichert:

- **Toolbar im Chat**: `↩ Undo` / `↩↩ Undo All`
- **Command Palette**: `AI Assistant: Letzte KI-Aktion rückgängig machen`
- **Tastenkürzel**: Konfigurierbar über `keybindings.json`

---

## Architektur

```
src/
├── extension.ts      # Aktivierung, Command-Registrierung
├── panelProvider.ts  # WebView Chat-Interface
├── aiEngine.ts       # KI-Verarbeitung, Aktions-Parser
├── mcpClient.ts      # llama.cpp HTTP/MCP Client
├── fileManager.ts    # Dateioperationen (mit Undo-Support)
├── shellRunner.ts    # WSL Shell-Ausführung
├── actionHistory.ts  # Undo/Redo Verlauf
└── logger.ts         # Output-Channel Logging
```

---

## Sicherheit

- Alle Dateioperationen sind auf den **geöffneten Workspace** beschränkt (Path-Traversal-Schutz)
- Shell-Befehle laufen nur in WSL, im **Workspace-Verzeichnis**
- Gefährliche Befehle (`rm -rf`, `curl | bash`, etc.) werden erkannt und müssen bestätigt werden
- `autoApply: false` (Standard): Jede Aktion erfordert Benutzerzustimmung
