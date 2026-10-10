/** Ein Shelly-Messpunkt, wie er im Modul eingetragen wird. */
export interface DeviceSpec {
  name: string;
  host: string;
  /** Kanal/Phase (0-basiert), bei Geräten mit mehreren Messkanälen. */
  channel: number;
}

export interface Reading {
  /** Aktuelle Leistung in Watt (negativ = Einspeisung). */
  watts: number;
  /** Zählerstand in Wattstunden, falls das Gerät ihn liefert. */
  totalWh: number | null;
}

const HOST_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;

/** Liest die Geräteliste: je Zeile `Name | Adresse | Kanal` (Kanal optional,
 *  Standard 0). `#` beginnt einen Kommentar, leere Zeilen werden übersprungen. */
export function parseDevices(text: unknown): DeviceSpec[] {
  if (typeof text !== 'string') return [];
  const out: DeviceSpec[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 2) continue;
    const [name, host, channelText] = parts;
    if (!name || !HOST_RE.test(host)) continue;
    const channel = channelText ? Number(channelText) : 0;
    out.push({ name, host, channel: Number.isInteger(channel) && channel >= 0 ? channel : 0 });
  }
  return out;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
}

/** Gen2/Plus/Pro/PM-Mini: Antwort von `/rpc/Shelly.GetStatus`. */
export function parseGen2(status: unknown, channel: number): Reading | null {
  const s = obj(status);
  if (!s) return null;
  for (const key of ['pm1', 'switch', 'cover', 'pm']) {
    const c = obj(s[`${key}:${channel}`]);
    const watts = c ? num(c.apower) : null;
    if (c && watts !== null) {
      const energy = obj(c.aenergy);
      return { watts, totalWh: energy ? num(energy.total) : null };
    }
  }
  const em1 = obj(s[`em1:${channel}`]);
  if (em1 && num(em1.act_power) !== null) {
    const data = obj(s[`em1data:${channel}`]);
    return { watts: em1.act_power as number, totalWh: data ? num(data.total_act_energy) : null };
  }
  const em = obj(s[`em:${channel}`]);
  if (em && num(em.total_act_power) !== null) {
    const data = obj(s[`emdata:${channel}`]);
    return { watts: em.total_act_power as number, totalWh: data ? num(data.total_act) : null };
  }
  return null;
}

/** Gen1 (Shelly EM, 1PM, 3EM …): Antwort von `/status`. */
export function parseGen1(status: unknown, channel: number): Reading | null {
  const s = obj(status);
  if (!s) return null;
  for (const key of ['emeters', 'meters']) {
    const list = s[key];
    if (!Array.isArray(list)) continue;
    const c = obj(list[channel]);
    const watts = c ? num(c.power) : null;
    if (c && watts !== null) return { watts, totalWh: num(c.total) };
  }
  return null;
}

export function parseStatus(gen: number, status: unknown, channel: number): Reading | null {
  return gen >= 2 ? parseGen2(status, channel) : parseGen1(status, channel);
}

/** Generation aus der Antwort von `/shelly` (Gen1 hat kein `gen`-Feld). */
export function parseGeneration(info: unknown): number {
  const o = obj(info);
  const gen = o ? num(o.gen) : null;
  return gen && gen >= 2 ? gen : 1;
}

/** "676 W" bzw. "1,24 kW". */
export function formatPower(watts: number): string {
  const w = Math.round(watts);
  if (Math.abs(w) < 1000) return `${w} W`;
  return `${(w / 1000).toFixed(2).replace('.', ',')} kW`;
}

export function formatKwh(wh: number): string {
  const kwh = wh / 1000;
  return `${kwh.toFixed(kwh >= 10 ? 1 : 2).replace('.', ',')} kWh`;
}

// ─── Tagesverbrauch aus Zählerstand-Schnappschüssen ──────────────────────────

export interface Snapshot {
  t: number;
  wh: number;
}

const SNAPSHOT_GAP_MS = 10 * 60 * 1000;
const SNAPSHOT_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** Hängt einen Zählerstand an (höchstens alle 10 Minuten) und verwirft alte. */
export function pushSnapshot(list: Snapshot[], now: number, wh: number): Snapshot[] {
  const kept = list.filter((s) => now - s.t <= SNAPSHOT_MAX_AGE_MS && s.t <= now);
  const last = kept[kept.length - 1];
  if (last && now - last.t < SNAPSHOT_GAP_MS) return kept;
  return [...kept, { t: now, wh }];
}

export interface TodayUsage {
  wh: number;
  /** Beginn der Messung, falls nicht ab Mitternacht vollständig. */
  since: number | null;
}

/** Verbrauch seit Mitternacht. Fehlt ein Schnappschuss rund um Mitternacht,
 *  gilt der älteste von heute (`since` gesetzt). Null, wenn nichts Brauchbares da ist. */
export function todayUsage(list: Snapshot[], now: number, currentWh: number): TodayUsage | null {
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const nearMidnight = list
    .filter((s) => s.t >= midnight - 30 * 60 * 1000 && s.t <= midnight + 20 * 60 * 1000)
    .sort((a, b) => Math.abs(a.t - midnight) - Math.abs(b.t - midnight))[0];
  const earliestToday = list.filter((s) => s.t >= midnight).sort((a, b) => a.t - b.t)[0];
  const base = nearMidnight ?? earliestToday;
  if (!base || currentWh < base.wh) return null;
  return { wh: currentWh - base.wh, since: nearMidnight ? null : base.t };
}

/** Kürzt eine Messreihe auf die letzten `max` Werte. */
export function pushHistory(list: number[], value: number, max: number): number[] {
  const next = list.length >= max ? list.slice(list.length - max + 1) : list.slice();
  next.push(value);
  return next;
}

/** SVG-Pfad (Linie) und Fläche für eine Messreihe in einer Box `w`×`h`. */
export function sparkPaths(values: number[], w: number, h: number): { line: string; area: string } | null {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, h - ((v - min) / span) * (h - 4) - 2] as const);
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return { line, area: `${line} L${w},${h} L0,${h} Z` };
}
