/** Verbrauch je Tag/Woche/Monat/Jahr aus dem Zählerstand des Hauptmessgeräts.
 *
 *  Prinzip: Der Zähler (Wh) des Geräts läuft immer weiter. Beim ersten Messwert
 *  eines Kalendertags wird sein Stand festgehalten. Der Verbrauch eines Tags
 *  ist dann die Differenz zum Stand des nächsten Tags, der von heute die
 *  Differenz zum aktuellen Stand. Tage, für die kein Zählerstand vorliegt
 *  (z. B. vor der Einrichtung), kann ein einmal importierter Verlauf
 *  ("Seed", siehe `parseSeed`) auffüllen. */

export interface CounterMark {
  /** Zählerstand in Wh. */
  wh: number;
  /** Zeitpunkt der Messung (ms), um eine verspätete erste Messung zu erkennen. */
  t: number;
}

export interface DayStore {
  /** `YYYY-MM-DD` → Zählerstand beim ersten Messwert dieses Tages. */
  counters: Record<string, CounterMark>;
  /** `YYYY-MM-DD` → Verbrauch dieses Tages in Wh (importierter Verlauf). */
  days: Record<string, number>;
}

export const EMPTY_STORE: DayStore = { counters: {}, days: {} };

export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function keyToDate(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Merkt sich den Zählerstand beim ersten Messwert des Tages von `now`. */
export function recordCounter(store: DayStore, now: Date, counterWh: number): DayStore {
  const key = dayKey(now);
  if (store.counters[key]) return store;
  // Zählerreset (Gerät getauscht/zurückgesetzt): alte Stände sind nicht mehr vergleichbar.
  const known = Object.values(store.counters);
  const reset = known.some((c) => c.wh > counterWh);
  return {
    ...store,
    counters: reset ? { [key]: { wh: counterWh, t: now.getTime() } } : { ...store.counters, [key]: { wh: counterWh, t: now.getTime() } },
  };
}

/** Importierter Verlauf: `{"d": {"2026-02-10": 5321.5, …}, "c": {"2026-10-10": 10495000}}`.
 *  `c` sind Zählerstände zu Tagesbeginn, damit der heutige Tag ab dem Import
 *  stimmt. Ungültiges ergibt einen leeren Verlauf. */
export function parseSeed(text: unknown): DayStore {
  if (typeof text !== 'string' || !text.trim()) return EMPTY_STORE;
  try {
    const raw = JSON.parse(text) as { d?: Record<string, number>; c?: Record<string, number> };
    const days: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.d ?? {})) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && typeof v === 'number' && Number.isFinite(v)) days[k] = v;
    }
    const counters: Record<string, CounterMark> = {};
    for (const [k, v] of Object.entries(raw.c ?? {})) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && typeof v === 'number' && Number.isFinite(v)) {
        counters[k] = { wh: v, t: keyToDate(k).getTime() };
      }
    }
    return { counters, days };
  } catch {
    return EMPTY_STORE;
  }
}

/** Seed und eigene Aufzeichnung zusammenführen (eigene Zählerstände gewinnen). */
export function mergeStores(own: DayStore, seed: DayStore): DayStore {
  return {
    counters: { ...seed.counters, ...own.counters },
    days: { ...seed.days, ...own.days },
  };
}

export interface Periods {
  day: number;
  week: number;
  month: number;
  year: number;
  /** Letzte 7 Tage inklusive heute, älteste zuerst. */
  last7: Array<{ date: Date; wh: number | null }>;
  /** Beginn des Tages, falls dessen Zählerstand erst später als Mitternacht erfasst wurde. */
  todaySince: number | null;
  /** Erster Tag mit Daten, falls er nach dem 1. Januar liegt ("seit ..."). */
  dataSince: Date | null;
}

/** Verbrauch eines vergangenen Tags `key`: aus Zählerstandsdifferenz zum
 *  Folgetag, sonst aus dem importierten Verlauf, sonst unbekannt. */
function pastDayWh(store: DayStore, key: string): number | null {
  const next = dayKey(addDays(keyToDate(key), 1));
  const a = store.counters[key];
  const b = store.counters[next];
  if (a && b && b.wh >= a.wh) return b.wh - a.wh;
  const seeded = store.days[key];
  return typeof seeded === 'number' ? seeded : null;
}

export function periodsFrom(store: DayStore, now: Date, counterWh: number | null): Periods {
  const todayKey = dayKey(now);
  const today = store.counters[todayKey];
  let day = 0;
  let todaySince: number | null = null;
  if (today && counterWh !== null && counterWh >= today.wh) {
    day = counterWh - today.wh;
    const midnight = keyToDate(todayKey).getTime();
    if (today.t - midnight > 20 * 60 * 1000) todaySince = today.t;
  }

  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const dow = (now.getDay() + 6) % 7;
  const startOfWeek = addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), -dow);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  let week = day;
  let month = day;
  let year = day;
  let earliest: Date | null = null;
  const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let d = startOfYear; d < todayDate; d = addDays(d, 1)) {
    const wh = pastDayWh(store, dayKey(d));
    if (wh === null) continue;
    if (earliest === null) earliest = d;
    year += wh;
    if (d >= startOfMonth) month += wh;
    if (d >= startOfWeek) week += wh;
  }
  if (earliest === null && today) earliest = todayDate;

  const last7: Periods['last7'] = [];
  for (let i = 6; i >= 1; i--) {
    const d = addDays(todayDate, -i);
    last7.push({ date: d, wh: pastDayWh(store, dayKey(d)) });
  }
  last7.push({ date: todayDate, wh: today && counterWh !== null ? day : null });

  const yearStartKey = dayKey(startOfYear);
  return {
    day,
    week,
    month,
    year,
    last7,
    todaySince,
    dataSince: earliest && dayKey(earliest) > yearStartKey ? earliest : null,
  };
}

/** Nur die jüngsten ~400 Tage behalten, damit der Browser-Speicher klein bleibt. */
export function pruneStore(store: DayStore, now: Date): DayStore {
  const cutoff = dayKey(addDays(now, -400));
  const keep = <T,>(rec: Record<string, T>) =>
    Object.fromEntries(Object.entries(rec).filter(([k]) => k >= cutoff)) as Record<string, T>;
  return { counters: keep(store.counters), days: keep(store.days) };
}

export interface PeriodStarts {
  day: number;
  week: number;
  month: number;
  year: number;
}

/** Beginn der Zeiträume in ms — nie vor dem ersten Messwert, damit anteilige
 *  Grundgebühren nur für den Zeitraum berechnet werden, den es auch gibt. */
export function periodStarts(now: Date, p: Periods): PeriodStarts {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = (now.getDay() + 6) % 7;
  const monday = addDays(midnight, -dow);
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const firstOfYear = new Date(now.getFullYear(), 0, 1);
  const earliest = Math.max(
    p.dataSince ? p.dataSince.getTime() : firstOfYear.getTime(),
    firstOfYear.getTime(),
  );
  const clamp = (t: number) => Math.min(now.getTime(), Math.max(t, earliest));
  return {
    day: Math.min(now.getTime(), p.todaySince ?? midnight.getTime()),
    week: clamp(monday.getTime()),
    month: clamp(firstOfMonth.getTime()),
    year: clamp(firstOfYear.getTime()),
  };
}

/** Kosten eines Zeitraums: Arbeitspreis mal Verbrauch plus anteiliger Grundpreis. */
export function costOf(wh: number, pricePerKwh: number, baseFeePerYear: number, elapsedMs: number): number {
  return (wh / 1000) * pricePerKwh + (baseFeePerYear * Math.max(0, elapsedMs)) / (365 * 86400000);
}

/** "1,37 €" bzw. ab 100 € ohne Nachkommastellen ("856 €"). */
export function formatEuro(amount: number): string {
  const v = Math.max(0, amount);
  const text = v >= 100 ? Math.round(v).toString() : v.toFixed(2).replace('.', ',');
  return `${text.replace(/\B(?=(\d{3})+(?!\d))/g, '.')} €`;
}
