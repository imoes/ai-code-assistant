/**
 * Prüft den Untätigkeits-Timeout des Streamings.
 *
 * Simuliert einen Server, der die Antwort beginnt und dann verstummt – genau
 * das passierte, als die VPN-Verbindung mitten im Lauf abriss. Ohne Timeout
 * wartete der Assistent unbegrenzt; hier muss er nach kurzer Zeit abbrechen
 * und eine verwertbare Meldung liefern.
 */
const path = require('path');
const http = require('http');
const Module = require('module');

const PROJECT = process.env.PROJECT_DIR;
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

// ── Server, der nach einem Chunk verstummt ──────────────────────────────────
const stalling = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Ich fange an"}}]}\n\n');
    // Danach absichtlich nichts mehr – und die Verbindung bleibt offen.
});

// ── Server, der sauber antwortet (Gegenprobe) ───────────────────────────────
const healthy = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hallo"}}]}\n\n');
    setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":" Welt"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
    }, 300);
});

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

(async () => {
    const { MCPClient } = require(path.join(PROJECT, 'out', 'mcpClient.js'));
    const client = MCPClient.getInstance();

    const stallPort = await listen(stalling);
    const okPort = await listen(healthy);

    console.log('\n=== Streaming: Untaetigkeits-Timeout ===');

    // Kurzer Timeout, damit der Test schnell ist (Minimum sind 30 s)
    vscode.__settings.streamIdleTimeoutSeconds = 30;
    vscode.__settings.mcpEnabled = false;
    vscode.__settings.apiKey = '';

    // ── Fall 1: Server verstummt ────────────────────────────────────────────
    vscode.__settings.serverUrl = `http://127.0.0.1:${stallPort}`;
    let got = '';
    const t0 = Date.now();
    let error = null;
    try {
        await client.complete([{ role: 'user', content: 'test' }], {}, (tok) => { got += tok; });
    } catch (e) {
        error = e;
    }
    const secs = (Date.now() - t0) / 1000;

    check('haengender Server fuehrt zu einem Fehler', error !== null,
        error ? '' : 'kein Fehler geworfen');
    check('Meldung nennt die Ursache',
        !!error && /sent nothing for/i.test(error.message), error && error.message);
    check('Meldung nennt die Einstellung',
        !!error && /streamIdleTimeoutSeconds/.test(error.message), error && error.message);
    check('bricht nach etwa der eingestellten Zeit ab',
        secs >= 28 && secs <= 45, `${secs.toFixed(1)}s`);
    check('bereits empfangener Text kam an', got.includes('Ich fange an'), JSON.stringify(got));

    // ── Fall 2: gesunder Server laeuft normal durch ─────────────────────────
    vscode.__settings.serverUrl = `http://127.0.0.1:${okPort}`;
    let ok = '';
    let okErr = null;
    let result = null;
    try {
        result = await client.complete([{ role: 'user', content: 'test' }], {}, (tok) => { ok += tok; });
    } catch (e) {
        okErr = e;
    }

    check('gesunder Server ohne Fehler', okErr === null, okErr && okErr.message);
    check('vollstaendige Antwort empfangen', ok === 'Hallo Welt', JSON.stringify(ok));
    check('Ergebnis sauber abgeschlossen',
        !!result && result.finishReason === 'stop', result && result.finishReason);

    stalling.close();
    healthy.close();

    console.log(`\nERGEBNIS: ${pass} bestanden, ${fail} fehlgeschlagen`);
    process.exit(fail > 0 ? 1 : 0);
})();
