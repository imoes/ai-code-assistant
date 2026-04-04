# AI Code Assistant – VSCodium Extension

Ein autonomer AI Code Assistant für VSCodium 1.105+, der **llama.cpp** als lokale KI-Engine nutzt (über MCP oder OpenAI-kompatible API).

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

Öffne Einstellungen (`Strg+,`) und suche nach `aiAssistant`:

| Einstellung | Standard | Beschreibung |
|---|---|---|
| `aiAssistant.serverUrl` | `http://localhost:8080` | llama.cpp Server-URL |
| `aiAssistant.mcpEnabled` | `true` | MCP-Protokoll nutzen (Fallback auf OpenAI-API) |
| `aiAssistant.model` | `` | Modellname (leer = Serverstandard) |
| `aiAssistant.maxTokens` | `2048` | Max. Token pro Antwort |
| `aiAssistant.temperature` | `0.2` | Kreativität (0=deterministisch) |
| `aiAssistant.autoApply` | `false` | KI-Änderungen ohne Bestätigung anwenden |
| `aiAssistant.allowShellCommands` | `true` | Shell-Befehle erlauben (via WSL) |
| `aiAssistant.confirmDangerousOps` | `true` | Vor gefährlichen Aktionen warnen |
| `aiAssistant.systemPrompt` | (Deutsch) | System-Prompt anpassen |

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
