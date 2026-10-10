import { describe, expect, it } from 'vitest';
import { dayKey, mergeStores, parseSeed, periodsFrom, recordCounter, type DayStore } from './energy-days';

const at = (y: number, mo: number, d: number, h = 12, m = 0) => new Date(y, mo, d, h, m);

describe('recordCounter', () => {
  it('merkt sich nur den ersten Zählerstand eines Tages', () => {
    let s: DayStore = { counters: {}, days: {} };
    s = recordCounter(s, at(2026, 9, 14, 0, 1), 1000);
    s = recordCounter(s, at(2026, 9, 14, 18), 1800);
    expect(s.counters['2026-10-14'].wh).toBe(1000);
  });

  it('verwirft Stände nach einem Zählerreset', () => {
    let s: DayStore = { counters: { '2026-10-13': { wh: 5000, t: 0 } }, days: {} };
    s = recordCounter(s, at(2026, 9, 14, 0, 1), 100);
    expect(Object.keys(s.counters)).toEqual(['2026-10-14']);
  });
});

describe('periodsFrom', () => {
  // Mittwoch, 14.10.2026: Woche beginnt Montag 12.10.
  const now = at(2026, 9, 14, 12);
  const store: DayStore = {
    counters: {
      '2026-10-10': { wh: 1000, t: at(2026, 9, 10, 0, 1).getTime() },
      '2026-10-11': { wh: 1400, t: at(2026, 9, 11, 0, 1).getTime() }, // Sa: 400
      '2026-10-12': { wh: 1900, t: at(2026, 9, 12, 0, 1).getTime() }, // So: 500
      '2026-10-13': { wh: 2500, t: at(2026, 9, 13, 0, 1).getTime() }, // Mo: 600
      '2026-10-14': { wh: 3300, t: at(2026, 9, 14, 0, 1).getTime() }, // Di: 800
    },
    days: { '2026-10-01': 300, '2026-09-30': 250, '2026-01-02': 700 },
  };

  it('Tag aus aktuellem Zähler, Woche ab Montag, Monat, Jahr', () => {
    const p = periodsFrom(store, now, 3700);
    expect(p.day).toBe(400);
    // Montag 12.10. und Dienstag 13.10. + heute: 500 + 600 + 400... Tage ab Montag 12.10.:
    // 12.10. = 600 (2500-1900), 13.10. = 800 (3300-2500), heute 400
    expect(p.week).toBe(600 + 800 + 400);
    // Oktober: 01.10. (300) + 10.10.(400) + 11.10.(500) + 12.10.(600) + 13.10.(800) + heute 400
    expect(p.month).toBe(300 + 400 + 500 + 600 + 800 + 400);
    expect(p.year).toBe(p.month + 250 + 700);
    expect(p.last7).toHaveLength(7);
    expect(p.last7[6]).toMatchObject({ wh: 400 });
    expect(p.todaySince).toBeNull();
  });

  it('meldet verspätete erste Messung und späten Datenbeginn', () => {
    const late: DayStore = {
      counters: { '2026-10-14': { wh: 3300, t: at(2026, 9, 14, 8, 30).getTime() } },
      days: {},
    };
    const p = periodsFrom(late, now, 3700);
    expect(p.todaySince).toBe(at(2026, 9, 14, 8, 30).getTime());
    expect(p.day).toBe(400);
    expect(p.dataSince).not.toBeNull();
    expect(dayKey(p.dataSince!)).toBe('2026-10-14');
  });

  it('Lücken in der Aufzeichnung verfälschen keine Tage', () => {
    const gap: DayStore = {
      counters: {
        '2026-10-12': { wh: 1000, t: 0 },
        // 13.10. fehlt (Pi war aus)
        '2026-10-14': { wh: 4000, t: 1 },
      },
      days: {},
    };
    const p = periodsFrom(gap, now, 4200);
    expect(p.day).toBe(200);
    expect(p.week).toBe(200); // 12.10. und 13.10. unbekannt, nicht 3000 dem 12.10. zuschlagen
  });
});

describe('parseSeed/mergeStores', () => {
  it('liest den importierten Verlauf und ignoriert Ungültiges', () => {
    const seed = parseSeed('{"d":{"2026-02-10":5300.5,"kaputt":1},"c":{"2026-10-14":10000}}');
    expect(seed.days).toEqual({ '2026-02-10': 5300.5 });
    expect(seed.counters['2026-10-14'].wh).toBe(10000);
    expect(parseSeed('nix')).toEqual({ counters: {}, days: {} });
  });

  it('eigene Zählerstände haben Vorrang vor dem Seed', () => {
    const seed = parseSeed('{"c":{"2026-10-14":10000}}');
    const own: DayStore = { counters: { '2026-10-14': { wh: 10050, t: 5 } }, days: {} };
    expect(mergeStores(own, seed).counters['2026-10-14'].wh).toBe(10050);
  });
});
