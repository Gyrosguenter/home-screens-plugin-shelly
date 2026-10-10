import { describe, expect, it } from 'vitest';
import {
  gen1HasMeter,
  formatKwh,
  formatPower,
  parseDevices,
  parseGeneration,
  parseGen1,
  parseGen2,
  pushHistory,
  pushSnapshot,
  sparkPaths,
  todayUsage,
} from './power-logic';

describe('parseDevices', () => {
  it('liest Name | Adresse | Kanal, überspringt Leeres und Kommentare', () => {
    const text = 'Gesamt | 192.168.1.20 | 1\n\n# Kommentar\nServer | 192.168.1.21  # Rack\nkaputt\nNix | bad host';
    expect(parseDevices(text)).toEqual([
      { name: 'Gesamt', host: '192.168.1.20', channel: 1 },
      { name: 'Server', host: '192.168.1.21', channel: 0 },
    ]);
  });
  it('liefert bei Unsinn eine leere Liste', () => {
    expect(parseDevices(undefined)).toEqual([]);
  });
});

describe('Statusantworten', () => {
  it('Gen2 PM Mini (pm1:0)', () => {
    const r = parseGen2({ 'pm1:0': { apower: 292.2, aenergy: { total: 1537214.5 } } }, 0);
    expect(r).toEqual({ watts: 292.2, totalWh: 1537214.5, on: null });
  });
  it('Gen2 Plus-Relais mit Messung (switch:0)', () => {
    expect(parseGen2({ 'switch:0': { apower: 12, output: true, aenergy: { total: 50 } } }, 0)).toEqual({
      watts: 12,
      totalWh: 50,
      on: true,
    });
  });
  it('Gen2 ohne Messwert (Plus 1): nur Schaltzustand', () => {
    expect(parseGen2({ 'switch:0': { output: false } }, 0)).toEqual({ watts: null, totalWh: null, on: false });
    expect(parseGen2({ wifi: {} }, 0)).toBeNull();
  });
  it('Gen1 EM, Kanal 1', () => {
    const status = { emeters: [{ power: 0, total: 0 }, { power: 675.87, total: 10495797.5 }] };
    expect(parseGen1(status, 1)).toEqual({ watts: 675.87, totalWh: 10495797.5, on: null });
    expect(parseGen1(status, 5)).toBeNull();
  });
  it('Gen1 Shelly 1: meters nur Nullen, also Schaltzustand statt Messwert', () => {
    const status = { relays: [{ ison: true }], meters: [{ power: 0, is_valid: true }] };
    expect(parseGen1(status, 0, false)).toEqual({ watts: null, totalWh: null, on: true });
    expect(parseGen1(status, 0, true)?.watts).toBe(0);
  });
  it('Gen1: Messer erkennen', () => {
    expect(gen1HasMeter({ type: 'SHSW-1', num_outputs: 1 })).toBe(false);
    expect(gen1HasMeter({ type: 'SHEM', num_meters: 0, num_emeters: 2 })).toBe(true);
    expect(gen1HasMeter({ type: 'SHSW-PM', num_meters: 1 })).toBe(true);
  });
  it('Generation', () => {
    expect(parseGeneration({ gen: 2 })).toBe(2);
    expect(parseGeneration({ type: 'SHEM' })).toBe(1);
  });
});

describe('Formatierung', () => {
  it('Watt und Kilowatt', () => {
    expect(formatPower(675.87)).toBe('676 W');
    expect(formatPower(1240)).toBe('1,24 kW');
  });
  it('Kilowattstunden', () => {
    expect(formatKwh(4210)).toBe('4,21 kWh');
    expect(formatKwh(12500)).toBe('12,5 kWh');
  });
});

describe('Tagesverbrauch', () => {
  const day = (h: number, m = 0) => new Date(2026, 9, 10, h, m).getTime();
  it('nutzt den Schnappschuss um Mitternacht', () => {
    const list = [{ t: day(0, 2), wh: 1000 }, { t: day(6), wh: 1800 }];
    expect(todayUsage(list, day(12), 4000)).toEqual({ wh: 3000, since: null });
  });
  it('ohne Mitternachtswert zählt ab dem ersten Wert des Tages', () => {
    const list = [{ t: day(8), wh: 2000 }];
    expect(todayUsage(list, day(12), 2600)).toEqual({ wh: 600, since: day(8) });
  });
  it('Zählerreset ergibt nichts', () => {
    expect(todayUsage([{ t: day(1), wh: 5000 }], day(12), 100)).toBeNull();
  });
  it('Schnappschüsse höchstens alle 10 Minuten, alte fallen heraus', () => {
    let list = pushSnapshot([], day(10), 1);
    list = pushSnapshot(list, day(10, 5), 2);
    expect(list).toHaveLength(1);
    list = pushSnapshot(list, day(10, 12), 3);
    expect(list).toHaveLength(2);
    expect(pushSnapshot(list, day(10) + 3 * 24 * 3600 * 1000, 9)).toHaveLength(1);
  });
});

describe('Verlauf', () => {
  it('begrenzt die Länge', () => {
    expect(pushHistory([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });
  it('Sparkline braucht mindestens zwei Werte', () => {
    expect(sparkPaths([1], 100, 20)).toBeNull();
    const p = sparkPaths([0, 10, 5], 100, 20);
    expect(p?.line.startsWith('M0.0')).toBe(true);
    expect(p?.area.endsWith('Z')).toBe(true);
  });
});

import { formatKwhDe, parseEmCsv } from './power-logic';

describe('Verbrauchs-Historie (em_data.csv)', () => {
  const csv = [
    'Date/time UTC,Active energy Wh (2),Returned energy Wh (2),Min V,Max V',
    '2026-02-10 00:00,36.80,0.00,236.5,236.5',
    '2026-02-10 00:10,31.40,0.00,236.5,238.0',
    'kaputt,zeile',
    '2026-02-10 00:20,40.10,0.00,236.5,238.0',
  ].join('\n');

  it('liest 10-Minuten-Fenster und überspringt Müll', () => {
    const r = parseEmCsv(csv);
    expect(r).toHaveLength(3);
    expect(r[0]).toEqual({ t: Date.UTC(2026, 1, 10, 0, 0), wh: 36.8 });
    expect(r[2].wh).toBe(40.1);
  });

  it('Formatierung deutsch mit Tausenderpunkt', () => {
    expect(formatKwhDe(4210)).toBe('4,21 kWh');
    expect(formatKwhDe(31520)).toBe('31,5 kWh');
    expect(formatKwhDe(128400)).toBe('128 kWh');
    expect(formatKwhDe(1234000)).toBe('1.234 kWh');
  });
});
