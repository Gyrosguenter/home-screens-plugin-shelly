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
