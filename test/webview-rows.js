/**
 * Führt das Webview-Skript des Chat-Panels gegen ein nachgebautes DOM aus.
 *
 * Warum das nötig ist: der reine Syntaxtest (`new Function`) sagt nur, dass das
 * Skript parsebar ist. Zwei Fehler, die erst im laufenden Fenster auffielen,
 * hätte er nicht gesehen:
 *
 *   1. Zwei Seitenabrufe in einer Runde – die erste Werkzeugzeile blieb auf
 *      "läuft…" stehen, die fertige Ausgabe bekam eine zweite Zeile mit
 *      derselben Adresse. Grund: die Zuordnung verglich nur die LETZTE Zeile.
 *   2. Der Hinweistext unter dem Eingabefeld stand als "Enter zum Senden 00b7
 *      Shift+Enter fuer Zeilenumbruch" da: eine Escape-Sequenz war beim
 *      Bearbeiten zerbrochen.
 *
 * Das DOM hier ist absichtlich minimal – nur was das Skript anfasst.
 */
const path = require('path');
const Module = require('module');

const PROJECT = process.env.PROJECT_DIR;
const STUB = path.join(__dirname, 'vscode-stub.js');

const origLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') return require(STUB);
    return origLoad.apply(this, arguments);
};

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else {
        fail++; failures.push(`${name}${detail ? ' -> ' + detail : ''}`);
        console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`);
    }
}
function section(t) { console.log(`\n=== ${t} ===`); }

// ── Minimales DOM ───────────────────────────────────────────────────────────

class El {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.dataset = {};
        this.style = {};
        this.parentNode = null;
        this._class = new Set();
        this._text = '';
        this.attributes = {};
        this.classList = {
            add: (...c) => c.forEach(x => this._class.add(x)),
            remove: (...c) => c.forEach(x => this._class.delete(x)),
            toggle: (c, on) => { if (on === undefined) { this._class.has(c) ? this._class.delete(c) : this._class.add(c); } else if (on) { this._class.add(c); } else { this._class.delete(c); } },
            contains: c => this._class.has(c)
        };
    }
    get className() { return [...this._class].join(' '); }
    set className(v) { this._class = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get textContent() {
        if (this.children.length === 0) return this._text;
        return this._text + this.children.map(c => c.textContent).join('');
    }
    set textContent(v) { this._text = String(v == null ? '' : v); this.children = []; }
    get innerHTML() { return this._html || ''; }
    set innerHTML(v) { this._html = String(v); if (v === '') this.children = []; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    removeChild(c) { this.children = this.children.filter(x => x !== c); return c; }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k]; }
    addEventListener() { }
    focus() { }
    scrollIntoView() { }
    /** Nur was das Skript braucht: Klassen-Selektoren und Tagnamen. */
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    querySelectorAll(sel) {
        const out = [];
        const want = String(sel).trim();
        const walk = el => {
            for (const c of el.children) {
                const isClass = want.startsWith('.') && c._class.has(want.slice(1));
                const isTag = !want.startsWith('.') && !want.startsWith('#')
                    && c.tagName === want.toUpperCase();
                if (isClass || isTag) out.push(c);
                walk(c);
            }
        };
        walk(this);
        return out;
    }
    /** Alle Nachfahren als flache Liste – für die Prüfungen unten. */
    flatten() {
        const out = [];
        const walk = el => { for (const c of el.children) { out.push(c); walk(c); } };
        walk(this);
        return out;
    }
}

function makeDom(ids) {
    const store = new Map();
    for (const id of ids) { const el = new El('div'); el.id = id; store.set(id, el); }
    const document = {
        createElement: tag => new El(tag),
        createTextNode: t => { const e = new El('#text'); e.textContent = t; return e; },
        getElementById: id => store.get(id) || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => { },
        body: new El('body')
    };
    return { document, store };
}

// ── Skript aus dem Panel-HTML holen und ausführen ───────────────────────────

function loadWebview() {
    const { ChatPanel } = require(path.join(PROJECT, 'out', 'chatPanel.js'));
    const html = ChatPanel.prototype.buildHtml.call(
        { sessionId: '1' }, { cspSource: 'vscode-resource:', asWebviewUri: u => u });

    const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
        .map(m => m[1]).join('\n');

    // Alle im Skript per getElementById geholten Kennungen bereitstellen –
    // fehlt eine, laeuft das Skript in einen Nullzugriff.
    const ids = [...script.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)]
        .map(m => m[1]);
    const { document, store } = makeDom([...new Set(ids)]);

    const api = { postMessage: () => { }, setState: () => { }, getState: () => null };
    const sandbox = {
        document,
        window: { addEventListener: () => { } },
        acquireVsCodeApi: () => api,
        requestAnimationFrame: fn => fn(),
        setTimeout: (fn) => { try { fn(); } catch { } return 0; },
        clearTimeout: () => { },
        console,
        Map, Set, JSON, String, Number, Math, Array, Object, RegExp, Date, Boolean
    };

    // Das Skript haengt seine Funktionen an den globalen Namensraum; mit
    // `new Function` samt Rueckgabe holen wir uns die, die wir pruefen wollen.
    const factory = new Function(
        ...Object.keys(sandbox),
        script + `
        ;return {
            dispatch: handleHostMessage,
            appendOrUpdateProgress,
            finalizeProgress,
            appendNarration,
            makeActionsPanel,
            cutActionMarkup,
            setThinking,
            progressKey,
            renderMdBasic
        };`
    );

    let exported;
    try {
        exported = factory(...Object.values(sandbox));
    } catch (err) {
        return { error: err };
    }
    return { api: exported, store, script };
}

// ── Prüfungen ───────────────────────────────────────────────────────────────

section('Webview: Skript laeuft gegen ein DOM');

const loaded = loadWebview();
if (loaded.error) {
    check('Skript laeuft ohne Fehler durch', false, loaded.error.message);
    report();
} else {
    check('Skript laeuft ohne Fehler durch', true);

    const { api, store, script } = loaded;
    const chat = store.get('chat');
    check('Chat-Container gefunden', !!chat);

    const toolRows = () => chat.flatten().filter(e => e._class.has('tool-row'));

    // ── Zwei Abrufe in einer Runde, verschraenkt gemeldet ────────────────────
    // Genau die Reihenfolge aus dem Fenster-Lauf: beide starten, dann kommen
    // die Ergebnisse. Vorher blieb die erste Zeile auf "laeuft..." stehen.
    section('Werkzeugzeilen: verschraenkte Abrufe');

    const A = 'https://nodejs.org/api/test.html';
    const B = 'https://nodejs.org/api/assert.html';

    api.appendOrUpdateProgress(`Fetch: ${A}`, '', { tool: 'Fetch', target: A, running: true });
    api.appendOrUpdateProgress(`Fetch: ${B}`, '', { tool: 'Fetch', target: B, running: true });
    check('zwei laufende Abrufe = zwei Zeilen', toolRows().length === 2,
        String(toolRows().length));

    api.appendOrUpdateProgress(`Fetch: ${A}`, 'Test runner ...', {
        tool: 'Fetch', target: A, detail: '20033 Zeichen', ok: true });
    api.appendOrUpdateProgress(`Fetch: ${B}`, 'Assert ...', {
        tool: 'Fetch', target: B, detail: '20032 Zeichen', ok: true });

    const rows = toolRows();
    check('nach den Ergebnissen immer noch zwei Zeilen', rows.length === 2,
        rows.map(r => r.textContent.slice(0, 60)).join(' || '));

    const detailOf = r => (r.querySelector('.tool-detail') || {}).textContent;
    check('erste Zeile zeigt ihr Ergebnis, nicht "laeuft"',
        detailOf(rows[0]) === '20033 Zeichen', String(detailOf(rows[0])));
    check('zweite Zeile zeigt ihr Ergebnis',
        detailOf(rows[1]) === '20032 Zeichen', String(detailOf(rows[1])));
    check('keine Zeile bleibt auf "laeuft" stehen',
        rows.every(r => detailOf(r) !== 'läuft…'),
        rows.map(detailOf).join(' | '));
    check('Ausgabe steht in der Zeile',
        rows[0].querySelector('.tool-output') !== null);

    // ── Nach dem Abschnitt ist derselbe Befehl ein NEUER Vorgang ────────────
    section('Werkzeugzeilen: zweiter Lauf desselben Befehls');

    api.finalizeProgress();
    api.appendOrUpdateProgress('Shell: npm test', '2 rot', { tool: 'Bash', target: 'npm test', ok: false });
    const afterFirst = toolRows().length;
    api.finalizeProgress();
    api.appendOrUpdateProgress('Shell: npm test', '11 gruen', { tool: 'Bash', target: 'npm test', ok: true });
    check('zweiter Testlauf bekommt eine eigene Zeile',
        toolRows().length === afterFirst + 1,
        afterFirst + ' -> ' + toolRows().length);

    // ── Hinweistext ────────────────────────────────────────────────────────
    section('Hinweistext unter dem Eingabefeld');

    api.setThinking(true);
    const busyHint = store.get('hint').textContent;
    check('waehrend eines Laufs: Enter unterbricht',
        /Enter unterbricht die laufende Aufgabe/.test(busyHint), busyHint);

    api.setThinking(false);
    const idleHint = store.get('hint').textContent;
    check('im Ruhezustand: Enter zum Senden',
        /^Enter zum Senden/.test(idleHint), idleHint);
    check('Trennzeichen ist ein Mittelpunkt, keine rohe Escape-Ziffer',
        idleHint.includes('·') && !/00b7/.test(idleHint), idleHint);
    check('Umlaut im Hinweis ist echt',
        idleHint.includes('für'), idleHint);

    // Keine rohen Escape-Reste im ganzen Skript: dieselbe Panne kann jede
    // andere Zeichenkette treffen.
    check('keine rohen Escape-Reste im Skript',
        !/["'][^"']*\b00[0-9a-f]{2}\b[^"']*["']/.test(script),
        (script.match(/["'][^"']*\b00[0-9a-f]{2}\b[^"']*["']/) || [''])[0]);

    // ── Der gestreamte Absatz darf kein Aktionsmarkup zeigen ────────────────
    // Im Fenster stand ">>>REPLACE" samt Quellcode im Chat: der Chat rendert
    // waehrend des Streamens die ROHE Antwort, und dort stehen die Bloecke drin.
    section('Antworttext: Stream und Nachlieferung');

    const msgs = () => chat.flatten().filter(e => e._class.has('msg-assistant'));

    check('Schnitt ab der Aktions-Kopfzeile',
        api.cutActionMarkup('Ich erweitere den Tokenizer.\n```action:patch_file\npath: a.js')
            .trim() === 'Ich erweitere den Tokenizer.',
        JSON.stringify(api.cutActionMarkup('Ich erweitere den Tokenizer.\n```action:patch_file\npath: a.js')));
    check('Schnitt auch ohne Zaun',
        api.cutActionMarkup('Fertig.\naction:done\nzusammenfassung: x').trim() === 'Fertig.',
        JSON.stringify(api.cutActionMarkup('Fertig.\naction:done\nzusammenfassung: x')));
    check('normaler Text bleibt ganz',
        api.cutActionMarkup('Nur Text mit ```js\ncode\n``` drin.').includes('code'));

    // Kompletter Rundenverlauf: streamen, dann bereinigten Text nachliefern
    const vorher = msgs().length;
    api.dispatch({ type: 'assistantMessageStart' });
    api.dispatch({ type: 'assistantToken', text: 'Ich erweitere den Tokenizer.\n\n```action:patch_file\n' });
    api.dispatch({ type: 'assistantToken', text: 'path: src/tokenizer.js\n---\n<<<SEARCH\nalt\n>>>REPLACE\nneu\n```' });

    const gestreamt = msgs()[msgs().length - 1];
    check('waehrend des Streams kein Aktionsmarkup sichtbar',
        !gestreamt.innerHTML.includes('REPLACE') && !gestreamt.innerHTML.includes('action:'),
        gestreamt.innerHTML.slice(0, 160));
    check('die Ansage ist sichtbar',
        gestreamt.innerHTML.includes('Ich erweitere den Tokenizer'), gestreamt.innerHTML.slice(0, 120));

    api.dispatch({ type: 'assistantMessageEnd' });
    api.dispatch({ type: 'narration', text: 'Ich erweitere den Tokenizer um Bezeichner.' });

    check('kein zweiter Absatz durch die Nachlieferung',
        msgs().length === vorher + 1, `${vorher} -> ${msgs().length}`);
    check('nachgelieferter Text ersetzt den gestreamten',
        msgs()[msgs().length - 1].innerHTML.includes('um Bezeichner'),
        msgs()[msgs().length - 1].innerHTML.slice(0, 120));

    // Runde ganz ohne Prosa: der leere Absatz muss verschwinden
    const vorLeer = msgs().length;
    api.dispatch({ type: 'assistantMessageStart' });
    api.dispatch({ type: 'assistantToken', text: '```action:read_file\npath: a.ts\n```' });
    api.dispatch({ type: 'assistantMessageEnd' });
    api.dispatch({ type: 'narration', text: '' });
    check('Runde nur mit Werkzeugaufruf laesst keinen leeren Absatz',
        msgs().length === vorLeer, `${vorLeer} -> ${msgs().length}`);

    // Abschluss-Zusammenfassung kommt als Markdown-Nachricht, nicht als
    // Monospace-Werkzeugausgabe. Im Fenster stand sie in einer Ausgabe-Box mit
    // vier sichtbaren Zeilen - Aufzaehlungen darin waren nur Rohtext.
    const vorAbschluss = msgs().length;
    api.dispatch({ type: 'narration', text: 'Fertig:\n\n- Tokenizer erweitert\n- 14 Tests gruen' });
    check('Abschluss erscheint als eigener Absatz',
        msgs().length === vorAbschluss + 1, `${vorAbschluss} -> ${msgs().length}`);
    check('Abschluss ist als Liste gesetzt, nicht als Rohtext',
        /<ul>/.test(msgs()[msgs().length - 1].innerHTML),
        msgs()[msgs().length - 1].innerHTML.slice(0, 200));

    // ── Fusszeile: Bilanz statt zweiter Kopie des Laufs ─────────────────────
    section('Fusszeile: Bilanz statt Wiederholung');
    {
        const panel = api.makeActionsPanel([
            { description: 'Gepacht: src/tokenizer.js', success: true, output: 'viel Text' },
            { description: 'Shell: npm test', success: true, output: 'TAP version 13\nok 1\nok 2' },
            { description: 'Patch fehlgeschlagen: src/parser.js', success: false, output: 'nope' }
        ], 'Ausgeführte Aktionen (5 Schritte)');

        const text = panel.textContent;
        check('Bilanz nennt Erfolge und Fehlschlaege',
            /2 erfolgreich/.test(text) && /1 fehlgeschlagen/.test(text), text);
        check('Fehlschlag wird benannt', /src\/parser\.js/.test(text), text);
        check('Erfolge werden NICHT wiederholt',
            !/tokenizer\.js/.test(text) && !/npm test/.test(text), text);
        check('keine Ausgaben in der Fusszeile',
            !/TAP version/.test(text) && !/viel Text/.test(text), text);
    }

    report();
}

function report() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`ERGEBNIS: ${pass} bestanden, ${fail} fehlgeschlagen`);
    if (fail > 0) {
        console.log('\nFehlgeschlagen:');
        failures.forEach(f => console.log('  - ' + f));
    }
    console.log('='.repeat(60));
    process.exitCode = fail > 0 ? 1 : 0;
}
