# Changelog

Alle nennenswerten Änderungen an diesem Projekt. Neueste Version oben.

## 0.8.0

- **Antworten werden als Markdown dargestellt:** Aufzählungen, nummerierte Listen,
  Überschriften, Zitate, Tabellen, Links und Code-Blöcke mit Sprachangabe. Vorher standen
  Listen als nackte Bindestriche im Text.
- **Jede Aktion ist eine kompakte Zeile** – Punkt, Werkzeugname, Ziel – wie in einem
  Terminal. Die Ausgabe zeigt vier Zeilen, der Rest steckt hinter „+N weitere Zeilen".
- **Neues Werkzeug „Seite abrufen" (`web_fetch`):** holt eine Webseite und gibt ihren Text
  an den Assistenten. Eine Suchtrefferliste besteht nur aus Titeln und Adressen – damit
  lässt sich keine Frage beantworten. Erst der Seiteninhalt hilft.
- **Web-Suche über mehrere Anbieter:** Tavily, Brave, Google oder eine eigene
  SearXNG-Instanz (jeweils mit Schlüssel bzw. Adresse), DuckDuckGo als letzter Ausweg.
  Ohne Schlüssel bleibt nur DuckDuckGo, und das drosselt stark – liefert die Suche nichts,
  sagt der Assistent das jetzt deutlich und greift zu `web_fetch`, statt dieselbe Suche
  zu wiederholen.
- **Suchtreffer enthalten wieder Textauszüge.** Die Auswertung der DuckDuckGo-Seite hatte
  nur Titel und Links geliefert, weil mehrere verschachtelte Elemente denselben
  Klassen-Präfix tragen.
- **Seitenabruf folgt Weiterleitungen.** Fast jede Dokumentationsseite antwortet mit
  301 oder 302; vorher kam ein leerer Rumpf zurück.
- Der Modus in der Seitenleiste zeigt alle drei Modi statt „Automatisch / Manuell".
- `npm test` führt die komplette Testsuite aus (381 Prüfungen), die CI-Pipeline ebenfalls.

## 0.7.3

- **Kein endloses Warten mehr, wenn der Server verstummt.** Die Streaming-Anfrage hatte
  gar kein Zeitlimit: brach die Verbindung mitten in der Antwort ab (VPN weg, Server
  überlastet), wartete der Assistent unbegrenzt – ohne Meldung, ohne Ausweg außer
  „Abbrechen". Jetzt bricht er nach 180 Sekunden Stille ab und sagt, was los ist.
  Gemessen wird die Pause zwischen zwei Antwortteilen, nicht die Gesamtdauer – eine
  lange Antwort bleibt also erlaubt. Einstellbar über `aiAssistant.streamIdleTimeoutSeconds`.

## 0.7.1

- **Shell-Befehle laufen jetzt auch unter Linux und macOS.** `wsl` war fest verdrahtet,
  dadurch scheiterte dort jeder Befehl – auch `echo test`. Unter Windows läuft weiterhin
  alles über WSL. Ohne funktionierende Shell kann der Assistent seine Änderungen nicht
  testen und findet eigene Fehler nicht.

## 0.7.0

- **Der Assistent sagt bei jedem Schritt an, was er tut** – nicht nur beim ersten.
  Jedes Werkzeug hat dafür ein Feld `absicht`, das das Modell mit dem Aufruf füllt.
  Vorher hing die Ansage an der Prosa des Modells, und die bleibt bei
  Werkzeugaufrufen meist leer (`content: null`) – man sah nur eine Liste von Aktionen.
- **Die Denk-Leiste sagt, was gerade passiert:** „Eingabe wird ausgewertet… 45 %"
  während der Prompt-Auswertung, danach „Antwort wird erzeugt… 240 Tok".
  Bei großen Kontexten dauert allein die Eingabe Minuten – vorher stand da nur „KI denkt…".
- **Serialisierungs-Reste landen nicht mehr im Quellcode.** Ein Modell hatte eine Zeile
  `</arg_value>` mitten in eine Datei geschrieben und sie damit unbrauchbar gemacht.
  Solche Zeilen werden vor dem Schreiben entfernt und im Protokoll gemeldet.

## 0.6.1

- **Arbeitsprotokoll im Terminal** „AI Assistant": jeder Schritt mit Begründung, jeder
  Befehl mit `$`-Prompt, jede Ausgabe, jede Änderung mit Zeilenbilanz – farbig und
  mitlaufend. Vorher war nicht nachvollziehbar, was der Assistent zwischen den Schritten tut.
  (Es wird dort nichts ausgeführt, nur angezeigt.)
- **Der Assistent sagt an, was er tut**, bevor er es tut – ein Satz in der Ich-Form vor
  jedem Werkzeugaufruf, und höchstens drei Aktionen pro Runde.
- **Keine Endlosschleifen mehr.** Scheiterte eine Änderung, erfuhr der Assistent das nicht
  und wiederholte sie – in einem Testlauf 18-mal denselben Patch. Jetzt gilt:
  fehlgeschlagene Änderungen werden mit Begründung zurückgemeldet, nur erfolgreiche
  zählen als getane Arbeit, und dieselbe Runde dreimal in Folge beendet die Schleife.
- **Verständliche Patch-Fehler:** der Assistent erfährt jetzt, ob die Änderung schon
  vorhanden ist, ob nur die erste Zeile passt (mit Zeilennummern) oder ob die Datei
  anders aussieht als angenommen – statt nur „Suchtext nicht gefunden".
- Die Token-Statistik bleibt während der ganzen Aufgabe stehen (saß vorher in der
  Denk-Leiste und verschwand bei jedem Schritt).
- Der Reasoning-Block startet zugeklappt und bleibt so, wie man ihn stellt – vorher
  klappte er beim Fertigwerden automatisch wieder zu.

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
