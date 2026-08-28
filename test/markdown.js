/**
 * Prüft den Markdown-Renderer des Chat-Panels.
 *
 * Der Renderer lebt als JavaScript im WebView-Skript, das `buildHtml()`
 * erzeugt. Hier wird genau dieses Skript aus dem generierten HTML gezogen und
 * ausgeführt – so wird das getestet, was der Benutzer tatsächlich sieht, und
 * nicht eine Kopie, die auseinanderdriften kann.
 *
 *   PROJECT_DIR=... node test/markdown.js
 */
const path = require('path');
const Module = require('module');

const PROJECT = process.env.PROJECT_DIR || path.resolve(__dirname, '..');
const STUB = path.join(__dirname, 'vscode-stub.js');

const origLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') return require(STUB);
    return origLoad.apply(this, arguments);
};

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

// ── renderMdBasic aus dem erzeugten WebView-Skript holen ────────────────────
const { ChatPanel } = require(path.join(PROJECT, 'out', 'chatPanel.js'));
const html = ChatPanel.prototype.buildHtml.call({ sessionId: '1' },
    { cspSource: 'vscode-resource:', asWebviewUri: (u) => u });

const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html);
if (!script) {
    console.log('  FAIL  Kein WebView-Skript im HTML gefunden');
    process.exit(1);
}

// Das Skript braucht `document` und `acquireVsCodeApi`. Wir wollen nur die
// reinen Funktionen, also stellen wir das Nötigste bereit und ziehen danach
// renderMdBasic und esc heraus.
// Minimales DOM. Jede ID liefert ein brauchbares Element – gibt
// getElementById null zurueck, bricht das Skript beim ersten
// addEventListener ab und wir kommen nie an die Funktionen.
const shim = `
  const acquireVsCodeApi = () => ({ postMessage() {} });
  function makeEl() {
    const el = {
      style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
      type: '', title: '', className: '', checked: false, open: false,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild() {}, removeChild() {}, addEventListener() {},
      removeAttribute() {}, setAttribute() {}, focus() {}, click() {},
      scrollIntoView() {}, querySelector: () => makeEl(),
      querySelectorAll: () => [], getBoundingClientRect: () => ({}),
      scrollHeight: 0, scrollTop: 0
    };
    return el;
  }
  const document = {
    getElementById: () => makeEl(),
    createElement: () => makeEl(),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    addEventListener() {}
  };
  const window = { addEventListener() {} };
  const requestAnimationFrame = (fn) => { /* nicht ausfuehren */ };
`;

let renderMdBasic;
try {
    // Nur die Funktionsdefinitionen laden, keine Nebenwirkungen: der Body wird
    // in eine Funktion gepackt, die renderMdBasic zurückgibt.
    const factory = new Function(`
        ${shim}
        ${script[1]}
        return renderMdBasic;
    `);
    renderMdBasic = factory();
} catch (err) {
    console.log(`  FAIL  Skript nicht ausfuehrbar: ${err.message}`);
    process.exit(1);
}

section('Markdown: Grundformen');
{
    check('Renderer geladen', typeof renderMdBasic === 'function');
    check('leerer Text', renderMdBasic('') === '');

    const p = renderMdBasic('Ein Satz.');
    check('Absatz', p === '<p>Ein Satz.</p>', p);

    const two = renderMdBasic('Zeile eins\nZeile zwei');
    check('zwei Zeilen bleiben ein Absatz',
        two === '<p>Zeile eins<br>Zeile zwei</p>', two);

    const sep = renderMdBasic('Erster Absatz.\n\nZweiter Absatz.');
    check('Leerzeile trennt Absaetze',
        sep === '<p>Erster Absatz.</p><p>Zweiter Absatz.</p>', sep);
}

section('Markdown: Listen');
{
    const ul = renderMdBasic('- eins\n- zwei\n- drei');
    check('Aufzaehlung wird <ul>',
        ul === '<ul><li>eins</li><li>zwei</li><li>drei</li></ul>', ul);

    const star = renderMdBasic('* eins\n* zwei');
    check('Sternchen-Liste', star === '<ul><li>eins</li><li>zwei</li></ul>', star);

    const ol = renderMdBasic('1. eins\n2. zwei');
    check('nummerierte Liste wird <ol>',
        ol === '<ol><li>eins</li><li>zwei</li></ol>', ol);

    const mixed = renderMdBasic('Text davor\n- punkt\nText danach');
    check('Liste zwischen Absaetzen',
        mixed === '<p>Text davor</p><ul><li>punkt</li></ul><p>Text danach</p>', mixed);

    const nested = renderMdBasic('- mit `code` und **fett**');
    check('Formatierung in Listenpunkten',
        nested.includes('<code>code</code>') && nested.includes('<strong>fett</strong>'), nested);
}

section('Markdown: Ueberschriften, Zitate, Linien');
{
    const h = renderMdBasic('## Titel');
    check('## wird Ueberschrift', /<h4 class="md-h">Titel<\/h4>/.test(h), h);

    const h3 = renderMdBasic('# Gross');
    check('# wird kleinere Stufe (passt in den Chat)',
        /<h3 class="md-h">Gross<\/h3>/.test(h3), h3);

    const q = renderMdBasic('> zitiert');
    check('Zitat', q === '<blockquote>zitiert</blockquote>', q);

    const hr = renderMdBasic('---');
    check('waagerechte Linie', hr === '<hr>', hr);
}

section('Markdown: Code');
{
    const fence = renderMdBasic('Text\n```js\nconst a = 1;\n```\nDanach');
    check('Code-Block erkannt', fence.includes('<pre data-lang="js"><code>const a = 1;</code></pre>'), fence);
    check('Text vor dem Block', fence.includes('<p>Text</p>'), fence);
    check('Text nach dem Block', fence.includes('<p>Danach</p>'), fence);

    const noLang = renderMdBasic('```\nnur code\n```');
    check('Block ohne Sprachangabe',
        noLang === '<pre><code>nur code</code></pre>', noLang);

    // Listen und Rauten INNERHALB eines Code-Blocks duerfen nicht als
    // Markdown gelesen werden - sonst zerfaellt jeder Shell-Schnipsel.
    const inside = renderMdBasic('```sh\n# Kommentar\n- kein Listenpunkt\n```');
    check('Markdown im Code-Block bleibt Text',
        inside.includes('# Kommentar') && !inside.includes('<ul>')
        && !inside.includes('md-h'), inside);

    // Unvollstaendiger Block waehrend des Streamings
    const streaming = renderMdBasic('Ich schreibe:\n```ts\nconst x =');
    check('offener Block wird als Code gezeigt',
        streaming.includes('<pre data-lang="ts"><code>const x =</code></pre>'), streaming);
    check('offener Block zerfaellt nicht in Absaetze',
        !streaming.includes('<p>const x'), streaming);

    // Ein leerer Block ist im Chat ein leerer Rahmen - genau das stand im
    // Fenster unter der Antwort. Es entsteht, wenn das Aktionsmarkup aus dem
    // Text geschnitten wird und nur der Zaun uebrig bleibt.
    const leer = renderMdBasic('Erledigt.\n\n```\n```');
    check('leerer Code-Block wird nicht gezeigt', !leer.includes('<pre'), leer);
    check('der Text darueber bleibt', leer.includes('Erledigt.'), leer);

    const nurZaun = renderMdBasic('```js\n\n\n```');
    check('Block nur aus Leerzeilen wird nicht gezeigt', nurZaun === '', nurZaun);

    const offenLeer = renderMdBasic('Ich schreibe:\n```ts\n');
    check('gerade geoeffneter Block bleibt leer',
        !offenLeer.includes('<pre'), offenLeer);

    const inlineCode = renderMdBasic('Nutze `npm test` dafuer.');
    check('Inline-Code', inlineCode.includes('<code>npm test</code>'), inlineCode);
}

section('Markdown: Tabellen');
{
    const t = renderMdBasic('| A | B |\n|---|---|\n| 1 | 2 |');
    check('Tabelle erzeugt', t.startsWith('<table class="md-table">'), t);
    check('Kopfzeile enthalten', t.includes('<td>A</td><td>B</td>'), t);
    check('Datenzeile enthalten', t.includes('<td>1</td><td>2</td>'), t);
    check('Trennzeile nicht sichtbar', !t.includes('---'), t);
    check('genau eine Tabelle', (t.match(/<table/g) || []).length === 1, t);
}

section('Markdown: Sicherheit');
{
    const xss = renderMdBasic('<script>alert(1)</script>');
    check('HTML wird escaped',
        !xss.includes('<script>') && xss.includes('&lt;script&gt;'), xss);

    const imgXss = renderMdBasic('<img src=x onerror=alert(1)>');
    check('Attribut-Einschub escaped', !imgXss.includes('<img'), imgXss);

    const jsLink = renderMdBasic('[klick](javascript:alert(1))');
    check('javascript:-Link wird NICHT verlinkt', !jsLink.includes('<a '), jsLink);

    const okLink = renderMdBasic('[Doku](https://example.com/x)');
    check('http-Link wird verlinkt',
        okLink.includes('<a href="https://example.com/x"') && okLink.includes('>Doku</a>'), okLink);

    const codeXss = renderMdBasic('```\n<script>x</script>\n```');
    check('HTML im Code-Block escaped',
        !codeXss.includes('<script>') && codeXss.includes('&lt;script&gt;'), codeXss);
}

section('Markdown: eine realistische Antwort');
{
    const answer = [
        'Ich habe die Ursachen gefunden:',
        '',
        '1. **Tokenizer** liest nur eine Ziffer (`Number(ch)`).',
        '2. **Parser** ist rechts-assoziativ statt links.',
        '',
        'Vorgehen:',
        '- Ziffern in einer Schleife sammeln',
        '- `parseExpr` auf `parseTerm` umstellen',
        '',
        '```js',
        'while (i < input.length) { }',
        '```',
        '',
        'Danach laufen alle Tests.'
    ].join('\n');

    const r = renderMdBasic(answer);
    check('nummerierte Liste', r.includes('<ol><li>'), r.slice(0, 120));
    check('Aufzaehlung', r.includes('<ul><li>'), r.slice(0, 200));
    check('fett im Listenpunkt', r.includes('<strong>Tokenizer</strong>'), r.slice(0, 200));
    check('Code-Block', r.includes('<pre data-lang="js">'), r.slice(-200));
    check('Schlussabsatz', r.includes('<p>Danach laufen alle Tests.</p>'), r.slice(-120));
    check('keine rohen Bindestriche als Text', !/<p>- /.test(r), r);
    check('keine rohen Ziffernpunkte als Text', !/<p>1\. /.test(r), r);
}

console.log(`\nERGEBNIS: ${pass} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail > 0 ? 1 : 0);
