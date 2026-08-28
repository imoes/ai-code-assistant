/**
 * Führt alle Testdateien aus und fasst das Ergebnis zusammen.
 *
 * Warum ein eigener Läufer und nicht `node --test`: die Tests brauchen einen
 * vscode-Stub, der über `Module._load` eingehängt wird, und laufen gegen das
 * Kompilat in `out/`. Der Node-Testrunner würde jede Datei in einem eigenen
 * Prozess mit eigener Modulauflösung starten – das funktioniert, aber die
 * Zusammenfassung über alle Dateien fehlt dann.
 *
 *   npm test
 */
const path = require('path');
const cp = require('child_process');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

// Ohne Kompilat läuft nichts – der Hinweis erspart Ratespiele.
if (!fs.existsSync(path.join(ROOT, 'out', 'aiEngine.js'))) {
    console.error('out/ fehlt. Zuerst "npm run compile" ausführen.');
    process.exit(1);
}

const FILES = ['suite.js', 'markdown.js', 'websearch.js', 'idle-timeout.js'];

let totalPass = 0;
let totalFail = 0;
const failedFiles = [];

for (const file of FILES) {
    const full = path.join(__dirname, file);
    if (!fs.existsSync(full)) {
        console.log(`\n### ${file} – nicht vorhanden, übersprungen`);
        continue;
    }

    console.log(`\n${'='.repeat(70)}`);
    console.log(`### ${file}`);
    console.log('='.repeat(70));

    const res = cp.spawnSync(process.execPath, [full], {
        cwd: ROOT,
        env: { ...process.env, PROJECT_DIR: ROOT },
        encoding: 'utf-8'
    });

    const out = (res.stdout || '') + (res.stderr || '');
    process.stdout.write(out);

    // Jede Datei endet mit "ERGEBNIS: N bestanden, M fehlgeschlagen"
    const m = /ERGEBNIS:\s*(\d+)\s*bestanden,\s*(\d+)\s*fehlgeschlagen/.exec(out);
    if (m) {
        totalPass += Number(m[1]);
        totalFail += Number(m[2]);
        if (Number(m[2]) > 0) failedFiles.push(file);
    } else {
        // Kein Ergebnis heißt Abbruch – das darf nicht als Erfolg durchgehen
        console.log(`\n(${file}: kein Ergebnis gefunden, Exit-Code ${res.status})`);
        totalFail += 1;
        failedFiles.push(file + ' (abgebrochen)');
    }
}

console.log(`\n${'='.repeat(70)}`);
console.log(`GESAMT: ${totalPass} bestanden, ${totalFail} fehlgeschlagen`);
if (failedFiles.length > 0) {
    console.log(`Fehlgeschlagene Dateien: ${failedFiles.join(', ')}`);
}
console.log('='.repeat(70));

process.exit(totalFail > 0 ? 1 : 0);
