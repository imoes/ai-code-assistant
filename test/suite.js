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
    check('meldet gekuerzten Rest', part.output.includes('not shown'));

    // Tippfehler im Namen (Windows ist case-insensitiv, daher echter Schreibfehler)
    const missing = analyzer.readFile('src/services/userServic.ts');
    check('fehlende Datei -> Vorschlag',
        !missing.success && missing.output.includes('Did you mean')
        && missing.output.includes('userService.ts'),
        missing.output.replace(/\n/g, ' | ').slice(0, 160));

    let blocked;
    try { blocked = analyzer.readFile('../../../etc/passwd'); } catch (e) { blocked = { success: false, output: e.message }; }
    check('Workspace-Grenze haelt', !blocked.success, blocked.output.slice(0, 80));

    // ── Fuehrender Schraegstrich meint die Projektwurzel ─────────────────────
    // Im Fenster-Lauf schrieb das Modell alle Pfade als /src/tokenizer.js. Unter
    // Windows ist das laufwerksrelativ: daraus wurde C:\src\tokenizer.js,
    // ausserhalb des Workspace, abgelehnt. Sieben Lesevorgaenge in Folge
    // scheiterten, das Modell arbeitete eine ganze Runde blind.
    const withSlash = analyzer.readFile('/src/services/userService.ts');
    const without = analyzer.readFile('src/services/userService.ts');
    check('/pfad wird als workspace-relativ gelesen',
        withSlash.success && withSlash.output === without.output,
        withSlash.output.slice(0, 120));
    check('kein Sicherheitsfehler bei /pfad',
        !/Sicherheitsfehler|verweigert/.test(withSlash.output), withSlash.output.slice(0, 120));

    // Backslash-Pfade nur unter Windows: auf Linux ist "\" ein gueltiges
    // Zeichen in Dateinamen, "src\index.ts" waere dort ein anderer Name.
    if (process.platform === 'win32') {
        check('auch mit Backslash', analyzer.readFile('\\src\\index.ts').success);
    } else {
        check('fuehrender Backslash wird abgetrennt',
            require(path.join(PROJECT, 'out', 'fileManager.js'))
                .FileManager.stripRootSlash('\\src\\index.ts') === 'src\\index.ts');
    }

    // Ein absoluter Pfad IN den Workspace bleibt ein absoluter Pfad.
    //
    // Das ist der Fall, der die Pipeline zerlegt hat: unter WSL beginnt der
    // Workspace mit /mnt/d/, und den verschont die Regel ohnehin - auf dem
    // GitHub-Runner heisst er /home/runner/work/..., und da wurde der
    // fuehrende Schraegstrich abgetrennt. Aus dem absoluten Pfad wurde ein
    // relativer, und zwei Tests fielen um, die lokal auf beiden Systemen
    // gruen waren. Deshalb hier ausdruecklich mit der ECHTEN Wurzel geprueft.
    const { FileManager } = require(path.join(PROJECT, 'out', 'fileManager.js'));
    const fm = FileManager.getInstance();
    const echtAbsolut = path.join(SANDBOX, 'src', 'index.ts');
    check('absoluter Pfad in den Workspace bleibt unveraendert',
        fm.resolvePath(echtAbsolut) === path.resolve(echtAbsolut),
        `${fm.resolvePath(echtAbsolut)} != ${path.resolve(echtAbsolut)}`);
    check('und die Datei ist darueber lesbar',
        analyzer.readFile(echtAbsolut).success);

    // Auch die Wurzel selbst
    check('die Wurzel selbst ist erlaubt',
        fm.resolvePath(SANDBOX) === path.resolve(SANDBOX),
        fm.resolvePath(SANDBOX));

    // Ein ECHTER absoluter Pfad bleibt abgelehnt - der Schutz darf nicht fallen
    let abs;
    try { abs = analyzer.readFile('C:\\Windows\\win.ini'); }
    catch (e) { abs = { success: false, output: e.message }; }
    check('echter absoluter Pfad bleibt abgelehnt', !abs.success, abs.output.slice(0, 80));

    let wslAbs;
    try { wslAbs = analyzer.readFile('/mnt/c/Windows/win.ini'); }
    catch (e) { wslAbs = { success: false, output: e.message }; }
    check('WSL-Laufwerkspfad bleibt abgelehnt', !wslAbs.success, wslAbs.output.slice(0, 80));

    // ── Eine abgelehnte Analyse MUSS als Fehlschlag zurueckkommen ────────────
    // Vorher meldete handleAnalysisAction pauschal success:true. Die Schleife
    // hielt sieben abgelehnte Lesevorgaenge fuer getane Arbeit.
    check('fehlende Datei ist als Fehler markiert', missing.error === true,
        JSON.stringify({ success: missing.success, error: missing.error }));
    check('gelesene Datei ist NICHT als Fehler markiert', !without.error,
        JSON.stringify({ success: without.success, error: without.error }));

    // "Keine Treffer" ist KEIN Fehler - sonst gilt jede ergebnislose Suche als
    // Fehlschlag und die Schleife meldet sie zurueck, statt weiterzuarbeiten.
    const nothing = analyzer.grep('zzz_gibt_es_ganz_sicher_nicht_zzz');
    check('keine Treffer ist kein Fehler', !nothing.error,
        JSON.stringify({ success: nothing.success, error: nothing.error }));
    const noGlob = analyzer.glob('**/*.gibtsnicht');
    check('kein Glob-Treffer ist kein Fehler', !noGlob.error,
        JSON.stringify({ success: noGlob.success, error: noGlob.error }));
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
    check('kein Treffer sauber gemeldet', !none.success && none.output.includes('No matches'));

    const bad = analyzer.grep('([unclosed');
    check('ungueltiges Regex faengt', !bad.success && /regular expression/i.test(bad.output), bad.output.slice(0, 80));

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
    check('list_dir markiert Ignore-Ordner', dRoot.output.includes('node_modules/   (skipped)'),
        dRoot.output.slice(0, 200));

    const ov = analyzer.projectOverview();
    check('Overview erkennt npm', ov.includes('package.json') && ov.includes('npm test'), ov.slice(0, 200));
    check('Overview gruppiert Ordner', ov.includes('src/services/:'), ov.slice(0, 400));

    const dirAsFile = analyzer.readFile('src');
    check('read_file auf Ordner -> Listing', dirAsFile.success && dirAsFile.output.includes('Contents of'),
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
    check('list_dir Label relativ', d.description === 'list_dir: src → 2 entries', d.description);

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
    check('Handbuch erklaert Agenten-Schleife', manual.includes('agent loop'));
    check('Handbuch: erst lesen dann schreiben', manual.includes('Read before you write'));

    // ── Sprache: englische Anweisungen, Antwort in der Sprache der Anfrage ───
    // Englische Prompts, weil Modelle ihnen zuverlaessiger folgen. Die Antwort
    // muss davon unberuehrt bleiben - sonst antwortet ein Assistent mit
    // deutschem Bedienfeld ploetzlich englisch.
    const { LANGUAGE_RULE, TOOL_DEFINITIONS } = require(path.join(PROJECT, 'out', 'aiEngine.js'));
    const tools = require(path.join(PROJECT, 'out', 'toolCallParser.js'));

    check('Sprachregel steht am Anfang des Handbuchs',
        manual.startsWith(LANGUAGE_RULE), manual.slice(0, 80));
    check('Sprachregel verlangt die Sprache der Anfrage',
        /language they used in their request/.test(LANGUAGE_RULE), LANGUAGE_RULE);
    check('Sprachregel nennt Ansage, Plan und Abschluss',
        /announcing each action/.test(LANGUAGE_RULE)
        && /plan items/.test(LANGUAGE_RULE)
        && /closing summary/.test(LANGUAGE_RULE), LANGUAGE_RULE);
    check('Sprachregel nimmt Code und Pfade aus',
        /Identifiers, code, file paths/.test(LANGUAGE_RULE), LANGUAGE_RULE);

    // Das Handbuch selbst ist englisch: kein deutscher Anweisungssatz mehr.
    // Geprueft an Woertern, die nur in Anweisungen vorkommen.
    for (const deutsch of ['Nutze das', 'Arbeite ', 'Schreibe vor jedem',
                           'Gib bei jeder', 'Halte dich an', 'Verwende Aktions']) {
        check(`Handbuch ohne deutschen Anweisungstext: "${deutsch}"`,
            !manual.includes(deutsch),
            manual.slice(Math.max(0, manual.indexOf(deutsch) - 40), manual.indexOf(deutsch) + 60));
    }

    // Werkzeugkatalog: englische Beschreibungen, aber der WERT von `absicht`
    // gehoert in die Sprache des Benutzers - der Satz landet direkt im Chat.
    for (const t of tools.TOOL_DEFINITIONS) {
        check(`${t.name}: Beschreibung englisch`,
            !/[äöüß]/i.test(t.description), t.description);
        check(`${t.name}: absicht verlangt die Benutzersprache`,
            /language the user used/.test(t.parameters.properties.absicht.description),
            t.parameters.properties.absicht.description);
    }
    const done = tools.TOOL_DEFINITIONS.find(t => t.name === 'done');
    check('done: Abschlusstext in der Benutzersprache und als Markdown',
        /language the user used/.test(done.parameters.properties.zusammenfassung.description)
        && /Markdown/.test(done.parameters.properties.zusammenfassung.description),
        done.parameters.properties.zusammenfassung.description);

    // ── Jede ausfuehrbare Aktion muss im KATALOG stehen ─────────────────────
    // Der Fehler, der das hier noetig macht: `remember` stand im Handbuchtext,
    // aber nicht in TOOL_DEFINITIONS. Mit nativeToolCalls (Standard) sieht das
    // Modell nur den Katalog - im Lauf gegen laguna wurde das Werkzeug also nie
    // aufgerufen, und die Datei mit den gelernten Regeln blieb leer. Kein Test
    // hat das gesehen, weil beide Seiten einzeln stimmten.
    const catalogue = new Set(tools.TOOL_DEFINITIONS.map(t => t.name));

    // `todo` und `finish` sind Zweitnamen von `plan` und `done` - sie werden
    // ausgefuehrt, brauchen aber keinen eigenen Katalogeintrag.
    const aliases = new Set(['todo', 'finish']);

    for (const action of tools.KNOWN_ACTIONS) {
        if (aliases.has(action)) continue;
        check(`Katalog kennt '${action}'`, catalogue.has(action),
            `fehlt in TOOL_DEFINITIONS – mit nativeToolCalls unsichtbar fuer das Modell`);
    }

    // Und umgekehrt: ein Katalogeintrag ohne Ausfuehrung waere ein Werkzeug,
    // das das Modell aufruft und das nichts tut.
    for (const name of catalogue) {
        check(`'${name}' ist eine bekannte Aktion`, tools.KNOWN_ACTIONS.has(name),
            'steht im Katalog, wird aber nicht ausgefuehrt');
    }
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
    check('Beschreibung zaehlt', r.description === 'Plan: 1/4 done', r.description);

    const r2 = engine.handlePlanAction('1. [ ] Erster\n2. [x] Zweiter\n* [ ] Dritter\n- Vierter ohne Box');
    check('nummerierte + gemischte Listen', engine.getPlan().length === 4, JSON.stringify(engine.getPlan()));

    let threw = false;
    try { engine.handlePlanAction('nur freier Text ohne Liste'); } catch { threw = true; }
    check('leerer Plan wirft', threw);

    check('Plan-Kontext im Prompt', engine.buildPlanContext().includes('Current work plan'),
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
    check('grep ignore_case Feld', d.output.includes('match'), d.description);

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

    return engine.parseAndExecuteActions(response, async () => 'Run').then(actions => {
        check('3 Bloecke ausgefuehrt', actions.length === 3, JSON.stringify(actions.map(a => a.type)));
        check('read_file zuerst', actions[0].type === 'analysis', actions[0].type);
        check('grep als zweites', actions[1].type === 'analysis', actions[1].description);
        check('plan als drittes', actions[2].type === 'plan', actions[2].type);

        // XML-Variante (Gemma/Qwen schreiben manchmal Tags)
        return engine.parseAndExecuteActions(
            '<action:read_file>\npath: src/index.ts\n</action:read_file>', async () => 'Run');
    }).then(actions => {
        check('XML-Tag-Variante normalisiert', actions.length === 1 && actions[0].type === 'analysis',
            JSON.stringify(actions));

        return engine.parseAndExecuteActions(
            '```action:done\nzusammenfassung: Bug behoben und getestet.\n```', async () => 'Run');
    }).then(actions => {
        check('done-Aktion erkannt', actions.length === 1 && actions[0].description.includes('complete'),
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
            /ALREADY PRESENT/.test(already) && /Do not repeat this patch/.test(already),
            already.slice(0, 140));

        // Fall 2: erste Zeile passt, Folgezeilen nicht
        const partial = fm.explainPatchMiss(
            'a.js', content,
            'function f() {\n    // ganz anderer Inhalt\n}',
            'egal');
        check('Diagnose: erste Zeile passt, Rest nicht',
            /FIRST line matches/.test(partial) && /line 1:/.test(partial),
            partial.slice(0, 200));

        // Fall 3: gar nichts passt
        const nothing = fm.explainPatchMiss('a.js', content, 'völlig anderer Code', 'egal');
        check('Diagnose: Datei sieht anders aus',
            /looks different/.test(nothing) && /read_file/.test(nothing),
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
    return engine.parseAndExecuteActions(modelOutput, async () => 'Apply').then(actions => {
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
        return engine.parseAndExecuteActions(multi, async () => 'Apply');
    }).then(actions => {
        const after = fs.readFileSync(target, 'utf-8');
        check('zwei Patches in einem Block', actions[0] && actions[0].success === true,
            JSON.stringify(actions));
        check('beide Aenderungen drin',
            after.includes('"c"') && /i\s*<\s*this\.users\.length/.test(after),
            after.split('\n').slice(1, 7).join(' | '));

        // End-zu-Ende mit Abschluss-Marker: nichts davon darf in der Datei landen
        fs.writeFileSync(target, buggy);
        return engine.parseAndExecuteActions(withTerminator, async () => 'Apply');
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
    return engine.parseAndExecuteActions(lagunaOutput, async () => 'Apply').then(actions => {
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
            /compacted|shortened/i.test(String(n)), String(n));

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
// ── Jede Einstellung an BEIDEN Stellen ──────────────────────────────────────
// Die Konvention steht in AGENTS.md: neue Einstellungen gehoeren in
// package.json UND ins Einstellungsfenster. `shell` und `allowPowerShell`
// standen nur in package.json - wer das Fenster benutzt, konnte die Shell
// nicht waehlen und wusste nicht, dass es die Wahl gibt.
function runSettingsCoverageTests() {
    section('Einstellungen: package.json und Fenster deckungsgleich');

    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT, 'package.json'), 'utf-8'));
    const declared = Object.keys(pkg.contributes.configuration.properties)
        .map(k => k.replace(/^aiAssistant\./, ''));

    const panelSrc = fs.readFileSync(path.join(PROJECT, 'src', 'settingsPanel.ts'), 'utf-8');
    const inPanel = new Set(
        [...panelSrc.matchAll(/key:\s*'([a-zA-Z]+)'/g)].map(m => m[1]));

    // Veraltetes bleibt absichtlich draussen - es soll niemand neu setzen.
    const ABSICHTLICH_DRAUSSEN = new Set(['autoApply']);

    const fehlend = declared.filter(k => !inPanel.has(k) && !ABSICHTLICH_DRAUSSEN.has(k));
    check('keine Einstellung fehlt im Fenster', fehlend.length === 0,
        fehlend.join(', '));

    // Und umgekehrt: das Fenster darf nichts anbieten, was es nicht gibt
    const erfunden = [...inPanel].filter(k => !declared.includes(k));
    check('das Fenster erfindet keine Einstellung', erfunden.length === 0,
        erfunden.join(', '));

    // Der Hinweis ueber dem Shell-Abschnitt sagt die Wahrheit ueber DIESEN Rechner
    const { SettingsPanel } = require(path.join(PROJECT, 'out', 'settingsPanel.js'));
    const { ShellRunner } = require(path.join(PROJECT, 'out', 'shellRunner.js'));

    ShellRunner.resetEnvironment();
    ShellRunner.envCache = { platform: 'linux', wsl: false, powershell: false, bash: true };
    const linuxHint = SettingsPanel.shellHint();
    check('Hinweis nennt Linux', /This is Linux/.test(linuxHint), linuxHint);
    check('Hinweis sagt, dass die zwei Optionen nichts tun',
        /do nothing/.test(linuxHint), linuxHint);

    ShellRunner.envCache = { platform: 'windows', wsl: false, powershell: true, bash: false };
    const noWslHint = SettingsPanel.shellHint();
    check('Hinweis nennt Windows ohne WSL', /WITHOUT WSL/.test(noWslHint), noWslHint);
    check('und nennt den Weg dahin', /wsl --install/.test(noWslHint), noWslHint);

    ShellRunner.envCache = { platform: 'windows', wsl: true, powershell: true, bash: false };
    check('Hinweis nennt beide Shells',
        /both shells are available/.test(SettingsPanel.shellHint()));

    ShellRunner.resetEnvironment();
}

function runModeConsistencyTests() {
    runSettingsCoverageTests();
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
        s1 && s1.prompt.includes('RESULTS OF YOUR CODE ANALYSIS'), s1 && s1.prompt.slice(0, 80));

    // Shell-Fehler -> Reparatur, und zwar VOR der Analyse-Auswertung
    const s2 = engine.planNextStep([
        { type: 'analysis', description: 'read_file: a.ts', success: true, output: 'Inhalt' },
        { type: 'shell', description: 'Shell: npm test', success: false, output: 'TS2304: Cannot find name' }
    ], 1, cfg);
    check('Shell-Fehler hat Vorrang', s2 && s2.prompt.includes('ERROR ANALYSIS'), s2 && s2.reason);

    // Benutzer-Anweisung
    const s3 = engine.planNextStep([
        { type: 'shell', description: 'Abgelehnt: rm -rf /', success: false,
          output: 'Instruction from the user: use npm ci instead' }
    ], 1, cfg);
    check('Benutzer-Anweisung erkannt', s3 && s3.prompt.includes('THE USER GAVE YOU AN INSTRUCTION'),
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
    check('offener Plan treibt Schleife', s5 !== null && s5.prompt.includes('CONTINUE THE PLAN'),
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
        f1 !== null && f1.prompt.includes('WAS NOT APPLIED'), f1 && f1.reason);
    check('Prompt warnt vor Wiederholung',
        f1 && f1.prompt.includes('Do NOT repeat the same call'), f1 && f1.prompt.slice(0, 120));
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
    return runOutputCapTests(cfg).then(() => runBareActionTests());
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
        step && /characters omitted/.test(step.prompt));
    check('Kuerzung sagt, wie man den Rest bekommt',
        step && /read_file mit offset|grep/.test(step.prompt));

    // Kurze Ausgaben bleiben unangetastet
    engine.lastActionSignature = '';
    engine.repeatCount = 0;
    const kurz = engine.planNextStep(
        [{ type: 'shell', description: 'Shell: npm test', success: true, output: '11 gruen' }], 1, cfg);
    check('kurze Ausgabe unverandert',
        kurz && kurz.prompt.includes('11 gruen') && !/ausgelassen/.test(kurz.prompt));

    return runVerifyAfterChangeTests(cfg);
}

// ── Zwei Shells: WSL und PowerShell ─────────────────────────────────────────
// Manche Aufgaben gehen nur in einer: `npm test` gehoert nach WSL, ein
// Get-Service nur in die PowerShell. Der Assistent waehlt pro Befehl.
function runShellChoiceTests() {
    section('Shell: WSL oder PowerShell');

    const { AIEngine } = require(path.join(PROJECT, 'out', 'aiEngine.js'));
    const { ShellRunner } = require(path.join(PROJECT, 'out', 'shellRunner.js'));

    // Block ohne Kopfzeile: reiner Befehl, Shell nach Einstellung
    const plain = AIEngine.parseShellBlock('npm test');
    check('ohne Kopfzeile: auto', plain.shellKind === 'auto', plain.shellKind);
    check('ohne Kopfzeile: Befehl unveraendert', plain.command === 'npm test', plain.command);

    // Kopfzeile powershell, mit und ohne Trenner
    for (const raw of ['shell: powershell\nGet-Service Spooler',
                       'shell: powershell\n---\nGet-Service Spooler',
                       'shell: PowerShell\nGet-Service Spooler',
                       'shell: pwsh\nGet-Service Spooler']) {
        const p = AIEngine.parseShellBlock(raw);
        check(`Kopfzeile erkannt: ${JSON.stringify(raw.split('\n')[0])}`,
            p.shellKind === 'powershell' && p.command.trim() === 'Get-Service Spooler',
            JSON.stringify(p));
    }

    const wsl = AIEngine.parseShellBlock('shell: wsl\nnpm test');
    check('Kopfzeile wsl', wsl.shellKind === 'wsl' && wsl.command.trim() === 'npm test',
        JSON.stringify(wsl));

    // Ein Befehl, der zufaellig mit "shell:" anfaengt, ist keine Kopfzeile
    const notHead = AIEngine.parseShellBlock('shell: gibtsnicht\necho hallo');
    check('unbekannter Wert ist keine Kopfzeile',
        notHead.shellKind === 'auto' && notHead.command.startsWith('shell: gibtsnicht'),
        JSON.stringify(notHead));

    // Aufloesung: was am Ende laeuft
    const cfgAuto = { get: (k, d) => (k === 'shell' ? 'auto' : d) };
    const cfgPs = { get: (k, d) => (k === 'shell' ? 'powershell' : d) };
    const onWindows = process.platform === 'win32';

    // Die Aufloesung wird unten fuer jede Umgebung einzeln geprueft - mit
    // gestellter Plattform, damit nicht nur der Rechner getestet wird, auf dem
    // die Tests gerade laufen. Hier nur der Fall, der auf JEDEM System gilt:
    // eine POSIX-Shell kommt immer heraus, niemals nichts.
    check('wsl angefordert liefert eine POSIX-Shell',
        ['wsl', 'bash', 'powershell'].includes(ShellRunner.resolveShell('wsl', cfgAuto)),
        ShellRunner.resolveShell('wsl', cfgAuto));
    check('auto liefert immer eine nutzbare Shell',
        ['wsl', 'bash', 'powershell'].includes(ShellRunner.resolveShell('auto', cfgAuto)),
        ShellRunner.resolveShell('auto', cfgAuto));

    // Aufrufparameter
    const [psExe, psArgs] = ShellRunner.spawnArgs('powershell', 'Get-Date');
    check('PowerShell wird als powershell.exe gestartet', psExe === 'powershell.exe', psExe);
    check('PowerShell ohne Profil', psArgs.includes('-NoProfile'), JSON.stringify(psArgs));
    check('PowerShell nicht interaktiv', psArgs.includes('-NonInteractive'), JSON.stringify(psArgs));
    check('PowerShell bekommt den Befehl',
        psArgs[psArgs.length - 1] === 'Get-Date', JSON.stringify(psArgs));

    const [wslExe, wslArgs] = ShellRunner.spawnArgs('wsl', 'npm test');
    check('WSL ueber bash -c', wslExe === 'wsl' && wslArgs[0] === 'bash' && wslArgs[1] === '-c',
        JSON.stringify([wslExe, wslArgs]));

    // Quoting: einfache Anfuehrungszeichen verdoppeln, nicht mit Backslash
    check('PowerShell-Quoting verdoppelt Apostrophe',
        ShellRunner.escapePsArg("D:\\Otto's Ordner") === "'D:\\Otto''s Ordner'",
        ShellRunner.escapePsArg("D:\\Otto's Ordner"));

    // ── Das Handbuch beschreibt NUR, was dieser Rechner kann ────────────────
    // Vorher nannte es immer beide Wege, WSL und PowerShell, egal worauf der
    // Assistent lief. Unter Linux ist das eine Einladung zum Scheitern: das
    // Modell liest von `shell: powershell`, greift danach, und der Befehl
    // stirbt an ENOENT. Windows ohne WSL ist der Spiegelfall.
    //
    // Geprueft werden alle drei Umgebungen, nicht nur die, auf der die Tests
    // gerade laufen - sonst faellt genau der Fall durch, der den Fehler hat.
    const setEnv = (platform, wsl, powershell, bash) => {
        ShellRunner.resetEnvironment();
        ShellRunner.envCache = { platform, wsl, powershell, bash };
    };

    // 1. Windows mit WSL: beide Wege, und die Wahl zaehlt
    setEnv('windows', true, true, false);
    const winBoth = AIEngine.shellManual();
    check('Windows+WSL: nennt das Betriebssystem', /You are on Windows/.test(winBoth), winBoth.slice(0, 80));
    check('Windows+WSL: nennt die Kopfzeile', winBoth.includes('shell: powershell'), 'fehlt');
    check('Windows+WSL: warnt vor der Syntax',
        /no `&&`/.test(winBoth) && /Get-ChildItem/.test(winBoth), 'fehlt');
    check('Windows+WSL: bevorzugt WSL', /Prefer WSL/.test(winBoth), 'fehlt');
    check('Windows+WSL: nennt die Pfadformen',
        /\/mnt\/<drive>/.test(winBoth), 'fehlt');
    check('Windows+WSL: erlaubt die Rueckfrage',
        /ask_user/.test(winBoth) && /Which shell should run this/.test(winBoth), 'fehlt');

    // Das Beispiel im Handbuch muss der Parser auch lesen koennen - ein
    // Beispiel im falschen Format bringt das Modell dazu, es falsch zu schreiben.
    const beispiel = /```action:ask_user\n([\s\S]*?)```/.exec(winBoth);
    check('Beispiel-Block im Handbuch gefunden', beispiel !== null);
    if (beispiel) {
        const geparst = AIEngine.parseAskBlock(beispiel[1]);
        check('Beispiel liefert die Frage',
            /Which shell/.test(geparst.question), JSON.stringify(geparst.question));
        check('Beispiel liefert genau zwei Optionen',
            geparst.options.length === 2,
            JSON.stringify(geparst.options.map(o => o.label)));
        check('Optionen heissen WSL und PowerShell',
            geparst.options[0].label === 'WSL' && geparst.options[1].label === 'PowerShell',
            JSON.stringify(geparst.options.map(o => o.label)));
        check('und jede Option hat eine Erklaerung',
            geparst.options.every(o => o.description && o.description.length > 5),
            JSON.stringify(geparst.options));
    }

    // 2. Windows OHNE WSL: PowerShell ist alles, was da ist
    setEnv('windows', false, true, false);
    const winPs = AIEngine.shellManual();
    check('Windows ohne WSL: sagt, dass WSL fehlt', /WSL is NOT installed/.test(winPs), winPs.slice(0, 90));
    check('Windows ohne WSL: verbietet die Kopfzeile',
        !winPs.includes('shell: powershell') && /leave it out/.test(winPs), winPs.slice(0, 200));
    check('Windows ohne WSL: warnt vor POSIX-Befehlen',
        /Get-Content/.test(winPs) && /use `;`/.test(winPs), 'fehlt');
    check('Windows ohne WSL: fragt NICHT nach der Shell',
        !/ask_user/.test(winPs), 'bietet eine Wahl, die es nicht gibt');

    // 3. Linux: keine PowerShell, kein WSL
    setEnv('linux', false, false, true);
    const linux = AIEngine.shellManual();
    check('Linux: nennt das Betriebssystem', /You are on Linux/.test(linux), linux.slice(0, 80));
    check('Linux: nennt PowerShell NICHT als Weg',
        !linux.includes('shell: powershell'), 'nennt eine Shell, die es nicht gibt');
    check('Linux: sagt ausdruecklich, dass es sie nicht gibt',
        /no WSL and no PowerShell/.test(linux), linux.slice(0, 200));
    check('Linux: nennt POSIX-Werkzeuge', /systemctl/.test(linux), 'fehlt');
    check('Linux: fragt NICHT nach der Shell', !/ask_user/.test(linux), 'fragt ohne Wahl');

    // 4. macOS wird als macOS benannt, nicht als Linux
    setEnv('macos', false, false, true);
    check('macOS: nennt das Betriebssystem', /You are on macOS/.test(AIEngine.shellManual()));

    // 5. Windows ohne alles: sagen, dass es nicht geht, statt etwas zu erfinden
    setEnv('windows', false, false, false);
    const nix = AIEngine.shellManual();
    check('Windows ohne Shell: benennt die Lage',
        /neither WSL nor PowerShell/.test(nix), nix.slice(0, 120));
    check('Windows ohne Shell: verweist auf die anderen Werkzeuge',
        /reading and writing tools/.test(nix), 'fehlt');

    // ── Und die Auflösung haelt sich an dieselbe Wahrheit ───────────────────
    // Der eigentliche Fehler sass hier: `shell: powershell` wurde auf JEDEM
    // System woertlich genommen. Unter Linux hiess das powershell.exe starten.
    setEnv('linux', false, false, true);
    check('Linux: powershell angefordert -> bash',
        ShellRunner.resolveShell('powershell', cfgAuto) === 'bash',
        ShellRunner.resolveShell('powershell', cfgAuto));
    check('Linux: Einstellung powershell -> bash',
        ShellRunner.resolveShell('auto', cfgPs) === 'bash');

    setEnv('windows', true, true, false);
    check('Windows+WSL: powershell angefordert -> powershell',
        ShellRunner.resolveShell('powershell', cfgAuto) === 'powershell');
    check('Windows+WSL: auto -> wsl', ShellRunner.resolveShell('auto', cfgAuto) === 'wsl');

    // Windows ohne WSL: der Befehl geht in die PowerShell statt ins Leere
    setEnv('windows', false, true, false);
    check('Windows ohne WSL: auto -> powershell',
        ShellRunner.resolveShell('auto', cfgAuto) === 'powershell',
        ShellRunner.resolveShell('auto', cfgAuto));
    check('Windows ohne WSL: wsl angefordert -> powershell',
        ShellRunner.resolveShell('wsl', cfgAuto) === 'powershell',
        ShellRunner.resolveShell('wsl', cfgAuto));

    // Und die echte Erkennung liefert etwas Brauchbares
    ShellRunner.resetEnvironment();
    const echt = ShellRunner.environment();
    check('echte Erkennung nennt die Plattform',
        ['windows', 'linux', 'macos'].includes(echt.platform), echt.platform);
    check('echte Erkennung passt zu process.platform',
        (process.platform === 'win32') === (echt.platform === 'windows'), echt.platform);
    check('unter Linux keine PowerShell erkannt',
        process.platform === 'win32' || echt.powershell === false, JSON.stringify(echt));

    // ── Der Umschalter im Bestaetigungsdialog ───────────────────────────────
    // Die Frage "WSL oder PowerShell?" haengt am Befehl, nicht an einer
    // Voreinstellung: `npm test` gehoert nach WSL, `Get-Service` geht nur in
    // der PowerShell. Deshalb wird sie bei JEDEM Befehl mitangeboten - der
    // Umweg ueber "Something else" kostet eine ganze Runde.
    const src = fs.readFileSync(path.join(PROJECT, 'src', 'aiEngine.ts'), 'utf-8');
    check('Dialog bietet den Wechsel an',
        /Run in PowerShell|Run in WSL/.test(src), 'fehlt');
    check('der Wechsel gilt nicht als Ablehnung',
        /choice !== 'Run' && choice !== switchLabel/.test(src), 'fehlt');
    check('ausgefuehrt wird mit der GEWAEHLTEN Shell',
        /shellRunner\.run\([^)]*effectiveKind\)/.test(src),
        'run() bekommt noch shellKind statt effectiveKind');
    check('die Werkzeugzeile nennt die tatsaechliche Shell',
        /resolveShell\(effectiveKind, config\)/.test(src), 'fehlt');
    check('Wechsel nur bei installierter Gegenseite',
        /env\.wsl && env\.powershell/.test(src.slice(src.indexOf('const otherAvailable'),
                                                     src.indexOf('const switchLabel'))),
        'der Dialog prueft nicht, ob die andere Shell da ist');
}

// ── Entscheidungsfrage an den Benutzer ──────────────────────────────────────
// Vorbild ist der Frage-Dialog im Claude-Code-Plugin: Frage, 2-4 Optionen mit
// Beschriftung und Erklaerung, Einfach- oder Mehrfachauswahl, Freitext.
function runAskUserTests() {
    section('ask_user: Entscheidung beim Benutzer');

    const { AIEngine } = require(path.join(PROJECT, 'out', 'aiEngine.js'));

    const block = [
        'header: Bibliothek',
        'question: Welche Datumsbibliothek soll das Projekt nutzen?',
        'multi: false',
        'options:',
        'date-fns — klein, modular, ueblich in neuen Projekten',
        'Luxon — Zeitzonen eingebaut, groesseres Bundle',
        'Keine — die zwei Helfer selbst schreiben'
    ].join('\n');

    const req = AIEngine.parseAskBlock(block);
    check('Etikett gelesen', req.header === 'Bibliothek', req.header);
    check('Frage gelesen', /Datumsbibliothek/.test(req.question), req.question);
    check('Einfachauswahl', req.multi === false, String(req.multi));
    check('drei Optionen', req.options.length === 3, JSON.stringify(req.options));
    check('Beschriftung getrennt', req.options[0].label === 'date-fns', req.options[0].label);
    check('Erklaerung getrennt',
        req.options[0].description === 'klein, modular, ueblich in neuen Projekten',
        req.options[0].description);
    check('Option ohne Erklaerung erlaubt',
        AIEngine.parseAskBlock('question: X\noptions:\nJa\nNein').options[1].label === 'Nein');

    // Mehrfachauswahl und Aufzaehlungszeichen
    const multi = AIEngine.parseAskBlock(
        'question: Welche Features?\nmehrfach: ja\noptions:\n- Login - mit OAuth\n- Export - als CSV');
    check('Mehrfachauswahl erkannt', multi.multi === true, String(multi.multi));
    check('Aufzaehlungszeichen entfernt', multi.options[0].label === 'Login', multi.options[0].label);
    check('Trenner " - " erkannt', multi.options[0].description === 'mit OAuth',
        multi.options[0].description);

    // Hoechstens vier Optionen - wie bei Claude Code
    const many = AIEngine.parseAskBlock(
        'question: X\noptions:\nA\nB\nC\nD\nE\nF');
    check('hoechstens vier Optionen', many.options.length === 4, String(many.options.length));

    // Kopfzeilen landen NICHT als Optionen
    check('Kopfzeilen sind keine Optionen',
        !req.options.some(o => /^(header|question|multi)/i.test(o.label)),
        JSON.stringify(req.options.map(o => o.label)));

    // Ohne Frage: Fehler statt stiller Leerlauf
    let threw = false;
    return engine.parseAndExecuteActions(
        '```action:ask_user\noptions:\nJa\nNein\n```', async () => 'Ja'
    ).then(actions => {
        check('ask_user ohne Frage meldet einen Fehler',
            actions.length === 1 && !actions[0].success
            && /question/.test(String(actions[0].output)),
            JSON.stringify(actions));

        // Mit Callback: die Antwort geht als ERFOLGREICHE Aktion mit Ausgabe
        // zurueck - nur so treibt sie die Schleife weiter.
        let gefragt = null;
        engine.setAskCallback(async (r) => { gefragt = r; return 'date-fns'; });
        return engine.parseAndExecuteActions(
            '```action:ask_user\n' + block + '\n```', async () => 'egal');
    }).then(actions => {
        check('Frage wurde gestellt', actions.length === 1, JSON.stringify(actions));
        check('Antwort ist erfolgreich', actions[0].success, JSON.stringify(actions[0]));
        check('Antwort steht in der Ausgabe',
            /date-fns/.test(actions[0].output), actions[0].output);
        check('Ausgabe verbietet die Wiederholung',
            /Do not ask again/.test(actions[0].output), actions[0].output);
        check('Beschreibung nennt die Entscheidung',
            /Entscheidung/.test(actions[0].description), actions[0].description);

        // Die Antwort muss die Schleife weitertreiben (Zweig 3)
        const cfg2 = vscode.workspace.getConfiguration();
        engine.lastActionSignature = '';
        engine.repeatCount = 0;
        engine.plan = [];
        engine.taskComplete = false;
        const step = engine.planNextStep(actions, 1, cfg2);
        check('Antwort treibt die Schleife weiter', step !== null, JSON.stringify(step));
        check('Folge-Prompt enthaelt die Antwort',
            step && /date-fns/.test(step.prompt), step && step.prompt.slice(0, 200));

        // Abbruch: keine Endlosschleife aus Fragen
        engine.setAskCallback(async () => '');
        return engine.parseAndExecuteActions(
            '```action:ask_user\n' + block + '\n```', async () => 'egal');
    }).then(actions => {
        check('abgebrochene Frage gilt als Fehlschlag', !actions[0].success,
            JSON.stringify(actions[0]));
        check('Abbruch weist auf Selbstentscheiden hin',
            /decide yourself/.test(actions[0].output), actions[0].output);
        engine.setAskCallback(undefined);
    });
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
        [{ type: 'file_edit', description: 'Patched: src/tokenizer.js (1 change)', success: true }],
        1, cfg);

    check('Aenderung ohne Test treibt die Schleife weiter', step !== null, JSON.stringify(step));
    check('Prompt fordert die Tests an',
        step && /tests now/.test(step.prompt), step && step.prompt.slice(0, 120));
    check('Prompt nennt die geaenderte Datei',
        step && step.prompt.includes('src/tokenizer.js'), step && step.prompt.slice(0, 200));
    check('Prompt erinnert an offene Punkte',
        step && /points of the task are still open/.test(step.prompt), step && step.prompt.slice(-200));
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
        mitTest !== null && !/VERIFIED NOTHING/.test(mitTest.prompt),
        mitTest && mitTest.prompt.slice(0, 80));

    // Gescheiterte Aenderung zaehlt nicht als Aenderung: dafuer ist Zweig 1b da
    engine.lastActionSignature = '';
    engine.repeatCount = 0;
    const gescheitert = engine.planNextStep(
        [{ type: 'file_edit', description: 'Patch fehlgeschlagen: a.js', success: false, output: 'nope' }],
        1, cfg);
    check('gescheiterte Aenderung geht in die Fehlerrueckmeldung',
        gescheitert !== null && /WAS NOT APPLIED/.test(gescheitert.prompt),
        gescheitert && gescheitert.prompt.slice(0, 80));

    // Ist die KI fertig, wird nicht nachgefragt
    engine.taskComplete = true;
    check('action:done beendet trotz ungepruefter Aenderung',
        engine.planNextStep(
            [{ type: 'file_edit', description: 'Gepacht: a.ts', success: true }], 1, cfg) === null);
    engine.taskComplete = false;

    vscode.__settings.autoTest = vorher;

    // ── Eine Runde, die nur den Plan umschreibt, ist keine Arbeit ───────────
    // Im Fenster-Lauf sagte der Assistent "ich fuehre jetzt die Tests aus" und
    // schickte nur einen Plan, in dem der Testschritt abgehakt war. Fuer die
    // Schleife sah das nach Fortschritt aus.
    engine.lastActionSignature = '';
    engine.repeatCount = 0;
    engine.plan = [{ text: 'Tests ausfuehren', status: 'done' }];
    const nurPlan = engine.planNextStep(
        [{ type: 'plan', description: 'Plan: 1/1 erledigt', success: true }], 1, cfg);
    check('Plan allein wird benannt',
        nurPlan !== null && /ONLY UPDATED BOOKKEEPING/.test(nurPlan.prompt),
        nurPlan && nurPlan.prompt.slice(0, 90));
    check('und der Testlauf eingefordert',
        nurPlan !== null && /action:shell/.test(nurPlan.prompt),
        nurPlan && nurPlan.prompt);

    // Plan PLUS echte Arbeit ist Arbeit - dann greift der Zweig nicht
    engine.lastActionSignature = '';
    engine.repeatCount = 0;
    const planUndArbeit = engine.planNextStep([
        { type: 'plan', description: 'Plan: 1/2 erledigt', success: true },
        { type: 'shell', description: 'npm test', success: true, output: '11/11 gruen' }
    ], 1, cfg);
    check('Plan mit echter Arbeit greift den Zweig nicht',
        planUndArbeit !== null && !/BOOKKEEPING/.test(planUndArbeit.prompt),
        planUndArbeit && planUndArbeit.reason);
    engine.plan = [];

    runShellChoiceTests();
    runCommandTests();
    runCallbackWiringTests();
    return runAskUserTests().then(() => runQueueTests());
}

// ── Beide Bahnen muessen ALLE Rueckmeldewege setzen ─────────────────────────
// Der Fehler, der das noetig macht: die /loop-Bahn setzte nur zwei der fuenf
// Callbacks. In der Schleife fehlte darum die Token-Statistik - der Benutzer sah
// minutenlang "KI denkt..." ohne jede Zahl. Beide Bahnen rufen jetzt
// bindEngineCallbacks() auf; dieser Test haelt fest, dass keine davon
// eigenmaechtig einzelne Callbacks setzt.
function runCallbackWiringTests() {
    section('Chat-Panel: alle Rueckmeldewege gesetzt');

    const src = fs.readFileSync(path.join(PROJECT, 'src', 'chatPanel.ts'), 'utf-8');

    // Beide Bahnen binden ueber die gemeinsame Stelle
    const calls = (src.match(/this\.bindEngineCallbacks\(\)/g) || []).length;
    check('runUserMessage und runLoopTask binden gemeinsam', calls >= 2, String(calls));

    // Die einzelnen Setter kommen NUR in bindEngineCallbacks vor. Ein zweiter
    // Aufruf woanders heisst: eine Bahn setzt von Hand und kann etwas vergessen.
    for (const setter of ['setStatsCallback', 'setNarrationCallback', 'setAskCallback',
                          'setPlanCallback', 'setDiffReporter']) {
        const n = (src.match(new RegExp(`\\.${setter}\\(`, 'g')) || []).length;
        check(`${setter} nur an einer Stelle`, n === 1,
            `${n}x gefunden – gehoert ausschliesslich in bindEngineCallbacks`);
    }

    // Auch der Token-Strom gehoert BEIDEN Bahnen. Die Schleife gab hier lange
    // einen leeren Callback mit ("der Rundentext kommt ja als Ansage") - im
    // Fenster hiess das: zwei Minuten "Antwort wird erzeugt... 1.6k Tok" und
    // kein Zeichen im Chat. Ein Reasoning-Modell verbringt genau dort die
    // meiste Zeit, und der <think>-Block waere aufklappbar zu sehen gewesen.
    const streamBuilds = (src.match(/this\.buildStreamFn\(\)/g) || []).length;
    check('beide Bahnen holen sich den Token-Strom', streamBuilds >= 2,
        String(streamBuilds));
    check('kein leerer Stream-Callback mehr',
        !/\(\)\s*=>\s*\{\s*\/\*[^*]*Stream[^*]*\*\/\s*\}/.test(src),
        'ein Aufruf uebergibt noch eine leere Funktion als onStream');

    // Und bindEngineCallbacks setzt wirklich alle fuenf
    const body = src.slice(src.indexOf('private bindEngineCallbacks'));
    const end = body.indexOf('\n    }');
    const inner = body.slice(0, end);
    for (const setter of ['setPlanCallback', 'setDiffReporter', 'setStatsCallback',
                          'setNarrationCallback', 'setAskCallback']) {
        check(`bindEngineCallbacks setzt ${setter}`, inner.includes(setter + '('),
            'fehlt');
    }
}

// ── Slash-Befehle: /goal, /loop, /help ──────────────────────────────────────
function runCommandTests() {
    section('Befehle: /goal, /loop, /help');

    const { parseCommand, parseBudget, HELP_TEXT } =
        require(path.join(PROJECT, 'out', 'commands.js'));

    // Erkennung
    check('/goal erkannt', parseCommand('/goal alles gruen').name === 'goal');
    check('/loop erkannt', parseCommand('/loop 5m testen').name === 'loop');
    check('/help erkannt', parseCommand('/help').name === 'help');
    check('deutsche Schreibweise', parseCommand('/ziel alles gruen').name === 'goal');
    check('Rest wird abgetrennt',
        parseCommand('/goal   alles gruen  ').rest === 'alles gruen',
        JSON.stringify(parseCommand('/goal   alles gruen  ')));

    // NUR am Anfang: sonst waere jede Erwaehnung ein Befehl
    check('Erwaehnung mitten im Satz ist kein Befehl',
        parseCommand('nutze bitte /goal um das zu setzen') === null);
    check('unbekannter Befehl ist kein Befehl',
        parseCommand('/gibtsnicht x') === null);
    check('normale Nachricht ist kein Befehl',
        parseCommand('Repariere die Tests') === null);

    // Budget
    const cases = [
        ['5m Tests reparieren', 5, 'Tests reparieren'],
        ['30 Minuten aufraeumen', 30, 'aufraeumen'],
        ['2h grosse Sache', 120, 'grosse Sache'],
        ['5 einfach weiter', 5, 'einfach weiter'],
    ];
    for (const [input, minutes, task] of cases) {
        const r = parseBudget(input);
        check(`Budget "${input}" -> ${minutes} min`, r.budget.minutes === minutes,
            JSON.stringify(r.budget));
        check(`Aufgabe aus "${input}"`, r.task === task, JSON.stringify(r.task));
    }

    const rounds = parseBudget('3x weiter machen');
    check('Rundenbudget erkannt', rounds.budget.rounds === 3, JSON.stringify(rounds.budget));
    check('Aufgabe nach Rundenbudget', rounds.task === 'weiter machen', rounds.task);

    const ohne = parseBudget('einfach weiterarbeiten');
    check('ohne Budget: Standard', ohne.budget.minutes === 10 && ohne.budget.rounds === 6,
        JSON.stringify(ohne.budget));
    check('ohne Budget: alles ist Aufgabe', ohne.task === 'einfach weiterarbeiten', ohne.task);

    // Obergrenzen: eine Schleife aendert Dateien und kostet Tokens
    check('Zeit gedeckelt', parseBudget('9999m x').budget.minutes === 120,
        String(parseBudget('9999m x').budget.minutes));
    check('Runden gedeckelt', parseBudget('9999x y').budget.rounds === 40,
        String(parseBudget('9999x y').budget.rounds));

    check('Hilfe nennt beide Befehle',
        /\/goal/.test(HELP_TEXT) && /\/loop/.test(HELP_TEXT));
    check('Hilfe nennt die Abbruchbedingungen',
        /budget is spent/.test(HELP_TEXT) && /Cancel/.test(HELP_TEXT));
}

// ── Eingereihte Anweisungen ─────────────────────────────────────────────────
// Wie bei Claude Code: waehrend der Arbeit getippter Text unterbricht NICHT,
// sondern kommt nach dem laufenden Schritt dran. Ein Abbruch mitten im Schritt
// liesse halbfertige Arbeit zurueck - Datei geaendert, Tests nicht gelaufen.
function runQueueTests() {
    section('Warteschlange: Anweisung waehrend der Arbeit');

    engine.clearQueuedInput();
    engine.currentTask = 'Repariere die Tests';

    check('leere Warteschlange', engine.pendingInputCount() === 0);
    check('Leertext wird nicht eingereiht',
        engine.queueUserInput('   ') === 0, String(engine.pendingInputCount()));

    check('erste Anweisung', engine.queueUserInput('nimm date-fns') === 1);
    check('zweite Anweisung', engine.queueUserInput('und schreib einen Test') === 2);

    const prompt = engine.takeQueuedPrompt();
    check('Warteschlange danach leer', engine.pendingInputCount() === 0);
    check('Prompt weist sie als neu aus',
        /NEW INSTRUCTION FROM THE USER/.test(prompt), String(prompt).slice(0, 80));
    check('beide Anweisungen enthalten',
        /date-fns/.test(prompt) && /schreib einen Test/.test(prompt), prompt);
    check('Prompt verbietet Neuanfang',
        /do not start over/i.test(prompt), prompt);

    // Der Auftrag waechst mit - sonst ist die Nachforderung eine Runde spaeter
    // wieder vergessen.
    check('Auftrag traegt die Nachforderung',
        /date-fns/.test(engine.currentTask), engine.currentTask);
    check('urspruenglicher Auftrag bleibt',
        /Repariere die Tests/.test(engine.currentTask), engine.currentTask);

    check('leere Warteschlange gibt null', engine.takeQueuedPrompt() === null);

    engine.queueUserInput('verwerfen');
    engine.clearQueuedInput();
    check('clearQueuedInput leert', engine.pendingInputCount() === 0);

    return runPracticeTests();
}

// ── Aus Erfolgen lernen ─────────────────────────────────────────────────────
// Vorbild ist Hermes: was sich bewaehrt hat, wird zu wiederverwendbarem
// Vorgehenswissen. Der Wert steht und faellt mit der Auswahl - eine Sammlung
// von "Bug behoben"-Notizen ist Ballast in jedem Prompt.
function runPracticeTests() {
    section('Best Practices: aus Erfolgen lernen');

    const { PracticeStore } = require(path.join(PROJECT, 'out', 'practices.js'));
    const dir = path.join(SANDBOX, 'practice');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const store = new PracticeStore(dir);
    check('anfangs leer', store.all().length === 0);
    check('leerer Prompt-Block', store.forPrompt() === '');

    check('Regel wird aufgenommen',
        store.add('Tests mit `npm test` starten, nicht mit `node --test`',
            'pretest kompiliert vorher') === true);
    check('gespeichert', store.all().length === 1, String(store.all().length));

    // Zu kurz ist keine Regel. "Klappt gut" ist kein Vorgehenswissen.
    check('zu kurze Regel abgelehnt', store.add('Klappt', '') === false);
    check('nichts dazugekommen', store.all().length === 1);

    // Dubletten: Modelle formulieren dieselbe Einsicht jedes Mal anders.
    check('Dublette erkannt trotz anderer Formulierung',
        store.add('Die Tests immer mit `npm test` ausfuehren statt `node --test`',
            'sonst laeuft es gegen alten Stand') === false,
        JSON.stringify(store.all().map(e => e.rule)));
    check('immer noch eine Regel', store.all().length === 1);

    check('andere Regel geht durch',
        store.add('Shell-Befehle laufen unter WSL, Pfade also als /mnt/d/...',
            'Windows-Pfade brechen an den Backslashes') === true);
    check('jetzt zwei Regeln', store.all().length === 2);
    check('neueste zuerst', /WSL/.test(store.all()[0].rule), store.all()[0].rule);

    // Der Prompt-Block: eingezaeunt und als Hintergrund ausgewiesen. Der Text
    // stammt von einem Modell und darf sich nicht als Anweisung ausgeben.
    const block = store.forPrompt();
    check('Prompt-Block enthaelt beide Regeln',
        /npm test/.test(block) && /WSL/.test(block), block);
    check('Block ist eingezaeunt',
        /<learned-practices>/.test(block) && /<\/learned-practices>/.test(block), block);
    check('Block weist sich als Hintergrund aus',
        /NOT instructions from the user/.test(block), block);
    check('Block warnt vor Veralterung',
        /out of date/.test(block), block);

    // Datei: von Hand lesbar und bearbeitbar
    const file = store.getPath();
    check('Datei liegt im Workspace', fs.existsSync(file), file);
    const raw = fs.readFileSync(file, 'utf-8');
    check('Datei nennt ihren Zweck', /Best Practices/.test(raw), raw.slice(0, 60));
    check('Datei sagt, dass man sie bearbeiten darf',
        /edited by hand/.test(raw), raw.slice(0, 300));
    check('Regeln als Liste', /^- Shell-Befehle/m.test(raw), raw);

    // Neu geladen muss dasselbe herauskommen - sonst waere die Datei nur Deko
    const wieder = new PracticeStore(dir);
    check('nach Neuladen zwei Regeln', wieder.all().length === 2,
        JSON.stringify(wieder.all()));
    check('Regel unveraendert gelesen',
        wieder.all()[0].rule === store.all()[0].rule,
        wieder.all()[0].rule);
    check('Begruendung erhalten',
        /Backslashes/.test(wieder.all()[0].why), wieder.all()[0].why);

    check('clear leert', wieder.clear() === 2 && wieder.all().length === 0);

    // ── Ueber die Aktion ────────────────────────────────────────────────────
    vscode.__setWorkspace(dir);
    engine.practiceStore = null;   // Speicher neu aufbauen lassen

    return engine.parseAndExecuteActions(
        '```action:remember\nregel: Nach jeder Aenderung `npm run compile` laufen lassen\n'
        + 'warum: tsc meldet Fehler, die die Tests nicht sehen\n```',
        async () => 'Run'
    ).then(actions => {
        check('remember-Aktion erfolgreich', actions.length === 1 && actions[0].success,
            JSON.stringify(actions));
        check('Beschreibung nennt die Regel',
            /Learned/.test(actions[0].description), actions[0].description);
        check('Regel ist im Speicher',
            engine.getPractices().all().some(e => /npm run compile/.test(e.rule)),
            JSON.stringify(engine.getPractices().all()));

        // Dublette gilt als ERFOLG - sonst haelt das Modell es fuer einen
        // Fehlschlag und versucht es in der naechsten Runde noch einmal.
        return engine.parseAndExecuteActions(
            '```action:remember\nregel: Immer `npm run compile` nach einer Aenderung ausfuehren\n```',
            async () => 'Run');
    }).then(actions => {
        check('Dublette ist kein Fehlschlag', actions[0].success === true,
            JSON.stringify(actions[0]));
        check('Dublette sagt es deutlich',
            /Already known/.test(actions[0].description), actions[0].description);
        check('Ausgabe verbietet den zweiten Versuch',
            /Do not try again/.test(actions[0].output), actions[0].output);
        check('immer noch nur eine Regel',
            engine.getPractices().all().length === 1,
            String(engine.getPractices().all().length));

        // Das Handbuch muss sagen, wann NICHT gemerkt wird - sonst fuellt sich
        // die Datei mit Tagebucheintraegen.
        const manual = engine.buildToolManual();
        check('Handbuch erklaert das Merken', /action:remember/.test(manual));
        check('Handbuch verlangt Ueberpruefung',
            /VERIFIED/.test(manual), 'fehlt');
        check('Handbuch verbietet Tagebucheintraege',
            /diary entry/.test(manual), 'fehlt');
        check('Handbuch begrenzt auf eine Regel',
            /At most one rule per task/.test(manual), 'fehlt');

        vscode.__setWorkspace(SANDBOX);
        engine.practiceStore = null;
    });
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
    return engine.parseAndExecuteActions(antwort, async () => 'Run').then(actions => {
        check('zaunloses action:done wird ausgefuehrt',
            actions.length === 1 && actions[0].description.includes('complete'),
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

    // 5. Doppelt geschickte Aktionen laufen nur EINMAL.
    //    Im Lauf gegen laguna kam jeder Aufruf zweimal: npm test lief zweimal,
    //    jede Datei wurde zweimal gelesen. Jede Runde kostete doppelt so lange.
    section('Aktions-Parser: doppelte Aktionen');

    const doppelt = [
        'Ich pruefe die Tests.',
        '```action:shell',
        'npm test',
        '```',
        '```action:shell',
        'npm test',
        '```'
    ].join('\n');

    // 6. Und beide UNTERSCHIEDLICHEN Bloecke muessen ausgefuehrt werden, nicht
    //    nur verschwinden - sonst arbeitet der Assistent die Haelfte nicht ab.
    return engine.parseAndExecuteActions(zweiBloecke, async () => 'Run').then(actions => {
        check('beide Bloecke ohne Zaun dazwischen werden ausgefuehrt',
            actions.length === 2, JSON.stringify(actions.map(a => a.description)));
        check('erster Block: src', actions[0] && /src/.test(actions[0].description),
            actions[0] && actions[0].description);
        check('zweiter Block: test', actions[1] && /test/.test(actions[1].description),
            actions[1] && actions[1].description);

        // Zweimal derselbe Befehl: einmal ausfuehren
        return engine.parseAndExecuteActions(doppelt, async () => 'Reject');
    }).then(actions => {
        check('doppelter Befehl laeuft nur einmal', actions.length === 1,
            JSON.stringify(actions.map(a => a.description)));

        // Zweimal read_file auf VERSCHIEDENE Dateien sind zwei Aufgaben
        return engine.parseAndExecuteActions(
            '```action:read_file\npath: src/index.ts\n```\n'
            + '```action:read_file\npath: src/services/userService.ts\n```',
            async () => 'Run');
    }).then(actions => {
        check('verschiedene Ziele bleiben zwei Aktionen', actions.length === 2,
            JSON.stringify(actions.map(a => a.description)));

        // Zweimal dieselbe Datei ist ein Versehen
        return engine.parseAndExecuteActions(
            '```action:read_file\npath: src/index.ts\n```\n'
            + '```action:read_file\npath: src/index.ts\n```',
            async () => 'Run');
    }).then(actions => {
        check('dieselbe Datei zweimal gelesen: nur einmal', actions.length === 1,
            JSON.stringify(actions.map(a => a.description)));

        return runSeparatorTests();
    }).then(() => {
        return runFeedbackTests();
    });
}

// ── Jede Aktion muss im Chat sichtbar werden ────────────────────────────────
// Der Fehler: acht Handler riefen onActionProgress gar nicht auf. Eine
// angelegte Datei, ein abgelehnter Befehl, eine gemerkte Regel - alles lief,
// und im Chat stand nichts. Beim Shell-Befehl war es besonders sichtbar: das
// Kommando selbst tauchte nie auf, obwohl genau das die Frage ist, wenn ein
// Lauf schiefgeht.
//
// Nachgetragen wird die Zeile jetzt zentral in parseAndExecuteActions. Dieser
// Test haelt das fest, damit eine neue Aktion nicht wieder still bleibt.
// ── Der fehlende "---"-Trenner ──────────────────────────────────────────────
// Im Fenster-Lauf starben SECHS Schreibversuche hintereinander an
// 'Kein "---" Trenner gefunden' - patch_file dreimal, dann replace_lines,
// edit_file und create_file. Der Assistent kam erst weiter, als er zu `sed`
// ueber die Shell griff. Sechs Runden fuer einen Operator.
//
// Der Trenner ist ableitbar: der Kopf besteht aus bekannten "key: value"-Zeilen,
// der Rumpf beginnt bei der ersten Zeile, die keine ist.
function runSeparatorTests() {
    section('Aktionsbloecke ohne "---" Trenner');

    const split = AIEngine.splitHeaderAndBody.bind(AIEngine);

    // Mit Trenner bleibt alles wie es war - er hat Vorrang
    const mit = split('path: a.ts\n---\nexport const a = 1;');
    check('mit Trenner: Kopf', mit.header.trim() === 'path: a.ts', JSON.stringify(mit));
    check('mit Trenner: Rumpf', mit.body === 'export const a = 1;', JSON.stringify(mit));

    // Und er hat Vorrang, auch wenn der Inhalt selbst wie ein Kopf aussieht
    const yaml = split('path: conf.yml\n---\npath: /var/log\nmode: append');
    check('Trenner schlaegt inhaltsgleiche Kopfzeile',
        yaml.body === 'path: /var/log\nmode: append', JSON.stringify(yaml));

    // Ohne Trenner: der Rumpf beginnt nach den Kopfzeilen
    const ohne = split('path: src/tokenizer.js\n<<<SEARCH\nalt\n>>>REPLACE\nneu');
    check('ohne Trenner: Kopf erkannt', ohne.header.trim() === 'path: src/tokenizer.js',
        JSON.stringify(ohne));
    check('ohne Trenner: Rumpf ab <<<SEARCH',
        ohne.body === '<<<SEARCH\nalt\n>>>REPLACE\nneu', JSON.stringify(ohne));

    const mehrere = split('path: a.ts\nstart_line: 3\nend_line: 7\nconst x = 1;');
    check('mehrere Kopfzeilen', /start_line: 3/.test(mehrere.header)
        && mehrere.body === 'const x = 1;', JSON.stringify(mehrere));

    // Nur Kopfzeilen: da ist nichts zu raten, der Aufrufer soll meckern
    check('nur Kopfzeilen gibt leeren Kopf zurueck',
        split('path: a.ts').header === '', JSON.stringify(split('path: a.ts')));
    check('leerer Block ebenso', split('').header === '');

    // Und jetzt durch den echten Parser: genau die Bloecke aus dem Lauf
    const rows = [];
    const collect = (d, o, m) => rows.push({ d, o, m });
    // Die Bestaetigung heisst je nach Aktion anders - "Anwenden" beim Patch,
    // "Ausfuehren" bei der Shell. Wer pauschal "Ausfuehren" antwortet, lehnt
    // den Patch ab, ohne es zu merken.
    const jaBitte = async (_msg, choices) =>
        (choices && choices.includes('Apply')) ? 'Apply' : 'Run';
    const run = (response) => {
        rows.length = 0;
        return engine.parseAndExecuteActions(response, jaBitte, collect);
    };

    return run([
        '```action:create_file',
        'path: ohne-trenner.txt',
        'Zeile eins',
        'Zeile zwei',
        '```'
    ].join('\n')).then(actions => {
        check('create_file ohne Trenner wird ausgefuehrt',
            actions.length === 1 && actions[0].success === true,
            JSON.stringify(actions));
        const geschrieben = fs.readFileSync(path.join(SANDBOX, 'ohne-trenner.txt'), 'utf-8');
        check('und der Inhalt ist der Rumpf, nicht der Kopf',
            geschrieben.trim() === 'Zeile eins\nZeile zwei', JSON.stringify(geschrieben));

        return run([
            '```action:patch_file',
            'path: src/index.ts',
            '<<<SEARCH',
            'const svc = new UserService();',
            '>>>REPLACE',
            'const svc = new UserService(); /* gepatcht */',
            '```'
        ].join('\n'));
    }).then(actions => {
        check('patch_file ohne Trenner wird angewendet',
            actions.length === 1 && actions[0].success === true,
            JSON.stringify(actions));
        const datei = fs.readFileSync(path.join(SANDBOX, 'src', 'index.ts'), 'utf-8');
        check('der Patch steht in der Datei', datei.includes('/* gepatcht */'),
            datei.slice(0, 120));
    });
}

function runFeedbackTests() {
    section('Rueckmeldung: jede Aktion bekommt eine Zeile');

    // Reine Beschriftungsfunktionen
    check('toolLabel: shell -> Bash', AIEngine.toolLabel('shell') === 'Bash');
    check('toolLabel: create_file -> Write', AIEngine.toolLabel('create_file') === 'Write');
    check('toolLabel: unbekannt bleibt stehen', AIEngine.toolLabel('quatsch') === 'quatsch');
    check('actionTarget: Pfad aus der Kopfzeile',
        AIEngine.actionTarget('create_file', 'path: src/neu.ts\n---\nx', 'Datei erstellt')
            === 'src/neu.ts');
    check('actionTarget: Shell nimmt den Befehl',
        AIEngine.actionTarget('shell', 'npm run build', 'Shell') === 'npm run build');
    check('actionTarget: Shell mit Kopfzeile nimmt nur den Befehl',
        AIEngine.actionTarget('shell', 'shell: powershell\nGet-Date', 'Shell') === 'Get-Date');

    const rows = [];
    const collect = (description, output, meta) => rows.push({ description, output, meta });
    const run = (response, answer = 'Run') => {
        rows.length = 0;
        return engine.parseAndExecuteActions(response, async () => answer, collect);
    };

    // 1. Der gemeldete Fehler: ein abgelehnter Befehl hinterliess keine Spur.
    return run('```action:shell\nnpm run build\n```', 'Reject').then(() => {
        check('abgelehnter Befehl bekommt eine Zeile', rows.length === 1,
            JSON.stringify(rows));
        check('und das Kommando steht darin',
            rows[0] && rows[0].meta && rows[0].meta.target === 'npm run build',
            JSON.stringify(rows[0] && rows[0].meta));
        check('als Fehlschlag markiert', rows[0] && rows[0].meta.ok === false,
            JSON.stringify(rows[0] && rows[0].meta));

        // 2. Eine angelegte Datei
        return run('```action:create_file\npath: rueckmeldung.txt\n---\nhallo\n```');
    }).then(() => {
        check('create_file bekommt eine Zeile', rows.length === 1, JSON.stringify(rows));
        check('mit Werkzeug Write', rows[0] && rows[0].meta.tool === 'Write',
            JSON.stringify(rows[0] && rows[0].meta));
        check('mit dem Pfad als Ziel', rows[0] && rows[0].meta.target === 'rueckmeldung.txt',
            JSON.stringify(rows[0] && rows[0].meta));

        // 3. Eine gemerkte Regel
        return run('```action:remember\nregel: Erst lesen, dann patchen.\nwarum: Patch schlug fehl.\n```');
    }).then(() => {
        check('remember bekommt eine Zeile', rows.length === 1, JSON.stringify(rows));
        check('mit Werkzeug Learned', rows[0] && rows[0].meta.tool === 'Learned',
            JSON.stringify(rows[0] && rows[0].meta));

        // 4. read_file meldet selbst - dann KEINE zweite Zeile
        return run('```action:read_file\npath: src/index.ts\n```');
    }).then(() => {
        const eigene = rows.filter(r => r.meta && r.meta.tool === 'Read');
        check('read_file meldet selbst', eigene.length >= 1, JSON.stringify(rows));
        check('und wird nicht doppelt gemeldet',
            rows.filter(r => !r.meta.running).length === 1, JSON.stringify(rows));

        // 5. Plan und done zeigen sich selbst - keine Werkzeugzeile
        return run('```action:plan\n- [ ] Schritt eins\n```');
    }).then(() => {
        check('Plan bekommt KEINE Werkzeugzeile', rows.length === 0, JSON.stringify(rows));

        return run('```action:done\nzusammenfassung: fertig\n```');
    }).then(() => {
        check('done bekommt KEINE Werkzeugzeile', rows.length === 0, JSON.stringify(rows));
        engine.taskComplete = false;

        // 5b. Eine Aktion, die einen Fehler WIRFT, braucht ihre Zeile ebenso.
        //     Im Fenster-Lauf stand die Ansage "Tokenizer erweitern", vier
        //     Zeilen spaeter "1 Aenderung nicht angewendet" - und dazwischen
        //     nichts darueber, WELCHE Aenderung und warum.
        return run([
            '```action:patch_file',
            'path: src/index.ts',
            '---',
            '<<<SEARCH',
            'diesen Text gibt es in der Datei nicht',
            '>>>REPLACE',
            'ersetzt',
            '```'
        ].join('\n'));
    }).then(() => {
        check('geworfener Fehler bekommt eine Zeile', rows.length === 1,
            JSON.stringify(rows));
        check('als Fehlschlag markiert', rows[0] && rows[0].meta.ok === false,
            JSON.stringify(rows[0] && rows[0].meta));
        check('mit dem Pfad als Ziel', rows[0] && rows[0].meta.target === 'src/index.ts',
            JSON.stringify(rows[0] && rows[0].meta));
        check('und der Grund steht in der Ausgabe',
            rows[0] && /nicht gefunden|nicht enthalten|Suchtext|SEARCH/i.test(rows[0].output),
            rows[0] && rows[0].output);

        // 6. Und der Grundsatz: kein Aktionstyp bleibt stumm.
        const mix = [
            '```action:create_file',
            'path: stumm/a.txt',
            '---',
            'x',
            '```',
            '```action:delete_file',
            'path: stumm/a.txt',
            '```',
            '```action:glob',
            'pattern: **/*.ts',
            '```'
        ].join('\n');
        return run(mix);
    }).then(actions => {
        check('drei Aktionen, drei sichtbare Zeilen',
            actions.length === 3 && rows.filter(r => !r.meta.running).length === 3,
            `${actions.length} Aktionen, ${rows.length} Zeilen: `
            + JSON.stringify(rows.map(r => r.meta && r.meta.tool)));
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
            step !== null && step.prompt.includes('YOUR TASK'),
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
        bare !== null && !bare.prompt.includes('YOUR TASK')
        && bare.prompt.startsWith('RESULTS'),
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
