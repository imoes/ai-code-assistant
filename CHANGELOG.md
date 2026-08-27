# Changelog

Alle nennenswerten Änderungen an diesem Projekt. Neueste Version oben.

## 0.5.0

- **Drei Arbeitsmodi** als Listbox in der Chat-Toolbar: **Ask** (jede Änderung wird
  bestätigt), **Auto** (arbeitet ohne Rückfragen durch) und **Plan** (darf nur lesen und
  planen – Dateiänderungen und Shell-Befehle sind gesperrt, auch wenn das Modell es versucht).
- **Diffs auch im Auto-Modus:** jede angewandte Änderung erscheint im Chat als farbige
  Diff-Karte mit Pfad und Zeilenbilanz. Vorher sah man im Auto-Modus überhaupt nicht,
  was geändert wurde.
- **Live-Kennzahlen** in der Denk-Leiste: Fortschritt der Eingabe-Auswertung in Prozent
  sowie Tokens und Tokens/Sekunde für Ein- und Ausgabe. Bei großen Kontexten weiß man
  jetzt, ob etwas passiert.
- **Verlauf wird automatisch zusammengefasst**, wenn er 89 % des Modell-Kontexts erreicht
  (Schwelle einstellbar). Die Kontextgröße wird beim Server erfragt statt geraten.
  Lange Agenten-Läufe brechen dadurch nicht mehr ab.
- **Verlauf löschen**-Button in der Chat-Toolbar.
- Jede Aktion bekommt im Chat ihre eigene Fortschritts-Karte. Vorher überschrieben sich
  alle Meldungen gegenseitig, sodass Test- und Suchausgaben unsichtbar blieben.
- Änderungen mit `patch_file` sind zuverlässig: Abschluss-Marker der Modelle (`>>>`,
  `>>>>>>> REPLACE`, `=======`) landen nicht mehr im Quellcode. Die git-Konflikt-Schreibweise
  wird zusätzlich akzeptiert.

## 0.3.0

- Der Assistent funktioniert jetzt mit **allen** gängigen Modellen – Qwen, Gemma, Kimi,
  laguna, DeepSeek, Mistral, Llama. Die Werkzeuge werden im OpenAI-Schema an den Server
  gesendet, der das modellspezifische Format selbst erzeugt und zurückübersetzt.
  Vorher blieb der Assistent bei Modellen mit eigenem Tool-Format stumm: er beschrieb,
  was er tun würde, führte aber nichts aus.
- Für Server ohne Werkzeug-Unterstützung gibt es einen Rückfall, der die Aufrufe aus dem
  Antworttext liest – auch dort werden alle verbreiteten Formate erkannt.
- Neue Einstellung **Werkzeuge über die Server-API** (an by default; bei llama.cpp ist
  dafür `--jinja` nötig).
- Werkzeugnamen anderer Assistenten (`write_file`, `bash`, `str_replace_editor`, …) werden
  akzeptiert – ein Modell, das auf ein anderes Harness trainiert wurde, funktioniert hier trotzdem.

## 0.2.2

- Der Chat funktioniert wieder: ein Fehler im Panel-Skript hatte die gesamte
  Chat-Oberfläche lahmgelegt (kein Verlauf, kein Modus-Badge, keine Reaktion auf Eingaben).
- Beim Öffnen einer Chat-Session liegt der Tastaturfokus jetzt im Eingabefeld – man kann
  sofort tippen, auch wenn der Chat über die Befehlspalette geöffnet wurde.

## 0.2.1

- Beim Analysieren angezeigte Dateipfade sind jetzt kurz und projektrelativ statt absolut.

## 0.2.0

- Der Assistent analysiert den bestehenden Code jetzt selbst: er durchsucht das Projekt
  per Regex, findet Dateien nach Muster und liest sie abschnittsweise – bevor er etwas ändert.
- Mehrschrittige Aufgaben werden als Plan angelegt und Schritt für Schritt abgearbeitet;
  der Fortschritt erscheint im Chat als Checkliste.
- Der Assistent arbeitet selbständig weiter, bis die Aufgabe erledigt ist: analysieren →
  planen → ändern → testen → korrigieren. Schrittzahl über `aiAssistant.maxAgentSteps` begrenzbar.
- Eigenes Einstellungs-Panel mit **Speichern**-Button (⚙ in der Chat-Toolbar oder
  `Strg+S` im Panel), inklusive Verbindungstest und ausblendbarem API-Key-Feld.
- Cloud-Anbieter nutzbar: optionaler API-Key (`aiAssistant.apiKey`) für OpenRouter,
  OpenAI, Groq und Together – statt eines lokalen llama.cpp-Servers.
- Der Auto-Modus lässt sich per Klick auf den Modus-Badge in der Chat-Toolbar umschalten.
- Projektregeln aus `AGENTS.md`, `CLAUDE.md`, `command.md` und
  `.github/copilot-instructions.md` werden bei jeder Anfrage berücksichtigt.

## 0.1.0

- Erste Version: Chat-Panel als Editor-Tab, Dateien erstellen/bearbeiten/löschen mit
  Diff-Bestätigung, Shell-Befehle über WSL, Undo für alle KI-Aktionen, Web-Suche,
  automatische Fehlerkorrektur anhand von Shell-Ausgaben.
