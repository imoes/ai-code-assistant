/**
 * Testlauf für den AI Code Assistant ohne VS Code.
 *
 * Hängt sich in Module._load ein, um require('vscode') auf den Stub zu lenken,
 * lädt dann die kompilierten Klassen aus out/ und prüft:
 *   - CodeAnalyzer: read_file, grep, glob, list_dir, projectOverview
 *   - AIEngine: Aktions-Parser, Plan-Parsing, Agenten-Schleifen-Entscheidung
 *   - Instruktionsdateien (AGENTS.md)
 *   - Prompt-Aufbau (Werkzeug-Handbuch)
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

const PROJECT = process.env.PROJECT_DIR;
const STUB = path.join(__dirname, 'vscode-stub.js');
const SANDBOX = path.join(__dirname, 'sandbox');

// ── require('vscode') umlenken ──────────────────────────────────────────────
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return require(STUB);
    return origLoad.apply(this, arguments);
};

const vscode = require(STUB);

// ── Test-Sandbox anlegen ────────────────────────────────────────────────────
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, 'src', 'services'), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, 'node_modules', 'junk'), { recursive: true });

fs.writeFileSync(path.join(SANDBOX, 'package.json'),
    JSON.stringify({ name: 'sandbox', version: '1.0.0', scripts: { test: 'echo ok' } }, null, 2));
fs.writeFileSync(path.join(SANDBOX, 'AGENTS.md'),
    '# Regeln\n\nImmer die Version hochzaehlen.\nKeine console.log im Produktivcode.\n');
fs.writeFileSync(path.join(SANDBOX, 'src', 'index.ts'),
    ['import { UserService } from "./services/userService";', '',
     'const svc = new UserService();', 'console.log(svc.findAll());', ''].join('\n'));
fs.writeFileSync(path.join(SANDBOX, 'src', 'services', 'userService.ts'),
    ['export class UserService {', '    private users: string[] = ["a", "b"];', '',
     '    findAll(): string[] {', '        return this.users;', '    }', '',
     '    findOne(i: number): string {', '        return this.users[i];   // BUG: keine Bereichspruefung',
     '    }', '}', ''].join('\n'));
fs.writeFileSync(path.join(SANDBOX, 'src', 'services', 'authService.ts'),
    ['export class AuthService {', '    login(u: string) { return u.length > 0; }', '}', ''].join('\n'));
fs.writeFileSync(path.join(SANDBOX, 'node_modules', 'junk', 'big.js'),
    'class UserService {}\n'.repeat(50));

vscode.__setWorkspace(SANDBOX);

// ── Test-Rahmen ─────────────────────────────────────────────────────────────
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

// ── CodeAnalyzer ────────────────────────────────────────────────────────────
const { CodeAnalyzer } = require(path.join(PROJECT, 'out', 'codeAnalyzer.js'));
const analyzer = CodeAnalyzer.getInstance();

section('CodeAnalyzer: read_file');
{
    const r = analyzer.readFile('src/services/userService.ts');
    check('liest Datei', r.success, r.output.slice(0, 80));
    check('hat Zeilennummern', /^\s*1 \| export class UserService/m.test(r.output));
    // Die Gesamtzahl steht in der BESCHREIBUNG, nicht in der Ausgabe: die
    // Anzeige hat den Pfad schon in der Kopfzeile, doppelt liest sich schlecht.
    check('Beschreibung nennt Gesamtzeilen',
        /\d+ Zeilen|von \d+/.test(r.description), r.description);
    check('Ausgabe beginnt direkt mit Code',
        /^\s*1 \| export class UserService/.test(r.output), r.output.split('\n')[0]);

    const part = analyzer.readFile('src/services/userService.ts', 4, 3);
    check('offset/limit greift', part.output.includes('findAll') && !part.output.includes('export class'),
        part.output.replace(/\n/g, ' | ').slice(0, 120));
    check('meldet gekuerzten Rest', part.output.includes('nicht angezeigt'));

    // Tippfehler im Namen (Windows ist case-insensitiv, daher echter Schreibfehler)
    const missing = analyzer.readFile('src/services/userServic.ts');
    check('fehlende Datei -> Vorschlag',
        !missing.success && missing.output.includes('Meintest du')
        && missing.output.includes('userService.ts'),
        missing.output.replace(/\n/g, ' | ').slice(0, 160));

    let blocked;
    try { blocked = analyzer.readFile('../../../etc/passwd'); } catch (e) { blocked = { success: false, output: e.message }; }
    check('Workspace-Grenze haelt', !blocked.success, blocked.output.slice(0, 80));
}

section('CodeAnalyzer: grep');
{
    const r = analyzer.grep('class\\s+\\w+Service');
    check('findet Treffer', r.success, r.output.slice(0, 100));
    check('Treffer mit Datei:Zeile', /src\/services\/userService\.ts:1:/.test(r.output), r.output.slice(0, 200));
    check('ignoriert node_modules', !r.output.includes('node_modules'), r.output.slice(0, 200));

    const g = analyzer.grep('UserService', '**/*.ts');
    check('glob-Filter wirkt', g.success && !g.output.includes('.js'), g.output.slice(0, 150));

    const ci = analyzer.grep('userservice', undefined, undefined, true);
    check('ignore_case wirkt', ci.success, ci.output.slice(0, 100));
    const cs = analyzer.grep('userservice');
    check('case-sensitiv ohne Flag', !cs.success, cs.output.slice(0, 100));

    const none = analyzer.grep('zzz_gibt_es_nicht_zzz');
    check('kein Treffer sauber gemeldet', !none.success && none.output.includes('Keine Treffer'));

    const bad = analyzer.grep('([unclosed');
    check('ungueltiges Regex faengt', !bad.success && /Regex/i.test(bad.output), bad.output.slice(0, 80));

    const scoped = analyzer.grep('class', undefined, 'src/services');
    check('path-Einschraenkung wirkt', scoped.success && !scoped.output.includes('index.ts'),
        scoped.output.slice(0, 150));
}

section('CodeAnalyzer: glob / list_dir / overview');
{
    const g = analyzer.glob('**/*.ts');
    check('glob findet ts-Dateien', g.success && g.output.includes('src/index.ts'), g.output.slice(0, 150));
    check('glob ohne node_modules', !g.output.includes('node_modules'));

    const g2 = analyzer.glob('src/services/*.ts');
    check('glob mit Pfadmuster', g2.success && g2.output.includes('userService.ts')
        && !g2.output.includes('src/index.ts'), g2.output.slice(0, 150));

    const g3 = analyzer.glob('*.json');
    check('glob im Wurzelverzeichnis', g3.success && g3.output.includes('package.json'), g3.output.slice(0, 120));

    const d = analyzer.listDir('src');
    check('list_dir listet', d.success && d.output.includes('services/') && d.output.includes('index.ts'),
        d.output.slice(0, 150));

    const dRoot = analyzer.listDir('.');
    check('list_dir markiert Ignore-Ordner', dRoot.output.includes('node_modules/   (übersprungen)'),
        dRoot.output.slice(0, 200));

    const ov = analyzer.projectOverview();
    check('Overview erkennt npm', ov.includes('package.json') && ov.includes('npm test'), ov.slice(0, 200));
    check('Overview gruppiert Ordner', ov.includes('src/services/:'), ov.slice(0, 400));

    const dirAsFile = analyzer.readFile('src');
    check('read_file auf Ordner -> Listing', dirAsFile.success && dirAsFile.output.includes('Inhalt von'),
        dirAsFile.output.slice(0, 100));
}

section('CodeAnalyzer: absolute Pfade kuerzen');
{
    // Modelle uebergeben oft absolute Pfade – Label und Ausgabe muessen
    // trotzdem workspace-relativ bleiben, sonst sprengt es jede Chat-Zeile.
    const abs = path.join(SANDBOX, 'src', 'services', 'userService.ts');
    const r = analyzer.readFile(abs);
    check('absoluter Pfad liest die Datei', r.success, r.output.slice(0, 80));
    check('Label ist relativ', r.description === 'read_file: src/services/userService.ts (L1–11)'
        || r.description.startsWith('read_file: src/services/userService.ts'),
        r.description);
    check('Label enthaelt kein Sandbox-Praefix', !r.description.includes(SANDBOX), r.description);
    check('Beschreibung nennt relativen Pfad',
        r.description.startsWith('read_file: src/services/userService.ts'), r.description);

    const d = analyzer.listDir(path.join(SANDBOX, 'src'));
    check('list_dir Label relativ', d.description === 'list_dir: src → 2 Einträge', d.description);

    const g = analyzer.grep('class', undefined, path.join(SANDBOX, 'src', 'services'));
    check('grep Label relativ', g.description.includes('in src/services')
        && !g.description.includes(SANDBOX), g.description);

    // Pfade AUSSERHALB des Workspace bleiben unveraendert (und werden abgelehnt)
    const outside = analyzer.readFile(path.join(SANDBOX, '..', 'nicht-im-workspace.ts'));
    check('Pfad ausserhalb wird abgelehnt', !outside.success, outside.output.slice(0, 90));
}

// ── AIEngine ────────────────────────────────────────────────────────────────
const { AIEngine } = require(path.join(PROJECT, 'out', 'aiEngine.js'));
const engine = AIEngine.getInstance();

section('AIEngine: Instruktionsdateien');
{
    const instr = engine.readInstructionFiles();
    check('AGENTS.md wird geladen', instr.includes('### AGENTS.md') && instr.includes('Version hochzaehlen'),
        instr.slice(0, 120));
}

section('AIEngine: Werkzeug-Handbuch im Prompt');
{
    const manual = engine.buildToolManual();
    for (const tool of ['action:read_file', 'action:grep', 'action:glob', 'action:list_dir',
                        'action:plan', 'action:done', 'action:patch_file', 'action:replace_lines',
                        'action:create_file', 'action:edit_file', 'action:delete_file',
                        'action:shell', 'action:web_search']) {
        check(`Handbuch nennt ${tool}`, manual.includes(tool));
    }
    check('Handbuch erklaert Agenten-Schleife', manual.includes('Agenten-Schleife'));
    check('Handbuch: erst lesen dann schreiben', manual.includes('Erst lesen, dann schreiben'));
}

section('AIEngine: Plan-Parsing');
{
    const r = engine.handlePlanAction(
        '- [x] Code analysiert\n- [>] Bugfix einbauen\n- [ ] Tests ergaenzen\n- [ ] npm test');
    check('Plan uebernommen', r.type === 'plan' && r.success, JSON.stringify(r));
    const plan = engine.getPlan();
    check('4 Schritte erkannt', plan.length === 4, JSON.stringify(plan));
    check('erledigt erkannt', plan[0].status === 'done', plan[0].status);
    check('in Arbeit erkannt', plan[1].status === 'doing', plan[1].status);
    check('offen erkannt', plan[2].status === 'todo', plan[2].status);
    check('Beschreibung zaehlt', r.description === 'Plan: 1/4 erledigt', r.description);

    const r2 = engine.handlePlanAction('1. [ ] Erster\n2. [x] Zweiter\n* [ ] Dritter\n- Vierter ohne Box');
    check('nummerierte + gemischte Listen', engine.getPlan().length === 4, JSON.stringify(engine.getPlan()));

    let threw = false;
    try { engine.handlePlanAction('nur freier Text ohne Liste'); } catch { threw = true; }
    check('leerer Plan wirft', threw);

    check('Plan-Kontext im Prompt', engine.buildPlanContext().includes('Aktueller Arbeitsplan'),
        engine.buildPlanContext().slice(0, 80));
}

section('AIEngine: Analyse-Aktionen via Parser');
{
    const a = engine.handleAnalysisAction('read_file', 'path: src/index.ts');
    check('read_file Aktion', a.type === 'analysis' && a.output.includes('UserService'), a.description);

    const b = engine.handleAnalysisAction('read_file', 'path: src/services/userService.ts\noffset: 8\nlimit: 3');
    check('read_file mit offset/limit', b.output.includes('findOne') && !b.output.includes('export class'),
        b.output.replace(/\n/g, ' | ').slice(0, 140));

    const c = engine.handleAnalysisAction('grep', 'pattern: BUG\nglob: **/*.ts');
    check('grep Aktion', c.output.includes('userService.ts'), c.description);

    const d = engine.handleAnalysisAction('grep', 'pattern: userservice\nignore_case: true');
    check('grep ignore_case Feld', d.output.includes('Treffer'), d.description);

    const e = engine.handleAnalysisAction('glob', 'pattern: **/*.ts');
    check('glob Aktion', e.output.includes('src/index.ts'), e.description);

    const f = engine.handleAnalysisAction('list_dir', 'path: src');
    check('list_dir Aktion', f.output.includes('index.ts'), f.description);

    // Modelle schreiben den Pfad manchmal ohne "path:"-Praefix
    const g = engine.handleAnalysisAction('read_file', 'src/index.ts');
    check('read_file ohne path:-Praefix', g.output.includes('UserService'), g.description);

    // Analyse ohne Treffer gilt trotzdem als erfolgreich (gueltiges Ergebnis)
    const h = engine.handleAnalysisAction('grep', 'pattern: zzz_nicht_vorhanden');
    check('leeres Analyse-Ergebnis ist success', h.success === true, JSON.stringify(h));
}

section('AIEngine: Aktions-Parser (Blockerkennung)');
{
    const response = [
        'Ich schaue mir zuerst den bestehenden Code an.',
        '',
        '```action:read_file',
        'path: src/services/userService.ts',
        '```',
        '',
        '```action:grep',
        'pattern: findOne',
        'glob: **/*.ts',
        '```',
        '',
        '```action:plan',
        '- [>] Bereichspruefung in findOne ergaenzen',
        '- [ ] Test schreiben',
        '```'
    ].join('\n');

    return engine.parseAndExecuteActions(response, async () => 'Ausführen').then(actions => {
        check('3 Bloecke ausgefuehrt', actions.length === 3, JSON.stringify(actions.map(a => a.type)));
        check('read_file zuerst', actions[0].type === 'analysis', actions[0].type);
        check('grep als zweites', actions[1].type === 'analysis', actions[1].description);
        check('plan als drittes', actions[2].type === 'plan', actions[2].type);

        // XML-Variante (Gemma/Qwen schreiben manchmal Tags)
        return engine.parseAndExecuteActions(
            '<action:read_file>\npath: src/index.ts\n</action:read_file>', async () => 'Ausführen');
    }).then(actions => {
        check('XML-Tag-Variante normalisiert', actions.length === 1 && actions[0].type === 'analysis',
            JSON.stringify(actions));

        return engine.parseAndExecuteActions(
            '```action:done\nzusammenfassung: Bug behoben und getestet.\n```', async () => 'Ausführen');
    }).then(actions => {
        check('done-Aktion erkannt', actions.length === 1 && actions[0].description.includes('abgeschlossen'),
            JSON.stringify(actions));
        check('done setzt Abschlussflag', engine.taskComplete === true);

        return runPatchFenceTests();
    }).then(() => {
        return runToolCallTests();
    }).then(() => {
        return runHistoryTests();
    }).then(() => {
        runModeConsistencyTests();
        runWebviewSyntaxTests();
        runReasoningTests();
        return runLoopTests();
    }).then(() => {
        report();
    });
}

// ── patch_file mit ueberzaehligen Backtick-Zaeunen ──────────────────────────
// Reproduziert exakt die Ausgabe, die laguna im E2E-Lauf erzeugt hat.
function runPatchFenceTests() {
    section('AIEngine: patch_file Zaun-Normalisierung');

    const target = path.join(SANDBOX, 'src', 'services', 'userService.ts');
    const before = fs.readFileSync(target, 'utf-8');
    check('Vorbedingung: Bug ist da', /i\s*<=\s*this\.users\.length/.test(before) === false
        || true);  // Sandbox-Datei hat den Off-by-one nicht; wir legen ihn an

    // Sandbox-Datei mit Off-by-one versehen
    const buggy = [
        'export class UserService {',
        '    private users: string[] = ["a", "b"];',
        '',
        '    sumLen(): number {',
        '        let sum = 0;',
        '        for (let i = 0; i <= this.users.length; i++) {',
        '            sum += this.users[i].length;',
        '        }',
        '        return sum;',
        '    }',
        '}',
        ''
    ].join('\n');
    fs.writeFileSync(target, buggy);

    // Abschluss-Marker hinter dem neuen Code: laguna schrieb im echten Lauf
    // ">>>" als eigene Zeile - die landete unveraendert im Quellcode und machte
    // tokenizer.js und parser.js kaputt.
    const terminators = [
        ['>>> allein', '>>>'],
        ['<<<END>>>', '<<<END>>>'],
        ['git-Konflikt-Stil', '>>>>>>> REPLACE'],
        ['=======', '======='],
        ['eingerueckt', '    >>>']
    ];
    for (const [label, term] of terminators) {
        fs.writeFileSync(target, buggy);
        const out = [
            '```action:patch_file',
            'path: src/services/userService.ts',
            '---',
            '<<<SEARCH',
            '        for (let i = 0; i <= this.users.length; i++) {',
            '>>>REPLACE',
            '        for (let i = 0; i < this.users.length; i++) {',
            term,
            '```'
        ].join('\n');
        // synchron pruefen laesst sich das nicht, also nur die Marker-Entfernung
        const stripped = engine.stripPatchTerminator(
            '        for (let i = 0; i < this.users.length; i++) {\n' + term + '\n');
        check(`Terminator "${label}" entfernt`,
            !/[<>=]{3}/.test(stripped) && stripped.includes('for (let i = 0; i <'),
            JSON.stringify(stripped));
    }

    // ── Patch-Diagnose: WARUM griff der Patch nicht? ─────────────────────────
    // Ohne verwertbare Begruendung wiederholt das Modell denselben Patch.
    {
        const fm = require(path.join(PROJECT, 'out', 'fileManager.js')).FileManager.getInstance();
        const content = [
            'function f() {',
            '    for (let i = 0; i < list.length; i++) {',
            '        sum += list[i];',
            '    }',
            '}'
        ].join('\n');

        // Fall 1: die Aenderung ist schon drin
        const already = fm.explainPatchMiss(
            'a.js', content,
            'for (let i = 0; i <= list.length; i++) {',
            'for (let i = 0; i < list.length; i++) {');
        check('Diagnose: Aenderung bereits vorhanden',
            /BEREITS VORHANDEN/.test(already) && /Wiederhole diesen Patch nicht/.test(already),
            already.slice(0, 140));

        // Fall 2: erste Zeile passt, Folgezeilen nicht
        const partial = fm.explainPatchMiss(
            'a.js', content,
            'function f() {\n    // ganz anderer Inhalt\n}',
            'egal');
        check('Diagnose: erste Zeile passt, Rest nicht',
            /ERSTE Zeile passt/.test(partial) && /Zeile 1:/.test(partial),
            partial.slice(0, 200));

        // Fall 3: gar nichts passt
        const nothing = fm.explainPatchMiss('a.js', content, 'völlig anderer Code', 'egal');
        check('Diagnose: Datei sieht anders aus',
            /sieht anders aus/.test(nothing) && /read_file/.test(nothing),
            nothing.slice(0, 160));
    }

    // Code mit >>> DARF nicht beschnitten werden (Shift-Operator)
    const shifted = 'const x = a >>> 2;\nconst y = 1;';
    check('Code mit >>>-Operator bleibt',
        engine.stripPatchTerminator(shifted) === shifted,
        JSON.stringify(engine.stripPatchTerminator(shifted)));

    // Und End-zu-Ende: Patch mit ">>>"-Terminator darf die Datei nicht zerstoeren
    fs.writeFileSync(target, buggy);
    const withTerminator = [
        '```action:patch_file',
        'path: src/services/userService.ts',
        '---',
        '<<<SEARCH',
        '        for (let i = 0; i <= this.users.length; i++) {',
        '>>>REPLACE',
        '        for (let i = 0; i < this.users.length; i++) {',
        '>>>',
        '```'
    ].join('\n');

    // Modell-Ausgabe MIT Zaun vor >>>REPLACE (der Fehlerfall aus dem E2E-Lauf)
    const modelOutput = [
        'Ich korrigiere den Off-by-one-Fehler:',
        '',
        '```action:patch_file',
        'path: src/services/userService.ts',
        '---',
        '<<<SEARCH',
        '        for (let i = 0; i <= this.users.length; i++) {',
        '```',
        '>>>REPLACE',
        '        for (let i = 0; i < this.users.length; i++) {',
        '```',
        '```'
    ].join('\n');

    // Normalisierung isoliert pruefen
    const norm = engine.normalizePatchFences(modelOutput);
    check('Zaun vor >>>REPLACE entfernt',
        !/\n```\n>>>REPLACE/.test(norm), norm.replace(/\n/g, '|'));

    const withFenceAfterSearch = '<<<SEARCH\n```ts\nalt\n>>>REPLACE\nneu\n';
    check('Zaun nach <<<SEARCH entfernt',
        engine.normalizePatchFences(withFenceAfterSearch) === '<<<SEARCH\nalt\n>>>REPLACE\nneu\n',
        JSON.stringify(engine.normalizePatchFences(withFenceAfterSearch)));

    const withFenceAfterReplace = '<<<SEARCH\nalt\n>>>REPLACE\n```typescript\nneu\n';
    check('Zaun nach >>>REPLACE entfernt',
        engine.normalizePatchFences(withFenceAfterReplace) === '<<<SEARCH\nalt\n>>>REPLACE\nneu\n',
        JSON.stringify(engine.normalizePatchFences(withFenceAfterReplace)));

    const clean = '<<<SEARCH\nalt\n>>>REPLACE\nneu\n';
    check('saubere Patches unveraendert', engine.normalizePatchFences(clean) === clean);

    const noPatch = 'Text mit ```\nCode\n``` aber ohne Patch';
    check('Text ohne SEARCH unangetastet', engine.normalizePatchFences(noPatch) === noPatch);

    // Und jetzt End-zu-Ende durch den Parser: der Patch muss greifen
    return engine.parseAndExecuteActions(modelOutput, async () => 'Anwenden').then(actions => {
        const after = fs.readFileSync(target, 'utf-8');
        check('Patch trotz Zaun ausgefuehrt',
            actions.length === 1 && actions[0].success === true,
            JSON.stringify(actions));
        check('Off-by-one wirklich behoben',
            /i\s*<\s*this\.users\.length/.test(after) && !/i\s*<=\s*this\.users\.length/.test(after),
            after.split('\n').find(l => l.includes('for (')));

        // Mehrere SEARCH/REPLACE-Paare in einem Block
        fs.writeFileSync(target, buggy);
        const multi = [
            '```action:patch_file',
            'path: src/services/userService.ts',
            '---',
            '<<<SEARCH',
            '    private users: string[] = ["a", "b"];',
            '>>>REPLACE',
            '    private users: string[] = ["a", "b", "c"];',
            '<<<SEARCH',
            '        for (let i = 0; i <= this.users.length; i++) {',
            '>>>REPLACE',
            '        for (let i = 0; i < this.users.length; i++) {',
            '```'
        ].join('\n');
        return engine.parseAndExecuteActions(multi, async () => 'Anwenden');
    }).then(actions => {
        const after = fs.readFileSync(target, 'utf-8');
        check('zwei Patches in einem Block', actions[0] && actions[0].success === true,
            JSON.stringify(actions));
        check('beide Aenderungen drin',
            after.includes('"c"') && /i\s*<\s*this\.users\.length/.test(after),
            after.split('\n').slice(1, 7).join(' | '));

        // End-zu-Ende mit Abschluss-Marker: nichts davon darf in der Datei landen
        fs.writeFileSync(target, buggy);
        return engine.parseAndExecuteActions(withTerminator, async () => 'Anwenden');
    }).then(actions => {
        const after = fs.readFileSync(target, 'utf-8');
        check('Patch mit >>>-Terminator angewandt', actions[0] && actions[0].success === true,
            JSON.stringify(actions));
        check('kein >>> im Quellcode gelandet', !after.includes('>>>'),
            after.split('\n').filter(l => l.includes('>>>')).join(' | '));
        check('Datei bleibt gueltiges JavaScript',
            (after.match(/\{/g) || []).length === (after.match(/\}/g) || []).length,
            after);
        check('Off-by-one behoben', /i\s*<\s*this\.users\.length/.test(after)
            && !/i\s*<=\s*this\.users\.length/.test(after),
            after.split('\n').find(l => l.includes('for (')));

        fs.writeFileSync(target, before);
    });
}

// ── Natives Tool-Call-Format (laguna & Co.) ─────────────────────────────────
// Wortwoertlich die Ausgabe, die laguna im echten VS-Code-Fenster erzeugt hat.
// Vorher fand der Parser dabei NULL Aktionen - der Assistent hat nur geredet.
function runToolCallTests() {
    const tcp = require(path.join(PROJECT, 'out', 'toolCallParser.js'));

    section('Tool-Calling: Werkzeugkatalog (OpenAI-Schema)');
    {
        const defs = tcp.TOOL_DEFINITIONS;
        check('Katalog vorhanden', Array.isArray(defs) && defs.length >= 12, String(defs && defs.length));

        for (const must of ['read_file', 'grep', 'glob', 'list_dir', 'plan',
                            'patch_file', 'replace_lines', 'create_file', 'edit_file',
                            'delete_file', 'shell', 'web_search', 'done']) {
            check(`Katalog enthaelt ${must}`, defs.some(d => d.name === must));
        }

        // Jede Definition muss ein gueltiges JSON-Schema sein, sonst lehnt der
        // Server die ganze Anfrage ab - und der Assistent wird komplett stumm.
        for (const d of defs) {
            const ok = typeof d.name === 'string' && d.name.length > 0
                && typeof d.description === 'string' && d.description.length > 10
                && d.parameters && d.parameters.type === 'object'
                && d.parameters.properties && typeof d.parameters.properties === 'object'
                && Object.values(d.parameters.properties).every(
                    p => typeof p.type === 'string' && typeof p.description === 'string');
            check(`${d.name}: Schema gueltig`, ok, JSON.stringify(d).slice(0, 160));

            const required = d.parameters.required || [];
            const known = Object.keys(d.parameters.properties);
            check(`${d.name}: required-Felder existieren`,
                required.every(r => known.includes(r)),
                `required=${required} vorhanden=${known}`);
        }

        // Katalog muss serialisierbar sein (geht so ueber die Leitung)
        let json = null;
        try { json = JSON.stringify(defs); } catch (e) { /* bleibt null */ }
        check('Katalog ist JSON-serialisierbar', typeof json === 'string' && json.length > 500);
    }

    section('Tool-Calling: Server-Antwort (kanonischer Weg)');
    {
        // So liefert llama.cpp die Aufrufe - unabhaengig vom Modellformat.
        const fromServer = [
            { id: 'a1', name: 'read_file', arguments: '{"path":"src/parser.js"}' },
            { id: 'a2', name: 'grep', arguments: '{"pattern":"i <=","glob":"**/*.js"}' }
        ];
        const blocks = tcp.toolCallsToActionBlocks(fromServer);
        check('Server-Aufrufe werden Aktions-Bloecke',
            (blocks.match(/```action:/g) || []).length === 2, blocks);
        check('read_file mit Pfad', blocks.includes('path: src/parser.js'), blocks);
        check('grep mit beiden Argumenten',
            blocks.includes('pattern: i <=') && blocks.includes('glob: **/*.js'), blocks);

        // shell: der Befehl ist der Blockinhalt, nicht "command: ..."
        const shellBlock = tcp.toolCallsToActionBlocks(
            [{ name: 'shell', arguments: '{"command":"npm test"}' }]);
        check('shell-Befehl als Blockinhalt',
            shellBlock.includes('```action:shell\nnpm test'), JSON.stringify(shellBlock));

        // Dateiinhalt gehoert hinter den --- Trenner
        const createBlock = tcp.toolCallsToActionBlocks(
            [{ name: 'create_file', arguments: JSON.stringify({ path: 'a.js', content: 'const a=1;\n' }) }]);
        check('Dateiinhalt hinter ---',
            /```action:create_file\npath: a\.js\n---\nconst a=1;/.test(createBlock),
            JSON.stringify(createBlock));

        // Alias-Namen anderer Harnesses
        const aliased = tcp.toolCallsToActionBlocks([
            { name: 'write_file', arguments: '{"file_path":"b.js","content":"x"}' },
            { name: 'bash', arguments: '{"command":"ls"}' },
            { name: 'str_replace_editor', arguments: '{"path":"c.js","patch":"<<<SEARCH\\na\\n>>>REPLACE\\nb"}' }
        ]);
        check('write_file -> create_file', aliased.includes('```action:create_file'), aliased);
        check('bash -> shell', aliased.includes('```action:shell'), aliased);
        check('str_replace_editor -> patch_file', aliased.includes('```action:patch_file'), aliased);
        check('file_path -> path', aliased.includes('path: b.js'), aliased);

        // Unbekanntes Werkzeug wird verworfen, nicht falsch ausgefuehrt
        const bogus = tcp.toolCallsToActionBlocks([{ name: 'launch_missiles', arguments: '{}' }]);
        check('unbekanntes Werkzeug ignoriert', bogus === '', JSON.stringify(bogus));

        // Kaputtes JSON darf nicht werfen
        let threw = false;
        try { tcp.toolCallsToActionBlocks([{ name: 'read_file', arguments: '{nicht json' }]); }
        catch { threw = true; }
        check('kaputte Argumente werfen nicht', !threw);
    }

    section('Tool-Calling: Ansage (absicht) und Markup-Filter');
    {
        // Jedes Werkzeug muss ein absicht-Feld haben – bei nativen Aufrufen
        // liefern Modelle content:null, dann ist das die EINZIGE Erklaerung,
        // die der Benutzer bekommt.
        for (const d of tcp.TOOL_DEFINITIONS) {
            check(`${d.name}: hat absicht-Feld`,
                !!d.parameters.properties.absicht, Object.keys(d.parameters.properties).join(','));
        }

        const conv = tcp.toolCallsToActions([
            { name: 'read_file', arguments: JSON.stringify({
                absicht: 'Ich lese den Tokenizer, weil die Zahlen-Tests fehlschlagen.',
                path: 'src/tokenizer.js' }) },
            { name: 'shell', arguments: JSON.stringify({
                absicht: 'Jetzt pruefe ich, ob die Tests durchlaufen.',
                command: 'npm test' }) }
        ]);

        check('Ansagen werden gesammelt', conv.intents.length === 2, JSON.stringify(conv.intents));
        check('erste Ansage stimmt',
            conv.intents[0] === 'Ich lese den Tokenizer, weil die Zahlen-Tests fehlschlagen.',
            conv.intents[0]);
        check('Ansage steht VOR dem Block',
            /Ich lese den Tokenizer[^]*?```action:read_file/.test(conv.blocks),
            conv.blocks.replace(/\n/g, '|').slice(0, 160));
        check('absicht landet NICHT als Kopfzeile',
            !conv.blocks.includes('absicht:'), conv.blocks.replace(/\n/g, '|').slice(0, 200));
        check('shell-Befehl bleibt sauber',
            conv.blocks.includes('```action:shell\nnpm test'),
            conv.blocks.replace(/\n/g, '|').slice(0, 200));

        // Ohne absicht darf nichts kaputtgehen
        const noIntent = tcp.toolCallsToActions(
            [{ name: 'glob', arguments: '{"pattern":"**/*.js"}' }]);
        check('ohne absicht keine Ansage', noIntent.intents.length === 0);
        check('ohne absicht trotzdem ein Block',
            noIntent.blocks.includes('```action:glob'), noIntent.blocks);

        // ── Markup-Reste im Dateiinhalt ──────────────────────────────────────
        // Der Fall aus dem echten Lauf: eine Zeile </arg_value> landete mitten
        // im Quellcode und machte tokenizer.js unbrauchbar.
        const dirty = [
            '    if (ch >= "0" && ch <= "9") {',
            '        tokens.push(n);',
            '    }',
            '</arg_value>',
            '',
            '    if (OPERATORS.has(ch)) {'
        ].join('\n');
        const cleaned = tcp.stripToolMarkupFromCode(dirty);
        check('Markup-Zeile entfernt', !cleaned.code.includes('arg_value'),
            cleaned.code.replace(/\n/g, '|'));
        check('Markup-Zeile gemeldet', cleaned.removed.length === 1, JSON.stringify(cleaned.removed));
        check('echter Code bleibt vollstaendig',
            cleaned.code.includes('tokens.push(n);') && cleaned.code.includes('OPERATORS.has(ch)'),
            cleaned.code.replace(/\n/g, '|'));

        // Vergleichsoperatoren duerfen NICHT als Markup gelten
        const codeWithLt = 'if (a < b) {\n  x = a <= b;\n}\nconst t = "</arg_value> im String";';
        const untouched = tcp.stripToolMarkupFromCode(codeWithLt);
        check('Vergleiche und Strings bleiben', untouched.code === codeWithLt
            && untouched.removed.length === 0, untouched.code.replace(/\n/g, '|'));

        // Weitere Markup-Varianten
        for (const tag of ['</tool_call>', '<arg_key>', '</parameter>', '  </function>  ']) {
            const r = tcp.stripToolMarkupFromCode('code();\n' + tag + '\nmore();');
            check(`Variante "${tag.trim()}" entfernt`,
                r.removed.length === 1 && r.code === 'code();\nmore();',
                JSON.stringify(r));
        }
    }

    section('Tool-Calling: Text-Fallback pro Modellfamilie');
    {
        const cases = [
            ['Hermes / Qwen2.5 (JSON)',
             '<tool_call>{"name": "read_file", "arguments": {"path": "a.js"}}</tool_call>',
             'action:read_file', 'path: a.js'],
            ['Qwen3-Coder (XML)',
             '<tool_call><function=grep><parameter=pattern>foo</parameter></function></tool_call>',
             'action:grep', 'pattern: foo'],
            ['Qwen3-Coder ohne Umschlag',
             '<function=list_dir><parameter=path>src</parameter></function>',
             'action:list_dir', 'path: src'],
            ['GLM-4 / laguna (arg_key)',
             '<tool_call>read_file<arg_key>path</arg_key><arg_value>b.js</arg_value></tool_call>',
             'action:read_file', 'path: b.js'],
            ['Mistral Nemo',
             '[TOOL_CALLS] [{"name": "glob", "arguments": {"pattern": "**/*.ts"}}]',
             'action:glob', 'pattern: **/*.ts'],
            ['Llama 3.1 (python_tag)',
             '<|python_tag|>{"name": "read_file", "parameters": {"path": "c.js"}}',
             'action:read_file', 'path: c.js'],
            ['Llama 3.2 (pythonic)',
             '[read_file(path="d.js")]',
             'action:read_file', 'path: d.js'],
            ['Claude-Stil invoke',
             '<invoke name="grep"><parameter name="pattern">bar</parameter></invoke>',
             'action:grep', 'pattern: bar'],
            ['OpenAI-Form im tool_call',
             '<tool_call>{"function": {"name": "shell", "arguments": "{\\"command\\":\\"npm test\\"}"}}</tool_call>',
             'action:shell', 'npm test']
        ];

        for (const [label, raw, wantAction, wantArg] of cases) {
            const out = tcp.normalizeToolCalls(raw);
            check(`${label}: erkannt`, out.includes(wantAction), out.replace(/\n/g, '|').slice(0, 160));
            check(`${label}: Argument uebernommen`, out.includes(wantArg),
                out.replace(/\n/g, '|').slice(0, 160));
        }

        // DeepSeek R1 nutzt Fullwidth-Balken
        const B = '｜', U = '▁';
        const ds = `<${B}tool${U}calls${U}begin${B}><${B}tool${U}call${U}begin${B}>function`
            + `<${B}tool${U}sep${B}>read_file\n\`\`\`json\n{"path":"e.js"}\n\`\`\``
            + `<${B}tool${U}call${U}end${B}><${B}tool${U}calls${U}end${B}>`;
        const dsOut = tcp.normalizeToolCalls(ds);
        check('DeepSeek R1: erkannt', dsOut.includes('action:read_file'), dsOut.replace(/\n/g, '|'));
        check('DeepSeek R1: Pfad uebernommen', dsOut.includes('path: e.js'), dsOut.replace(/\n/g, '|'));
        check('DeepSeek R1: Sondertokens entfernt', !dsOut.includes(`${B}tool`), dsOut.replace(/\n/g, '|'));

        // Kein Fehlalarm: normale Array-Literale im Text bleiben unangetastet
        const innocent = 'Die Liste [1, 2, 3] und der Aufruf [foo(bar=1)] bleiben Text.';
        check('kein Fehlalarm bei Array-Literalen',
            tcp.normalizeToolCalls(innocent) === innocent, tcp.normalizeToolCalls(innocent));

        // Backtick-Bloecke bleiben unberuehrt
        const backtick = 'Text\n```action:shell\nls\n```';
        check('Backtick-Bloecke unveraendert', tcp.normalizeToolCalls(backtick) === backtick);
    }

    section('AIEngine: natives Tool-Call-Format');

    const lagunaOutput =
        'Ich lese zuerst alle relevanten Dateien, um das Problem zu verstehen.' +
        '<tool_call>read_file<arg_key>path</arg_key><arg_value>test/evaluator.test.js</arg_value></tool_call>' +
        '<tool_call>read_file<arg_key>path</arg_key><arg_value>src/tokenizer.js</arg_value></tool_call>' +
        '<tool_call>read_file<arg_key>path</arg_key><arg_value>src/parser.js</arg_value></tool_call>';

    const norm = tcp.normalizeToolCalls(lagunaOutput);
    check('tool_call wird zu action-Block',
        (norm.match(/```action:read_file/g) || []).length === 3, norm.slice(0, 200));
    check('Pfad landet als path:', norm.includes('path: src/tokenizer.js'), norm.slice(0, 300));
    check('Prosa bleibt erhalten', norm.includes('Ich lese zuerst'), norm.slice(0, 80));

    // Mehrere Argumente
    const grepCall = '<tool_call>grep<arg_key>pattern</arg_key><arg_value>class \\w+</arg_value>'
        + '<arg_key>glob</arg_key><arg_value>**/*.js</arg_value></tool_call>';
    const g = tcp.normalizeToolCalls(grepCall);
    check('mehrere Argumente als Kopfzeilen',
        g.includes('pattern: class \\w+') && g.includes('glob: **/*.js'), g);

    // shell: nur der Befehl, kein "command:"-Praefix
    const shellCall = '<tool_call>shell<arg_key>command</arg_key><arg_value>npm test</arg_value></tool_call>';
    const s = tcp.normalizeToolCalls(shellCall);
    check('shell ohne Argumentnamen',
        s.includes('```action:shell\nnpm test'), JSON.stringify(s));

    // Dateiaktion: Kopf + Trenner + Inhalt
    const createCall = '<tool_call>create_file<arg_key>path</arg_key><arg_value>src/neu.js</arg_value>'
        + '<arg_key>content</arg_key><arg_value>const a = 1;\nmodule.exports = a;\n</arg_value></tool_call>';
    const c = tcp.normalizeToolCalls(createCall);
    check('Dateiinhalt kommt nach ---',
        /```action:create_file\npath: src\/neu\.js\n---\nconst a = 1;/.test(c), JSON.stringify(c));

    // JSON-Variante
    const jsonCall = '<tool_call>{"name": "glob", "arguments": {"pattern": "**/*.test.js"}}</tool_call>';
    const j = tcp.normalizeToolCalls(jsonCall);
    check('JSON-Variante erkannt',
        j.includes('```action:glob') && j.includes('pattern: **/*.test.js'), JSON.stringify(j));

    // Praefixe wie functions.read_file
    const prefixed = '<tool_call>{"name": "functions.read_file", "arguments": {"path": "a.js"}}</tool_call>';
    check('Namenspraefix entfernt',
        tcp.normalizeToolCalls(prefixed).includes('```action:read_file'),
        tcp.normalizeToolCalls(prefixed));

    // Ohne tool_call unveraendert
    const plain = 'Nur Text mit ```action:shell\nls\n```';
    check('Text ohne tool_call unveraendert', tcp.normalizeToolCalls(plain) === plain);

    // Rohes XML darf NICHT im Chat landen
    const cleaned = engine.cleanForDisplay(lagunaOutput);
    check('rohes XML aus dem Chattext entfernt',
        !cleaned.includes('tool_call') && !cleaned.includes('arg_key')
        && cleaned.includes('Ich lese zuerst'), JSON.stringify(cleaned));

    // Und jetzt End-zu-Ende durch den Parser
    return engine.parseAndExecuteActions(lagunaOutput, async () => 'Anwenden').then(actions => {
        check('laguna-Ausgabe erzeugt 3 Aktionen', actions.length === 3,
            JSON.stringify(actions.map(a => a.type + ':' + a.description)));
        check('alle drei sind Analysen',
            actions.every(a => a.type === 'analysis'),
            JSON.stringify(actions.map(a => a.type)));
    });
}

// ── Verlauf komprimieren und loeschen ───────────────────────────────────────
function runHistoryTests() {
    section('AIEngine: Verlauf komprimieren');

    // Kontextgroesse und Schwelle klein setzen, damit die Grenze greift
    vscode.__settings.autoCompact = true;
    vscode.__settings.compactThresholdPercent = 89;
    vscode.__settings.contextWarningThreshold = 1000;   // -> Grenze bei 890 Tokens

    // Der Stub kennt keinen Server, getContextSize() liefert undefined
    // -> es gilt contextWarningThreshold.

    // Kurzer Verlauf: nichts zu tun
    engine.conversationHistory = [
        { role: 'user', content: 'kurz' },
        { role: 'assistant', content: 'ok' }
    ];
    return engine.compactHistoryIfNeeded('sys').then(note => {
        check('kurzer Verlauf bleibt unangetastet',
            note === undefined && engine.conversationHistory.length === 2, String(note));

        // Langer Verlauf: 10 Nachrichten a 1000 Zeichen = ~2500 Tokens > 890
        engine.conversationHistory = Array.from({ length: 10 }, (_, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: 'Nachricht ' + i + ': ' + 'x'.repeat(1000)
        }));
        const before = engine.conversationHistory.length;
        return engine.compactHistoryIfNeeded('sys').then(n => ({ n, before }));
    }).then(({ n, before }) => {
        // Ohne erreichbaren Server schlaegt das Zusammenfassen fehl ->
        // harte Kuerzung. Beides ist ein gueltiges Ergebnis, nur "nichts tun"
        // waere falsch: dann liefe die naechste Anfrage in den Kontextfehler.
        check('langer Verlauf wird komprimiert', n !== undefined, String(n));
        check('Verlauf ist danach kuerzer',
            engine.conversationHistory.length < before,
            before + ' -> ' + engine.conversationHistory.length);
        check('die letzten 4 Nachrichten bleiben',
            engine.conversationHistory.some(m => m.content.includes('Nachricht 9')),
            JSON.stringify(engine.conversationHistory.map(m => m.content.slice(0, 20))));
        check('Meldung nennt den Grund',
            /komprimiert|gekürzt/i.test(String(n)), String(n));

        // Abgeschaltet -> nichts passiert
        vscode.__settings.autoCompact = false;
        engine.conversationHistory = Array.from({ length: 10 }, (_, i) => ({
            role: 'user', content: 'y'.repeat(1000)
        }));
        return engine.compactHistoryIfNeeded('sys');
    }).then(n => {
        check('autoCompact=false komprimiert nicht',
            n === undefined && engine.conversationHistory.length === 10, String(n));

        vscode.__settings.autoCompact = true;
        vscode.__settings.contextWarningThreshold = 200000;

        section('AIEngine: Verlauf loeschen');
        // Historie mit Inhalt anlegen
        engine.conversationHistory = [{ role: 'user', content: 'a' }];
        engine.handlePlanAction('- [ ] etwas');
        check('Vorbedingung: Plan und Verlauf vorhanden',
            engine.getPlan().length === 1 && engine.conversationHistory.length === 1);

        const removed = engine.clearHistory();
        check('clearHistory laeuft durch', typeof removed === 'number', String(removed));
        check('Konversation leer', engine.conversationHistory.length === 0,
            JSON.stringify(engine.conversationHistory));
        check('Plan leer', engine.getPlan().length === 0, JSON.stringify(engine.getPlan()));

        const hm = engine.getHistoryManager();
        if (hm) {
            check('Historie-Datei hat keine alten Sessions',
                hm.getSessions().length <= 1, String(hm.getSessions().length));
            check('aktuelle Session ist leer',
                hm.getCurrentSessionMessages().length === 0,
                String(hm.getCurrentSessionMessages().length));
        } else {
            check('HistoryManager verfuegbar', false, 'null');
        }
    });
}

// ── Modus: Chat und Einstellungs-Panel muessen dasselbe anzeigen ────────────
// Im laufenden Fenster stand das Panel auf "Ask", waehrend der Chat "Auto"
// zeigte: das Panel las `mode` direkt und bekam den Standard, ohne die
// Migration vom alten `autoApply`. Ein Klick auf Speichern haette den
// Auto-Modus stillschweigend abgeschaltet.
function runModeConsistencyTests() {
    section('Modus: Chat und Panel stimmen ueberein');

    const { getAssistantMode } = require(path.join(PROJECT, 'out', 'aiEngine.js'));
    const { SettingsPanel } = require(path.join(PROJECT, 'out', 'settingsPanel.js'));
    const fakeWebview = { cspSource: 'vscode-resource:', asWebviewUri: (u) => u };

    const panelMode = () => {
        const self = Object.create(SettingsPanel.prototype);
        const html = SettingsPanel.prototype.buildHtml.call(self, fakeWebview);
        const m = /<select data-key="mode">([\s\S]*?)<\/select>/.exec(html);
        if (!m) return null;
        const sel = /<option value="([a-z]+)" selected>/.exec(m[1]);
        return sel ? sel[1] : null;
    };

    const cases = [
        // mode explizit gesetzt -> gewinnt
        { mode: 'plan', autoApply: false, explicit: true, want: 'plan' },
        { mode: 'auto', autoApply: false, explicit: true, want: 'auto' },
        { mode: 'ask', autoApply: true, explicit: true, want: 'ask' },
        // mode NICHT gesetzt -> altes autoApply gilt
        { mode: 'ask', autoApply: true, explicit: false, want: 'auto' },
        { mode: 'ask', autoApply: false, explicit: false, want: 'ask' }
    ];

    for (const c of cases) {
        vscode.__settings.mode = c.mode;
        vscode.__settings.autoApply = c.autoApply;
        vscode.__setExplicit('mode', c.explicit);

        const engineMode = getAssistantMode();
        const uiMode = panelMode();

        const label = `mode=${c.mode}${c.explicit ? '' : ' (nicht gesetzt)'}, autoApply=${c.autoApply}`;
        check(`${label}: Engine sagt ${c.want}`, engineMode === c.want, engineMode);
        check(`${label}: Panel zeigt dasselbe`, uiMode === engineMode,
            `Panel=${uiMode} Engine=${engineMode}`);
    }

    // Ausgangszustand wiederherstellen
    vscode.__settings.mode = 'auto';
    vscode.__settings.autoApply = true;
    vscode.__setExplicit('mode', true);
}

// ── WebView-Skripte syntaktisch pruefen ─────────────────────────────────────
// Das Chat-Panel und das Einstellungs-Panel erzeugen ihr JavaScript in einem
// TypeScript-Template-String. Ein einfaches \n darin wird zu einem ECHTEN
// Zeilenumbruch mitten in einem JS-String-Literal - das Skript ist dann
// unparsebar und das ganze Panel tot, ohne jede Fehlermeldung im Log.
// (Genau so passiert, gefunden erst per Screenshot des laufenden Fensters.)
function runWebviewSyntaxTests() {
    section('WebView-Skripte: Syntaxpruefung');

    const fakeWebview = { cspSource: 'vscode-resource:', asWebviewUri: (u) => u };

    const panels = [
        {
            name: 'ChatPanel',
            build: () => {
                const { ChatPanel } = require(path.join(PROJECT, 'out', 'chatPanel.js'));
                // buildHtml ist eine Instanzmethode; ohne WebviewPanel bauen wir
                // die Instanz nicht auf, sondern rufen die Methode direkt auf.
                return ChatPanel.prototype.buildHtml.call(
                    { sessionId: '1' }, fakeWebview);
            }
        },
        {
            name: 'SettingsPanel',
            build: () => {
                const { SettingsPanel } = require(path.join(PROJECT, 'out', 'settingsPanel.js'));
                const self = Object.create(SettingsPanel.prototype);
                return SettingsPanel.prototype.buildHtml.call(self, fakeWebview);
            }
        }
    ];

    for (const p of panels) {
        let html;
        try { html = p.build(); }
        catch (err) {
            check(`${p.name}: HTML erzeugt`, false, err.message);
            continue;
        }
        check(`${p.name}: HTML erzeugt`, typeof html === 'string' && html.length > 500);

        const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
        check(`${p.name}: enthaelt ein Skript`, scripts.length >= 1, `gefunden: ${scripts.length}`);

        for (let i = 0; i < scripts.length; i++) {
            let err = null;
            try {
                // new Function parst, fuehrt aber nicht aus - genau was wir wollen.
                new Function(scripts[i]);
            } catch (e) {
                err = e.message;
            }
            check(`${p.name}: Skript ${i + 1} ist parsebar`, err === null, err || '');
        }

        // Bedienelemente und Handler muessen vorhanden sein. Parsebarkeit
        // allein reicht nicht: ein versehentlich entferntes Element faellt
        // sonst erst im laufenden Fenster auf.
        if (p.name === 'ChatPanel') {
            const required = [
                // Markup
                'id="mode-select"', 'id="btn-clear"', 'id="stats-bar"',
                'id="stats-progress"', 'id="thinking-label"', 'id="prompt-input"',
                'value="ask"', 'value="auto"', 'value="plan"',
                // Handler
                'function renderFileDiff', 'function renderStats', 'function renderPlan',
                'function setMode', 'function resetStats', 'function progressKey',
                'function setThinkingPhase',
                // Nachrichtentypen aus dem Extension-Host
                "case 'fileDiff'", "case 'stats'", "case 'plan'",
                "case 'modeChanged'", "case 'clearChat'",
                // Meldungen an den Extension-Host
                "type:'clearHistory'", "type:'setMode'"
            ];
            for (const needle of required) {
                check(`ChatPanel: enthaelt ${needle}`, html.includes(needle));
            }

            // Die Statistik darf NICHT in der Denk-Leiste stehen: die wird
            // zwischen den Schritten aus- und eingeschaltet, die Zahlen waeren
            // dann jedes Mal weg.
            const thinkingBlock = /<div id="thinking">([\s\S]*?)<\/div>/.exec(html);
            check('ChatPanel: Statistik NICHT in der Denk-Leiste',
                !!thinkingBlock && !thinkingBlock[1].includes('stats-bar'),
                thinkingBlock ? thinkingBlock[1].replace(/\n/g, ' ').slice(0, 160) : 'kein Block');

            // Reasoning startet zugeklappt
            check('ChatPanel: Reasoning startet zugeklappt',
                html.includes('<details class="think-block">')
                && !html.includes('<details class="think-block" open>'),
                (html.match(/<details class="think-block"[^>]*>/g) || []).join(' | '));
        }

        if (p.name === 'SettingsPanel') {
            for (const needle of ['data-key="mode"', 'data-key="apiKey"',
                                  'data-key="nativeToolCalls"', 'data-key="showConsole"',
                                  'id="btn-save"', 'id="btn-test"']) {
                check(`SettingsPanel: enthaelt ${needle}`, html.includes(needle));
            }
        }

        // Kein echter Zeilenumbruch innerhalb eines einfachen JS-Strings
        for (const s of scripts) {
            const bad = s.split('\n').filter(line => {
                const singles = (line.match(/'/g) || []).length;
                // ungerade Anzahl Apostrophe = String laeuft ueber das Zeilenende
                // (Apostrophe in Kommentaren rausrechnen ist hier nicht noetig,
                //  weil new Function das ohnehin bereits geprueft hat)
                return singles % 2 === 1 && !line.trimStart().startsWith('//');
            });
            check(`${p.name}: keine offenen String-Literale`, bad.length === 0,
                bad.slice(0, 2).join(' || '));
        }
    }
}

// ── Reasoning-Modelle (laguna, DeepSeek R1, Qwen) ───────────────────────────
function runReasoningTests() {
    section('AIEngine: Reasoning-Blöcke');

    // Entwürfe im Denkteil dürfen NICHT ausgeführt werden
    const withThink = [
        '<think>',
        'Vielleicht so:',
        '```action:delete_file',
        'path: src/index.ts',
        '```',
        'Nein, besser nur lesen.',
        '</think>',
        'Ich schaue mir den Code an.',
        '```action:read_file',
        'path: src/index.ts',
        '```'
    ].join('\n');

    const stripped = engine.stripReasoning(withThink);
    check('Denkteil entfernt', !stripped.includes('delete_file'), stripped.slice(0, 120));
    check('Antwortteil erhalten', stripped.includes('read_file'), stripped.slice(0, 120));

    // Abgeschnittene Antwort (max_tokens erreicht, </think> fehlt)
    const truncated = 'Text davor\n<think>\nIch überlege noch\n```action:edit_file\npath: x.ts\n---\nweg\n```';
    const t = engine.stripReasoning(truncated);
    check('abgeschnittener Denkteil liefert keine Aktion', !t.includes('edit_file'), t);
    check('Text vor <think> bleibt', t.includes('Text davor'), t);

    // Antwort ohne Reasoning bleibt unverändert
    const plain = 'Kurze Antwort\n```action:read_file\npath: a.ts\n```';
    check('Antwort ohne <think> unveraendert', engine.stripReasoning(plain) === plain);

    // Mehrere Denkblöcke
    const multi = '<think>a</think>Eins<think>b</think>Zwei';
    check('mehrere Denkbloecke entfernt', engine.stripReasoning(multi) === 'EinsZwei',
        engine.stripReasoning(multi));
}

// ── Agenten-Schleife ────────────────────────────────────────────────────────
function runLoopTests() {
    section('AIEngine: Agenten-Schleifen-Entscheidung');
    const cfg = vscode.workspace.getConfiguration();

    // taskComplete stoppt die Schleife
    engine.taskComplete = true;
    check('done stoppt Schleife',
        engine.planNextStep([{ type: 'analysis', description: 'x', success: true, output: 'y' }], 0, cfg) === null);

    engine.taskComplete = false;

    // Analyse-Ergebnisse -> weiterarbeiten
    const s1 = engine.planNextStep(
        [{ type: 'analysis', description: 'read_file: a.ts', success: true, output: 'Inhalt' }], 0, cfg);
    check('Analyse fuehrt zu naechstem Schritt', s1 !== null, String(s1));
    check('Analyse-Prompt fordert Umsetzung',
        s1 && s1.prompt.includes('ERGEBNISSE DEINER CODE-ANALYSE'), s1 && s1.prompt.slice(0, 80));

    // Shell-Fehler -> Reparatur, und zwar VOR der Analyse-Auswertung
    const s2 = engine.planNextStep([
        { type: 'analysis', description: 'read_file: a.ts', success: true, output: 'Inhalt' },
        { type: 'shell', description: 'Shell: npm test', success: false, output: 'TS2304: Cannot find name' }
    ], 1, cfg);
    check('Shell-Fehler hat Vorrang', s2 && s2.prompt.includes('FEHLER-ANALYSE'), s2 && s2.reason);

    // Benutzer-Anweisung
    const s3 = engine.planNextStep([
        { type: 'shell', description: 'Abgelehnt: rm -rf /', success: false,
          output: 'Benutzer-Anweisung: Nutze stattdessen npm ci' }
    ], 1, cfg);
    check('Benutzer-Anweisung erkannt', s3 && s3.prompt.includes('Benutzer hat folgende Anweisung'),
        s3 && s3.reason);

    // Nur Dateiaenderung, kein offener Plan, Auto-Test AUS -> Stopp
    engine.plan = [];
    const autoTestVorher = vscode.__settings.autoTest;
    vscode.__settings.autoTest = false;
    const s4 = engine.planNextStep(
        [{ type: 'file_edit', description: 'Bearbeitet: a.ts', success: true }], 1, cfg);
    check('reine Dateiaenderung stoppt (ohne Auto-Test)', s4 === null, JSON.stringify(s4));
    vscode.__settings.autoTest = autoTestVorher;

    // Offener Plan -> weiterarbeiten
    engine.handlePlanAction('- [x] Analysiert\n- [ ] Bugfix einbauen\n- [ ] Test');
    const s5 = engine.planNextStep(
        [{ type: 'file_edit', description: 'Bearbeitet: a.ts', success: true }], 1, cfg);
    check('offener Plan treibt Schleife', s5 !== null && s5.prompt.includes('PLAN FORTSETZEN'),
        s5 && s5.reason);
    check('naechster Schritt benannt', s5 && s5.prompt.includes('Bugfix einbauen'), s5 && s5.prompt.slice(0, 200));

    // Vollstaendig erledigter Plan -> Stopp
    engine.handlePlanAction('- [x] Analysiert\n- [x] Bugfix\n- [x] Test');
    const s6 = engine.planNextStep(
        [{ type: 'file_edit', description: 'Bearbeitet: a.ts', success: true }], 1, cfg);
    check('erledigter Plan stoppt', s6 === null, JSON.stringify(s6));

    // Schrittlimit
    const s7 = engine.planNextStep(
        [{ type: 'analysis', description: 'read_file', success: true, output: 'x' }], 12, cfg);
    check('Schrittlimit greift', s7 === null, JSON.stringify(s7));

    // Endlosschleife: Analyse in Runde 11 laeuft noch, in Runde 12 nicht mehr
    const s8 = engine.planNextStep(
        [{ type: 'analysis', description: 'read_file', success: true, output: 'x' }], 11, cfg);
    check('Runde 11 laeuft noch', s8 !== null);

    // ── Endlosschleife: fehlgeschlagene Patches ───────────────────────────────
    // Der Fall aus dem echten Lauf: patch_file schlaegt fehl, weil die Aenderung
    // schon drin ist. Vorher zaehlte das als "Dateiaenderung erfolgt", der Fehler
    // wurde nie zurueckgemeldet und das Modell wiederholte ihn 20 Runden lang.
    engine.lastActionSignature = '';
    engine.repeatCount = 0;
    engine.plan = [];
    const failedPatch = [{
        type: 'file_edit',
        description: 'Patch fehlgeschlagen: src/tokenizer.js',
        success: false,
        output: 'Die Änderung ist in src/tokenizer.js BEREITS VORHANDEN'
    }];

    const f1 = engine.planNextStep(failedPatch, 1, cfg);
    check('fehlgeschlagener Patch wird zurueckgemeldet',
        f1 !== null && f1.prompt.includes('NICHT ANGEWENDET'), f1 && f1.reason);
    check('Prompt warnt vor Wiederholung',
        f1 && f1.prompt.includes('Wiederhole NICHT'), f1 && f1.prompt.slice(0, 120));
    check('Ursache steht im Prompt',
        f1 && f1.prompt.includes('BEREITS VORHANDEN'), f1 && f1.prompt.slice(0, 200));

    // Dieselbe Runde erneut -> zweiter Versuch erlaubt, dritter bricht ab
    const f2 = engine.planNextStep(failedPatch, 2, cfg);
    check('zweite identische Runde noch erlaubt', f2 !== null, String(f2));
    const f3 = engine.planNextStep(failedPatch, 3, cfg);
    check('dritte identische Runde bricht ab', f3 === null, JSON.stringify(f3));

    // Nach einer ANDEREN Runde ist der Zaehler zurueckgesetzt
    engine.lastActionSignature = '';
    engine.repeatCount = 0;
    const other = engine.planNextStep(
        [{ type: 'analysis', description: 'read_file: x', success: true, output: 'y' }], 1, cfg);
    check('andere Runde setzt Zaehler zurueck', other !== null && engine.repeatCount === 0,
        String(engine.repeatCount));

    // Fehlgeschlagene Aenderung zaehlt NICHT als getane Arbeit:
    // die Befehlsausgabe muss weiter durchkommen
    engine.lastActionSignature = '';
    engine.repeatCount = 0;
    engine.plan = [];
    const mixed = engine.planNextStep([
        { type: 'file_edit', description: 'Patch fehlgeschlagen: a.js', success: false, output: 'nope' },
        { type: 'shell', description: 'Shell: npm test', success: true, output: '2 Tests rot' }
    ], 1, cfg);
    check('gescheiterte Aenderung blockiert die Rueckmeldung nicht',
        mixed !== null, JSON.stringify(mixed));

    // agentLoop=false: Analyse treibt die Schleife nicht mehr, autoFix bleibt
    vscode.__settings.agentLoop = false;
    const s9 = engine.planNextStep(
        [{ type: 'analysis', description: 'read_file', success: true, output: 'x' }], 0, cfg);
    check('agentLoop=false stoppt Analyse-Schleife', s9 === null, JSON.stringify(s9));
    const s10 = engine.planNextStep(
        [{ type: 'shell', description: 'npm test', success: false, output: 'Fehler' }], 0, cfg);
    check('agentLoop=false: Fehlerkorrektur bleibt', s10 !== null, JSON.stringify(s10));
    vscode.__settings.agentLoop = true;

    runTaskAnchorTests(cfg);
    runOutputCapTests(cfg);
    return runBareActionTests();
}

// ── Lange Ausgaben duerfen den Kontext nicht fluten ─────────────────────────
// Eine abgerufene Seite hat leicht 20 000 Zeichen. Ungekuerzt geht sie in den
// Folge-Prompt UND in den Gespraechsverlauf: bei einem 16k-Modell ist der
// Kontext danach voll und die Komprimierung wirft die eigentliche Arbeit weg.
function runOutputCapTests(cfg) {
    section('Folge-Prompt: lange Ausgaben werden gedeckelt');

    engine.lastActionSignature = '';
    engine.repeatCount = 0;
    engine.plan = [];
    engine.taskComplete = false;
    engine.currentTask = 'Lies die Doku.';

    const kopf = 'ANFANG-DER-AUSGABE';
    const fuss = 'not ok 7 - genau hier steht der Fehler';
    const lang = kopf + '\n' + 'x'.repeat(30000) + '\n' + fuss;

    const step = engine.planNextStep(
        [{ type: 'shell', description: 'Shell: npm test', success: true, output: lang }], 1, cfg);

    check('Runde laeuft weiter', step !== null);
    check('Prompt ist deutlich kuerzer als die Ausgabe',
        step && step.prompt.length < 12000, step && String(step.prompt.length));
    check('Anfang bleibt erhalten', step && step.prompt.includes(kopf));
    check('Ende bleibt erhalten – dort steht der Fehler',
        step && step.prompt.includes(fuss), step && step.prompt.slice(-200));
    check('Kuerzung ist benannt',
        step && /Zeichen ausgelassen/.test(step.prompt));
    check('Kuerzung sagt, wie man den Rest bekommt',
        step && /read_file mit offset|grep/.test(step.prompt));

    // Kurze Ausgaben bleiben unangetastet
    engine.lastActionSignature = '';
    engine.repeatCount = 0;
    const kurz = engine.planNextStep(
        [{ type: 'shell', description: 'Shell: npm test', success: true, output: '11 gruen' }], 1, cfg);
    check('kurze Ausgabe unverandert',
        kurz && kurz.prompt.includes('11 gruen') && !/ausgelassen/.test(kurz.prompt));

    runVerifyAfterChangeTests(cfg);
}

// ── Geaendert, aber nicht geprueft ──────────────────────────────────────────
// Im Fenster-Lauf hatte der Auftrag fuenf Punkte. Der Assistent patchte den
// Tokenizer - und die Schleife endete, weil eine erfolgreiche Dateiaenderung
// als Endpunkt galt. Getestet wurde nie, die restlichen vier Punkte blieben
// liegen. Die Auto-Test-Instruktion im System-Prompt BITTET das Modell nur.
function runVerifyAfterChangeTests(cfg) {
    section('Agenten-Schleife: Aenderung wird geprueft');

    const vorher = vscode.__settings.autoTest;
    vscode.__settings.autoTest = true;
    engine.plan = [];
    engine.taskComplete = false;
    engine.currentTask = 'Unterstuetze Variablen und lege test/variablen.test.js an.';
    engine.lastActionSignature = '';
    engine.repeatCount = 0;

    const step = engine.planNextStep(
        [{ type: 'file_edit', description: 'Gepacht: src/tokenizer.js (1 Änderung)', success: true }],
        1, cfg);

    check('Aenderung ohne Test treibt die Schleife weiter', step !== null, JSON.stringify(step));
    check('Prompt fordert die Tests an',
        step && /Tests des Projekts/.test(step.prompt), step && step.prompt.slice(0, 120));
    check('Prompt nennt die geaenderte Datei',
        step && step.prompt.includes('src/tokenizer.js'), step && step.prompt.slice(0, 200));
    check('Prompt erinnert an offene Punkte',
        step && /Punkte des Auftrags offen/.test(step.prompt), step && step.prompt.slice(-200));
    check('Auftrag steht auch hier im Prompt',
        step && step.prompt.includes('variablen.test.js'), step && step.prompt.slice(0, 200));

    // Wurde in derselben Runde schon getestet, wird nicht nachgefragt: die
    // Shell-Ausgabe geht ueber Zweig 3 zurueck.
    engine.lastActionSignature = '';
    engine.repeatCount = 0;
    const mitTest = engine.planNextStep([
        { type: 'file_edit', description: 'Gepacht: src/tokenizer.js', success: true },
        { type: 'shell', description: 'Shell: npm test', success: true, output: '11 gruen' }
    ], 1, cfg);
    check('mit Testlauf keine Nachfrage',
        mitTest !== null && !/DU HAST GEÄNDERT/.test(mitTest.prompt),
        mitTest && mitTest.prompt.slice(0, 80));

    // Gescheiterte Aenderung zaehlt nicht als Aenderung: dafuer ist Zweig 1b da
    engine.lastActionSignature = '';
    engine.repeatCount = 0;
    const gescheitert = engine.planNextStep(
        [{ type: 'file_edit', description: 'Patch fehlgeschlagen: a.js', success: false, output: 'nope' }],
        1, cfg);
    check('gescheiterte Aenderung geht in die Fehlerrueckmeldung',
        gescheitert !== null && /NICHT ANGEWENDET/.test(gescheitert.prompt),
        gescheitert && gescheitert.prompt.slice(0, 80));

    // Ist die KI fertig, wird nicht nachgefragt
    engine.taskComplete = true;
    check('action:done beendet trotz ungepruefter Aenderung',
        engine.planNextStep(
            [{ type: 'file_edit', description: 'Gepacht: a.ts', success: true }], 1, cfg) === null);
    engine.taskComplete = false;

    vscode.__settings.autoTest = vorher;
}

// ── Zaunlose Aktions-Kopfzeilen ─────────────────────────────────────────────
// Im Fenster-Lauf beendete das Modell seine Antwort mit "action:done" ohne
// Backticks. Der Block wurde weder ausgefuehrt noch aus der Anzeige entfernt -
// "action:done" stand als Text mitten in der Antwort.
function runBareActionTests() {
    section('Aktions-Parser: Kopfzeile ohne Zaun');

    const antwort = [
        '1. Mit der `todo`-Option.',
        '2. Mit `describe()`.',
        '',
        'action:done',
        'zusammenfassung: Die drei Fragen wurden beantwortet.'
    ].join('\n');

    engine.taskComplete = false;
    return engine.parseAndExecuteActions(antwort, async () => 'Ausführen').then(actions => {
        check('zaunloses action:done wird ausgefuehrt',
            actions.length === 1 && actions[0].description.includes('abgeschlossen'),
            JSON.stringify(actions));
        check('Abschlussflag gesetzt', engine.taskComplete === true);

        const sichtbar = engine.cleanForDisplay(antwort);
        check('action:done steht nicht mehr in der Anzeige',
            !sichtbar.includes('action:done'), sichtbar);
        check('Zusammenfassungszeile ebenfalls entfernt',
            !sichtbar.includes('zusammenfassung:'), sichtbar);
        check('die eigentliche Antwort bleibt',
            sichtbar.includes('`todo`-Option') && sichtbar.includes('`describe()`'), sichtbar);

        // Prosa nach dem Block bleibt Prosa
        const mitProsa = 'action:done\nzusammenfassung: fertig\n\nFalls noch Fragen offen sind, sag es.';
        const sichtbar2 = engine.cleanForDisplay(mitProsa);
        check('Prosa nach dem Block bleibt stehen',
            sichtbar2.includes('Falls noch Fragen offen sind'), sichtbar2);
        check('Block selbst ist weg', !sichtbar2.includes('zusammenfassung'), sichtbar2);

        // Schreibende Aktionen werden NICHT eingezaeunt: wo der Quellcode endet,
        // verraet ohne Zaun nichts - eine Fehleinschaetzung schreibt Prosa in die Datei.
        const gefaehrlich = 'action:create_file\npath: src/neu.ts\n---\nexport const a = 1;\n\nDas war es.';
        const roh = engine.stripActionBlocks(gefaehrlich);
        check('create_file ohne Zaun wird NICHT eingezaeunt',
            roh.includes('action:create_file'), roh);

        // Eine Kopfzeile ohne Argumente ist keine Aktion
        const nurKopf = 'Ich nutze jetzt action:done\nund erklaere es dir.';
        check('erwaehnung im Satz bleibt unberuehrt',
            engine.stripActionBlocks(nurKopf).includes('action:done'));

        engine.taskComplete = false;
        return runDisplayStripTests();
    });
}

// ── Anzeige und Parser muessen dasselbe wegwerfen ───────────────────────────
// Im Fenster stand ein patch_file-Block als Text im Chat: ">>>REPLACE" und
// darunter der Quellcode. Der Parser konnte die verrutschten Zaeune geradeziehen
// und fuehrte den Patch aus - der Anzeigepfad kannte diese Stufe nicht.
function runDisplayStripTests() {
    section('Anzeige: Aktionsmarkup verschwindet vollstaendig');

    // 1. patch_file mit ueberzaehligem Zaun vor >>>REPLACE (laguna macht das)
    const patchKaputt = [
        'Ich erweitere zuerst den Tokenizer um die Erkennung von Bezeichnern.',
        '',
        '```action:patch_file',
        'path: src/tokenizer.js',
        '---',
        '<<<SEARCH',
        '  throw new Error(`Unerwartetes Zeichen`);',
        '```',
        '>>>REPLACE',
        '  if (ch === "_") {',
        '    tokens.push({ type: "ident" });',
        '  }',
        '```'
    ].join('\n');

    const sichtbar = engine.cleanForDisplay(patchKaputt);
    check('Ansage bleibt', sichtbar.includes('Ich erweitere zuerst den Tokenizer'), sichtbar);
    check('kein >>>REPLACE in der Anzeige', !sichtbar.includes('>>>REPLACE'), sichtbar);
    check('kein <<<SEARCH in der Anzeige', !sichtbar.includes('<<<SEARCH'), sichtbar);
    check('kein Quellcode in der Anzeige',
        !sichtbar.includes('tokens.push') && !sichtbar.includes('src/tokenizer.js'), sichtbar);

    // 2. Zwei Bloecke, dem ersten fehlt der Schluss-Zaun
    const zweiBloecke = [
        'Ich sehe mir beide Verzeichnisse an.',
        '',
        '```action:list_dir',
        'path: src',
        '```action:list_dir',
        'path: test',
        '```'
    ].join('\n');

    const sichtbar2 = engine.cleanForDisplay(zweiBloecke);
    check('Ansage bleibt (zwei Bloecke)',
        sichtbar2.includes('Ich sehe mir beide Verzeichnisse an'), sichtbar2);
    check('kein action:list_dir in der Anzeige',
        !sichtbar2.includes('action:list_dir'), sichtbar2);
    check('keine Argumentzeile in der Anzeige',
        !/^\s*path:/m.test(sichtbar2), sichtbar2);
    check('kein nackter Zaun uebrig', !sichtbar2.includes('```'), sichtbar2);

    // 3. Block ohne jeden Schluss-Zaun
    const ohneEnde = 'Ich lege die Datei an.\n\n```action:create_file\npath: a.ts\n---\nexport const a = 1;';
    const sichtbar3 = engine.cleanForDisplay(ohneEnde);
    check('Ansage bleibt (kein Schluss-Zaun)',
        sichtbar3.includes('Ich lege die Datei an'), sichtbar3);
    check('abgeschnittener Block ist weg',
        !sichtbar3.includes('create_file') && !sichtbar3.includes('export const a'), sichtbar3);

    // 4. Ein echter Code-Block in einer Antwort bleibt selbstverstaendlich stehen
    const echterCode = 'So geht das:\n\n```js\nconst a = 1;\n```\n\nFertig.';
    const sichtbar4 = engine.cleanForDisplay(echterCode);
    check('normaler Code-Block bleibt erhalten',
        sichtbar4.includes('const a = 1;') && sichtbar4.includes('```js'), sichtbar4);
    check('Text nach dem Code-Block bleibt', sichtbar4.includes('Fertig.'), sichtbar4);

    // 5. Und beide Bloecke muessen auch AUSGEFUEHRT werden, nicht nur
    //    verschwinden - sonst arbeitet der Assistent die Haelfte nicht ab.
    return engine.parseAndExecuteActions(zweiBloecke, async () => 'Ausführen').then(actions => {
        check('beide Bloecke ohne Zaun dazwischen werden ausgefuehrt',
            actions.length === 2, JSON.stringify(actions.map(a => a.description)));
        check('erster Block: src', actions[0] && /src/.test(actions[0].description),
            actions[0] && actions[0].description);
        check('zweiter Block: test', actions[1] && /test/.test(actions[1].description),
            actions[1] && actions[1].description);
    });
}

// ── Der Auftrag muss in JEDER Runde im Prompt stehen ────────────────────────
// Im Fenster-Lauf sollte der Assistent eine Webseite abrufen und drei Fragen
// beantworten. Ab Runde 2 sagte der Prompt nur "im Kontext der urspruenglichen
// Aufgabe" - das Modell suchte sich die Aufgabe aus dem Verlauf und griff die
// Testreparatur der Vorsitzung auf, obwohl "Aendere keine Dateien" im Auftrag
// stand. Seitdem wird der Auftrag jede Runde wortwoertlich mitgeschickt.
function runTaskAnchorTests(cfg) {
    section('Agenten-Schleife: Auftrag steht in jeder Runde');

    engine.lastActionSignature = '';
    engine.repeatCount = 0;
    engine.plan = [];
    engine.taskComplete = false;
    engine.currentTask = 'Rufe https://nodejs.org/api/test.html ab. Aendere keine Dateien.';

    const rounds = [
        ['Analyse', [{ type: 'analysis', description: 'read_file: a.ts', success: true, output: 'Inhalt' }]],
        ['Shell-Fehler', [{ type: 'shell', description: 'npm test', success: false, output: 'TS2304' }]],
        ['Befehlsausgabe', [{ type: 'shell', description: 'npm test', success: true, output: '11/11 gruen' }]],
        ['Patch gescheitert', [{ type: 'file_edit', description: 'Patch fehlgeschlagen: a.js',
                                success: false, output: 'Suchtext nicht gefunden' }]],
    ];

    for (const [label, actions] of rounds) {
        engine.lastActionSignature = '';
        engine.repeatCount = 0;
        const step = engine.planNextStep(actions, 1, cfg);
        check(`${label}: Auftrag im Prompt`,
            step !== null && step.prompt.includes('Aendere keine Dateien'),
            step ? step.prompt.slice(0, 100) : 'null');
        check(`${label}: als Auftrag ausgewiesen`,
            step !== null && step.prompt.includes('DEIN AUFTRAG'),
            step ? step.prompt.slice(0, 100) : 'null');
    }

    // Offener Plan
    engine.lastActionSignature = '';
    engine.repeatCount = 0;
    engine.handlePlanAction('- [ ] Seite abrufen\n- [ ] Fragen beantworten');
    const planStep = engine.planNextStep(
        [{ type: 'file_edit', description: 'Bearbeitet: a.ts', success: true }], 1, cfg);
    check('Plan-Runde: Auftrag im Prompt',
        planStep !== null && planStep.prompt.includes('Aendere keine Dateien'),
        planStep ? planStep.prompt.slice(0, 100) : 'null');

    // Ohne bekannten Auftrag darf kein leerer Block entstehen
    engine.plan = [];
    engine.currentTask = '';
    engine.lastActionSignature = '';
    engine.repeatCount = 0;
    const bare = engine.planNextStep(
        [{ type: 'analysis', description: 'read_file: a.ts', success: true, output: 'Inhalt' }], 1, cfg);
    check('ohne Auftrag kein leerer Kopf',
        bare !== null && !bare.prompt.includes('DEIN AUFTRAG')
        && bare.prompt.startsWith('ERGEBNISSE'),
        bare ? bare.prompt.slice(0, 60) : 'null');

    // ── Wiederhergestellter Verlauf ist Hintergrund, kein offener Auftrag ────
    // Frueher kamen die Runden der Vorsitzung als echte Gespraechsrunden zurueck,
    // die Assistenten-Turns mit vorangestelltem "[Vorheriges Reasoning]". Das
    // Modell ahmte diese Marker nach - sie standen sichtbar in der Chat-Antwort.
    section('Verlauf: Vorsitzung als Hintergrund-Notiz');

    const { HistoryManager } = require(path.join(PROJECT, 'out', 'historyManager.js'));
    const histDir = path.join(SANDBOX, 'histtest');
    fs.rmSync(histDir, { recursive: true, force: true });
    fs.mkdirSync(histDir, { recursive: true });

    const first = new HistoryManager(histDir);
    first.addUserMessage('Repariere die 6 roten Tests in test/evaluator.test.js');
    first.addAssistantMessage('Alle 11 Tests sind gruen.',
        [{ type: 'shell', description: 'Shell: npm test', success: true }],
        'Aufgabe: "Repariere die Tests"\nAusgefuehrte Aktionen: OK npm test');

    // Zwei Manager im selben Sekundentakt: die Kennungen muessen sich
    // unterscheiden, sonst schreibt die neue Sitzung in die alte und der
    // Verlauf der Vorsitzung ist weg (Sekundenauflösung war genau der Fehler).
    const second = new HistoryManager(histDir);
    check('zweite Sitzung hat eigene Kennung',
        second.getSessionId() !== first.getSessionId(),
        first.getSessionId() + ' / ' + second.getSessionId());

    const digest = second.getLastSessionDigest();
    check('Notiz vorhanden', typeof digest === 'string' && digest.length > 0, String(digest));
    check('Notiz nennt den alten Auftrag',
        digest.includes('evaluator.test.js'), String(digest));
    check('Notiz nennt das Ergebnis',
        digest.includes('11 Tests sind gruen'), String(digest));
    check('kein Reasoning-Marker in der Notiz',
        !digest.includes('[Vorheriges Reasoning]') && !digest.includes('[Antwort]'), String(digest));
    check('Notiz ist einzeilig pro Eintrag',
        digest.split('\n').every(l => l.startsWith('- ')), JSON.stringify(digest));

    // Laengenbegrenzung greift von hinten: das Neueste bleibt
    const shortDigest = second.getLastSessionDigest(60);
    check('Kuerzung behaelt den letzten Eintrag',
        shortDigest !== null && shortDigest.includes('11 Tests'), String(shortDigest));

    // Ohne Vorsitzung gibt es keine Notiz
    const emptyDir = path.join(SANDBOX, 'histempty');
    fs.rmSync(emptyDir, { recursive: true, force: true });
    fs.mkdirSync(emptyDir, { recursive: true });
    check('ohne Vorsitzung keine Notiz',
        new HistoryManager(emptyDir).getLastSessionDigest() === null);

    // Leere Sessions duerfen die letzte echte NICHT verdecken. Jedes Neuladen
    // des Fensters legt eine Session an - im Fenster-Lauf stand nach zwei
    // Reloads "History: 0 Nachrichten", obwohl der Verlauf da war.
    const third = new HistoryManager(histDir);    // legt leere Session an
    const fourth = new HistoryManager(histDir);   // dahinter noch eine
    const afterReloads = fourth.getLastSessionDigest();
    check('leere Sessions verdecken die letzte echte nicht',
        afterReloads !== null && afterReloads.includes('evaluator.test.js'),
        String(afterReloads));
    check('drei Reloads, Kennungen alle verschieden',
        new Set([first.getSessionId(), second.getSessionId(),
                 third.getSessionId(), fourth.getSessionId()]).size === 4);
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
