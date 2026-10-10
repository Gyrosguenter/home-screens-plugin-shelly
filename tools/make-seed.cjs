#!/usr/bin/env node
// Verlauf für das Shelly-Plugin vorbereiten (optional).
//
// Ein Shelly EM (Gen1) speichert seinen Verbrauch selbst. Aus dieser Datei lassen
// sich die Tagessummen berechnen, die du im Plugin im Feld "Importierter Verlauf"
// einträgst, damit Woche/Monat/Jahr sofort stimmen.
//
//   1. Datei vom Shelly holen (dauert einige Minuten, ca. 1-2 MB; währenddessen
//      nichts anderes vom Gerät abrufen, sonst meldet es
//      "Another file transfer is in progress!"):
//        curl -m 1200 -o em_data.csv "http://<IP-des-Shelly>/emeter/<Kanal>/em_data.csv"
//   2. Tagessummen berechnen (nur das laufende Jahr):
//        node tools/make-seed.cjs em_data.csv
//   3. Die ausgegebene Zeile (JSON) im Plugin unter "Importierter Verlauf" einfügen.
//
// Zeiten in der Datei sind UTC; die Tage werden in der Zeitzone dieses Rechners
// gebildet (also bei dir zuhause: Ortszeit).
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('Aufruf: node tools/make-seed.cjs em_data.csv [ab-Datum JJJJ-MM-TT]');
  process.exit(1);
}
const now = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const todayKey = key(now);
const fromKey = process.argv[3] || `${now.getFullYear()}-01-01`;

const days = {};
const seen = new Set();
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}),(-?[\d.]+)/.exec(line);
  if (!m) continue;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  if (seen.has(t)) continue;
  seen.add(t);
  const k = key(new Date(t));
  days[k] = (days[k] ?? 0) + Number(m[6]);
}

const d = {};
for (const [k, v] of Object.entries(days)) {
  if (k >= fromKey && k < todayKey) d[k] = Math.round(v * 10) / 10;
}
const keys = Object.keys(d).sort();
const gaps = [];
for (let i = 1; i < keys.length; i++) {
  if ((new Date(keys[i]) - new Date(keys[i - 1])) / 86400000 > 1) gaps.push(`${keys[i - 1]} -> ${keys[i]}`);
}
console.error(`${keys.length} Tage (${keys[0]} bis ${keys[keys.length - 1]}), Lücken: ${gaps.length ? gaps.join(', ') : 'keine'}`);
console.error('Heutiger Tag ist nicht enthalten (das Plugin rechnet ihn selbst).');
process.stdout.write(JSON.stringify({ d }) + '\n');
