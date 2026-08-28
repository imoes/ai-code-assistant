/**
 * Prüft Web-Suche und Seitenabruf gegen einen lokalen Testserver.
 *
 * Bewusst ohne echtes Internet: die öffentlichen Suchdienste drosseln, ein
 * Test der davon abhängt schlägt zufällig fehl und sagt nichts über den Code.
 * Hier wird stattdessen jede Antwortform nachgestellt – auch die, die im
 * Echtbetrieb Probleme gemacht hat.
 *
 *   PROJECT_DIR=... node test/websearch.js
 */
const path = require('path');
const http = require('http');
const Module = require('module');

const PROJECT = process.env.PROJECT_DIR || path.resolve(__dirname, '..');
const STUB = path.join(__dirname, 'vscode-stub.js');

const origLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') return require(STUB);
    return origLoad.apply(this, arguments);
};

const vscode = require(STUB);

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

// ── Testserver: stellt die Antwortformen der Anbieter nach ──────────────────
let lastRequest = null;

const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
        lastRequest = { url: req.url, method: req.method, headers: req.headers, body };
        const send = (code, type, payload) => {
            res.writeHead(code, { 'Content-Type': type });
            res.end(payload);
        };

        // Tavily
        if (req.url.startsWith('/tavily')) {
            return send(200, 'application/json', JSON.stringify({
                answer: 'Decorators sind Funktionen, die Klassen annotieren.',
                results: [
                    { title: 'Handbook', url: 'https://ts.example/dec', content: '  Ein  langer\n Auszug  ' },
                    { title: 'Ohne URL', content: 'egal' }
                ]
            }));
        }

        // Brave
        if (req.url.startsWith('/brave')) {
            return send(200, 'application/json', JSON.stringify({
                web: { results: [
                    { title: 'Brave-Treffer', url: 'https://b.example/1',
                      description: 'Text mit <b>Markierung</b> drin' }
                ] }
            }));
        }

        // SearXNG
        if (req.url.startsWith('/search?')) {
            return send(200, 'application/json', JSON.stringify({
                answers: ['Direkte Antwort'],
                results: [{ title: 'SX', url: 'https://sx.example/a', content: 'Auszug' }]
            }));
        }

        // Anbieter, der drosselt
        if (req.url.startsWith('/limited')) return send(429, 'text/plain', 'Too Many Requests');

        // SearXNG-Instanz mit Standardeinstellung: JSON ist NICHT freigegeben,
        // die Instanz antwortet mit ihrer HTML-Seite und Status 200.
        if (req.url.startsWith('/htmlonly')) {
            return send(200, 'text/html', '<!doctype html><html><body>SearXNG</body></html>');
        }

        // Seite mit Weiterleitung
        if (req.url === '/redirect') {
            res.writeHead(302, { Location: '/page' });
            return res.end();
        }

        // Seite mit Navigation, Skripten und Inhalt
        if (req.url === '/page') {
            return send(200, 'text/html', `<!DOCTYPE html>
<html><head><title>Titel &amp; mehr</title>
<style>body{color:red}</style>
<script>var x = 1 < 2;</script>
</head><body>
<nav><ul><li><a href="/a">Start</a></li><li><a href="/b">Hilfe</a></li></ul></nav>
<h1>Überschrift</h1>
<p>Erster Absatz mit &quot;Anführungszeichen&quot;.</p>
<ul><li>Punkt eins</li><li>Punkt zwei</li></ul>
<p>Zweiter Absatz.</p>
<footer>Impressum</footer>
</body></html>`);
        }

        send(404, 'text/plain', 'nicht gefunden');
    });
});

function listen() {
    return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

(async () => {
    const { WebSearcher } = require(path.join(PROJECT, 'out', 'webSearch.js'));
    const ws = WebSearcher.getInstance();
    const port = await listen();
    const base = `http://127.0.0.1:${port}`;

    section('Suche: Anbieter mit Schluessel');
    {
        // Tavily: der Endpunkt ist fest verdrahtet, daher pruefen wir hier die
        // Aufbereitung ueber SearXNG (gleiche Struktur) und Brave separat.
        vscode.__settings.searchProvider = 'searxng';
        vscode.__settings.searchEndpoint = base;
        vscode.__settings.searchApiKey = '';

        const r = await ws.search('test', 5);
        check('SearXNG liefert Treffer', r.results.length === 1, JSON.stringify(r));
        check('Titel uebernommen', r.results[0].title === 'SX', r.results[0].title);
        check('Auszug uebernommen', r.results[0].snippet === 'Auszug', r.results[0].snippet);
        check('direkte Antwort uebernommen', r.answer === 'Direkte Antwort', r.answer);
        check('Accept-Header gesetzt',
            lastRequest.headers.accept === 'application/json', lastRequest.headers.accept);
    }

    section('Suche: Fehler werden benannt');
    {
        vscode.__settings.searchProvider = 'searxng';
        vscode.__settings.searchEndpoint = base + '/limited';

        const r = await ws.search('test', 5);
        check('keine Treffer', r.results.length === 0);
        check('Grund wird mitgeliefert',
            Array.isArray(r.problems) && r.problems.length === 1, JSON.stringify(r.problems));
        check('Grund nennt den Statuscode',
            /429/.test(String(r.problems)), String(r.problems));

        // Die Meldung an die KI muss handlungsleitend sein, sonst wiederholt
        // das Modell dieselbe Suche endlos.
        const forAI = ws.formatForAI(r);
        check('Meldung sagt: nicht wiederholen', /Wiederhole sie NICHT/.test(forAI), forAI.slice(0, 120));
        check('Meldung nennt web_fetch als Ausweg', /web_fetch/.test(forAI), forAI.slice(0, 200));
        check('Meldung nennt den Grund', /429/.test(forAI), forAI.slice(0, 200));

        // Unbekannter Anbieter darf nicht durchrutschen
        vscode.__settings.searchProvider = 'gibtsnicht';
        const bad = await ws.search('test', 5);
        check('unbekannter Anbieter meldet sich',
            /unbekannter Anbieter/.test(String(bad.problems)), String(bad.problems));
    }

    section('Seitenabruf: Text statt HTML');
    {
        const p = await ws.fetchPage(base + '/page');
        check('Titel gelesen', p.title === 'Titel & mehr', p.title);
        check('Inhalt vorhanden', p.text.includes('Erster Absatz'), p.text.slice(0, 100));
        check('Ueberschrift markiert', p.text.includes('## Überschrift'), p.text.slice(0, 120));
        check('Listenpunkte erhalten',
            p.text.includes('- Punkt eins') && p.text.includes('- Punkt zwei'), p.text);
        check('Entities aufgeloest', p.text.includes('"Anführungszeichen"'), p.text);

        check('Skript entfernt', !p.text.includes('var x'), p.text);
        check('Stil entfernt', !p.text.includes('color:red'), p.text);
        check('Navigation entfernt', !p.text.includes('Hilfe'), p.text);
        check('Fusszeile entfernt', !p.text.includes('Impressum'), p.text);
        check('keine nackten Listenstriche',
            !/^-$/m.test(p.text), JSON.stringify(p.text.slice(0, 80)));
        check('keine Tags uebrig', !/<[a-z]/i.test(p.text), p.text.slice(0, 120));
    }

    section('Seitenabruf: Weiterleitung und Fehler');
    {
        // Fast jede Doku-Seite antwortet mit 301/302. Ohne Verfolgung kam
        // vorher ein leerer Rumpf zurueck und web_fetch war nutzlos.
        const p = await ws.fetchPage(base + '/redirect');
        check('Weiterleitung gefolgt', p.text.includes('Erster Absatz'), p.text.slice(0, 80));

        let err = null;
        try { await ws.fetchPage(base + '/gibtsnicht'); } catch (e) { err = e; }
        check('404 wird zum Fehler', err !== null && /404/.test(err.message), err && err.message);

        let protoErr = null;
        try { await ws.fetchPage('file:///etc/passwd'); } catch (e) { protoErr = e; }
        check('nur http(s) erlaubt',
            protoErr !== null && /http/.test(protoErr.message), protoErr && protoErr.message);

        const clipped = await ws.fetchPage(base + '/page', 40);
        check('maxChars wird eingehalten', clipped.text.length < 120, String(clipped.text.length));
        check('Kuerzung wird gemeldet', /gekürzt/.test(clipped.text), clipped.text.slice(-60));
    }

    section('DuckDuckGo-HTML: Titel und Auszug paaren');
    {
        // Genau die Struktur, an der der alte Parser scheiterte: mehrere
        // Elemente, deren Klassen alle mit "result" beginnen.
        const html = `
<div class="result results_links web-result">
  <a class="result__a" href="https://a.example/1">Erster Treffer</a>
  <a class="result__snippet" href="https://a.example/1">Auszug <b>eins</b></a>
  <div class="result__extras"><div class="result__extras__url">a.example</div></div>
</div>
<div class="result results_links web-result">
  <a class="result__a" href="https://b.example/2">Zweiter Treffer</a>
  <div class="result__extras"><div class="result__extras__url">b.example</div></div>
</div>
<div class="result results_links web-result">
  <a class="result__a" href="https://c.example/3">Dritter Treffer</a>
  <a class="result__snippet" href="https://c.example/3">Auszug drei</a>
</div>`;

        const hits = ws.parseDuckDuckGoHtml(html, 10);
        check('alle drei Treffer', hits.length === 3, JSON.stringify(hits.map(h => h.title)));
        check('erster Auszug richtig zugeordnet',
            hits[0].snippet === 'Auszug eins', hits[0].snippet);
        check('Treffer ohne Auszug bleibt leer',
            hits[1].snippet === '', JSON.stringify(hits[1]));
        check('dritter Auszug NICHT beim zweiten',
            hits[2].snippet === 'Auszug drei', hits[2].snippet);
        check('Adressen richtig', hits[2].url === 'https://c.example/3', hits[2].url);

        const limited = ws.parseDuckDuckGoHtml(html, 2);
        check('maxResults wird beachtet', limited.length === 2, String(limited.length));
    }

    // ── Schluessellose Quellen ───────────────────────────────────────────────
    // Es gibt keine kostenlose, unbegrenzte allgemeine Websuche. Statt EINER
    // schluessellosen Quelle werden mehrere unabhaengige gleichzeitig gefragt:
    // faellt eine aus, tragen die anderen.

    section('DuckDuckGo Lite: eigene Auszeichnung');
    {
        // Die Lite-Seite nutzt einfache Anfuehrungszeichen und eine
        // Tabellenstruktur - nicht dieselbe Auszeichnung wie /html/.
        const lite = `
<tr><td><a rel="nofollow" href="https://nodejs.org/api/test.html" class='result-link'>Test runner | Node.js</a></td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>Starting <b>Node</b>.js with --<b>test</b>-name-pattern.</td></tr>
<tr><td><a rel="nofollow" href="https://example.org/zwei" class='result-link'>Zweiter Treffer</a></td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>Auszug zwei</td></tr>`;

        const hits = ws.parseDuckDuckGoLiteHtml(lite, 10);
        check('beide Treffer gelesen', hits.length === 2, JSON.stringify(hits.map(h => h.title)));
        check('Titel entkommen', hits[0].title === 'Test runner | Node.js', hits[0].title);
        check('Adresse gelesen', hits[0].url === 'https://nodejs.org/api/test.html', hits[0].url);
        check('Auszug ohne Tags',
            hits[0].snippet === 'Starting Node.js with --test-name-pattern.', hits[0].snippet);
        check('zweiter Auszug richtig zugeordnet', hits[1].snippet === 'Auszug zwei', hits[1].snippet);
        check('maxResults wird beachtet', ws.parseDuckDuckGoLiteHtml(lite, 1).length === 1);
    }

    section('Stack Exchange: offizielle API ohne Schluessel');
    {
        const data = {
            items: [
                {
                    title: 'How to mark a test as &quot;todo&quot;?',
                    link: 'https://stackoverflow.com/questions/1',
                    score: 42, answer_count: 3, is_answered: true,
                    tags: ['node.js', 'testing']
                },
                { title: 'Ohne Link', score: 1 }
            ]
        };
        const hits = ws.mapStackExchange(data, 5);
        check('nur Treffer mit Adresse', hits.length === 1, JSON.stringify(hits));
        check('Entities im Titel aufgeloest',
            hits[0].title.includes('"todo"'), hits[0].title);
        check('Punktestand im Auszug', /42 Punkte/.test(hits[0].snippet), hits[0].snippet);
        check('Antwortzahl im Auszug', /3 Antwort/.test(hits[0].snippet), hits[0].snippet);
        check('akzeptierte Antwort vermerkt', /akzeptiert/.test(hits[0].snippet), hits[0].snippet);
        check('Schlagworte im Auszug', /node\.js, testing/.test(hits[0].snippet), hits[0].snippet);

        // Drosselung meldet sich als Fehler, nicht als leeres Ergebnis
        let err = null;
        try { ws.mapStackExchange({ error_message: 'throttle violation' }, 5); }
        catch (e) { err = e; }
        check('Drosselung wird zum Fehler',
            err !== null && /throttle/.test(err.message), err && err.message);
    }

    section('Keyless: mehrere Quellen zusammenfuehren');
    {
        // Die Netzaufrufe werden ersetzt: geprueft wird das Zusammenfuehren.
        const orig = {
            html: ws.searchHtml, lite: ws.searchDuckDuckGoLite,
            se: ws.searchStackExchange, wiki: ws.searchWikipedia
        };

        let calls = [];
        ws.searchHtml = async (q) => {
            calls.push('html');
            return { query: q, results: [
                { title: 'DDG eins', url: 'https://a.example/1', snippet: 'a1' },
                { title: 'Gemeinsam', url: 'https://gleich.example/x?utm=1', snippet: 'von DDG' }
            ] };
        };
        ws.searchDuckDuckGoLite = async (q) => {
            calls.push('lite');
            return { query: q, results: [
                { title: 'Lite eins', url: 'https://b.example/2', snippet: 'b2' }
            ] };
        };
        ws.searchStackExchange = async (q) => {
            calls.push('se');
            // Dieselbe Seite, andere Adresse (Anker/Parameter) - nicht doppelt
            return { query: q, results: [
                { title: 'Gemeinsam', url: 'https://gleich.example/x#abschnitt', snippet: 'von SO' },
                { title: 'SO eins', url: 'https://c.example/3', snippet: 'c3' }
            ] };
        };
        ws.searchWikipedia = async (q) => {
            calls.push('wiki');
            return { query: q, results: [
                { title: 'Modulo (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Modulo', snippet: 'w1' }
            ] };
        };

        const r = await ws.searchKeyless('parser', 10);
        const urls = r.results.map(x => x.url);
        check('Treffer aus beiden erreichbaren Quellen',
            urls.length === 3, JSON.stringify(urls));
        check('gemeinsame Seite nur einmal',
            urls.filter(u => u.includes('gleich.example')).length === 1, JSON.stringify(urls));
        check('erste Quelle gewinnt beim Duplikat',
            r.results.find(x => x.url.includes('gleich.example')).snippet === 'von DDG',
            JSON.stringify(r.results));
        check('bei Treffern keine Problemliste', r.problems === undefined, JSON.stringify(r.problems));

        // Lite wird NICHT gefragt, wenn /html/ liefert: sonst doppelte Last auf
        // demselben Dienst und die Sperre kommt schneller.
        check('Lite bleibt ungefragt wenn HTML liefert',
            !calls.includes('lite'), JSON.stringify(calls));
        // Und Wikipedia rauscht nicht dazwischen, solange es Treffer gibt
        check('Wikipedia nur als letzter Ausweg',
            !calls.includes('wiki'), JSON.stringify(calls));

        // maxResults gilt fuer das Gesamtergebnis
        const kurz = await ws.searchKeyless('parser', 2);
        check('maxResults gilt nach dem Zusammenfuehren',
            kurz.results.length === 2, String(kurz.results.length));

        // /html/ gesperrt -> Lite uebernimmt
        calls = [];
        ws.searchHtml = async () => { throw new Error('403 gesperrt'); };
        const viaLite = await ws.searchKeyless('parser', 5);
        check('Lite uebernimmt wenn HTML sperrt',
            calls.includes('lite') && viaLite.results.some(x => x.url === 'https://b.example/2'),
            JSON.stringify(calls) + ' ' + JSON.stringify(viaLite.results.map(x => x.url)));

        // Suchmaschinen tot, Stack Overflow tot -> Wikipedia als Ausweg
        calls = [];
        ws.searchDuckDuckGoLite = async () => { throw new Error('leer'); };
        ws.searchStackExchange = async () => { throw new Error('429 gedrosselt'); };
        const viaWiki = await ws.searchKeyless('parser', 5);
        check('Wikipedia greift, wenn sonst nichts kommt',
            viaWiki.results.length === 1 && /wikipedia/.test(viaWiki.results[0].url),
            JSON.stringify(viaWiki.results));

        // Alles tot -> jede Ursache muss benannt sein
        ws.searchWikipedia = async () => { throw new Error('timeout'); };
        const leer = await ws.searchKeyless('parser', 5);
        check('ohne Treffer: Ursachen aller Quellen',
            Array.isArray(leer.problems) && leer.problems.length >= 3,
            JSON.stringify(leer.problems));
        check('Ursachen nennen die Quelle',
            /ddglite|duckduckgo/.test(String(leer.problems))
            && /stackexchange/.test(String(leer.problems))
            && /wikipedia/.test(String(leer.problems)),
            String(leer.problems));

        Object.assign(ws, {
            searchHtml: orig.html, searchDuckDuckGoLite: orig.lite,
            searchStackExchange: orig.se, searchWikipedia: orig.wiki
        });
    }

    section('Wikipedia: Sprache am Text erkennen');
    {
        // Ein Grossbuchstabe taugt nicht als Merkmal - "Typescript satisfies"
        // waere sonst deutsch und landete auf de.wikipedia.org.
        const lang = (q) => ws.wikipediaLanguage(q);
        check('englische Code-Frage -> en', lang('typescript satisfies operator') === 'en');
        check('Umlaut -> de', lang('Wie prüft man Gleichheit?') === 'de');
        check('deutsche Funktionswoerter -> de', lang('Was ist ein Parser und wie baut man das') === 'de');
        check('grossgeschriebenes Englisch bleibt en',
            lang('Node Test Runner') === 'en', lang('Node Test Runner'));
    }

    section('SearXNG: HTML statt JSON wird erklaert');
    {
        // Eine frische Instanz gibt kein JSON heraus. Die Meldung muss sagen,
        // was in settings.yml zu aendern ist - sonst sucht man im Client.
        vscode.__settings.searchProvider = 'searxng';
        vscode.__settings.searchEndpoint = base + '/htmlonly';
        const r = await ws.search('test', 5);
        check('kein Treffer', r.results.length === 0);
        check('Meldung nennt settings.yml',
            /settings\.yml/.test(String(r.problems)), String(r.problems));
        check('Meldung nennt search.formats',
            /search\.formats/.test(String(r.problems)), String(r.problems));
        check('Meldung nennt json',
            /"json"/.test(String(r.problems)), String(r.problems));
    }

    server.close();
    console.log(`\nERGEBNIS: ${pass} bestanden, ${fail} fehlgeschlagen`);
    process.exit(fail > 0 ? 1 : 0);
})().catch(err => {
    console.log(`\nABBRUCH: ${err.message}`);
    console.log(err.stack);
    server.close();
    process.exit(2);
});
