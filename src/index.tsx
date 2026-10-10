import React from 'react';
import type { PluginComponentProps } from './hs-plugin';
import { hostFrameStyle } from './host-style';
import {
  gen1HasMeter,
  formatKwh,
  formatPower,
  parseDevices,
  parseGeneration,
  parseStatus,
  pushHistory,
  pushSnapshot,
  sparkPaths,
  todayUsage,
  type DeviceSpec,
  type Reading,
  type Snapshot,
} from './power-logic';

const PLUGIN_ID = 'shelly-power';
const DEFAULT_REFRESH_MS = 10000;
const HISTORY_POINTS = 180;
const PALETTE = ['#38bdf8', '#a78bfa', '#f472b6', '#fbbf24', '#34d399', '#fb923c', '#60a5fa', '#e879f9'];

type PluginFetch = (
  pluginId: string,
  options: { url: string; cacheTtlMs?: number },
) => Promise<Response>;

// Modulweit: übersteht Screenwechsel (das Modul wird dabei neu eingehängt).
const generations = new Map<string, { gen: number; hasMeter: boolean }>();
/** Geräte, die schon einmal ohne Leistungsmessung geantwortet haben — damit
 *  sie auch bei einem Ausfall unter "Schalter" bleiben statt zwischen den Messwerten. */
const switchOnly = new Set<string>();
const histories = new Map<string, number[]>();

const keyOf = (d: DeviceSpec) => `${d.host}#${d.channel}`;

function loadHistory(key: string): number[] {
  try {
    const raw = window.localStorage.getItem(`hs-shelly-hist:${key}`);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'number').slice(-HISTORY_POINTS) : [];
  } catch {
    return [];
  }
}

function saveHistory(key: string, values: number[]) {
  try {
    window.localStorage.setItem(`hs-shelly-hist:${key}`, JSON.stringify(values));
  } catch {
    // ohne localStorage geht der Verlauf beim Neuladen verloren
  }
}

async function readDevice(spec: DeviceSpec, cacheMs: number): Promise<Reading> {
  const pluginFetch = window.__HS_SDK__?.pluginFetch as PluginFetch | undefined;
  if (!pluginFetch) throw new Error('SDK nicht verfügbar');

  let known = generations.get(spec.host);
  if (known === undefined) {
    const info = await pluginFetch(PLUGIN_ID, { url: `http://${spec.host}/shelly`, cacheTtlMs: 60 * 60 * 1000 });
    if (!info.ok) throw new Error(`HTTP ${info.status}`);
    const body = await info.json();
    known = { gen: parseGeneration(body), hasMeter: gen1HasMeter(body) };
    generations.set(spec.host, known);
  }
  const url = known.gen >= 2 ? `http://${spec.host}/rpc/Shelly.GetStatus` : `http://${spec.host}/status`;
  const res = await pluginFetch(PLUGIN_ID, { url, cacheTtlMs: cacheMs });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reading = parseStatus(known.gen, await res.json(), spec.channel, known.hasMeter);
  if (!reading) throw new Error('Kein Messwert');
  return reading;
}

function loadSnapshots(key: string): Snapshot[] {
  try {
    const raw = window.localStorage.getItem(`hs-shelly-snap:${key}`);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((s) => s && typeof s.t === 'number' && typeof s.wh === 'number') : [];
  } catch {
    return [];
  }
}

function saveSnapshots(key: string, list: Snapshot[]) {
  try {
    window.localStorage.setItem(`hs-shelly-snap:${key}`, JSON.stringify(list));
  } catch {
    // localStorage nicht verfügbar: Tagesverbrauch zeigt dann nur die Sitzung.
  }
}

interface State {
  readings: Record<string, Reading | null>;
  history: Record<string, number[]>;
  today: ReturnType<typeof todayUsage>;
  updatedAt: number | null;
}

function usePower(devices: DeviceSpec[], refreshMs: number): State {
  const [state, setState] = React.useState<State>({ readings: {}, history: {}, today: null, updatedAt: null });
  const listKey = devices.map(keyOf).join(',');

  React.useEffect(() => {
    let cancelled = false;
    const specs = devices;

    async function poll() {
      const results = await Promise.allSettled(specs.map((d) => readDevice(d, Math.max(2000, refreshMs / 2))));
      if (cancelled) return;
      const now = Date.now();
      const readings: Record<string, Reading | null> = {};
      const history: Record<string, number[]> = {};
      results.forEach((r, i) => {
        const key = keyOf(specs[i]);
        if (r.status === 'fulfilled') {
          readings[key] = r.value;
          if (r.value.watts === null) {
            switchOnly.add(key);
          } else {
            switchOnly.delete(key);
            const next = pushHistory(histories.get(key) ?? loadHistory(key), r.value.watts, HISTORY_POINTS);
            histories.set(key, next);
            if (i === 0) saveHistory(key, next);
          }
        } else {
          readings[key] = null;
        }
        history[key] = histories.get(key) ?? [];
      });

      let today: State['today'] = null;
      const main = specs[0];
      const mainReading = main ? readings[keyOf(main)] : null;
      if (main && mainReading && mainReading.totalWh !== null) {
        const key = keyOf(main);
        const snaps = pushSnapshot(loadSnapshots(key), now, mainReading.totalWh);
        saveSnapshots(key, snaps);
        today = todayUsage(snaps, now, mainReading.totalWh);
      }
      setState({ readings, history, today, updatedAt: now });
    }

    poll();
    const id = setInterval(poll, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey, refreshMs]);

  return state;
}

function Spark({ values, color }: { values: number[]; color: string }) {
  const W = 400;
  const H = 100;
  const paths = values.length >= 6 ? sparkPaths(values, W, H) : null;
  if (!paths) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', fontSize: '0.7em', opacity: 0.45 }}>
        Verlauf wird aufgebaut …
      </div>
    );
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: '100%', display: 'block' }}>
      <defs>
        <linearGradient id="hs-shelly-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.45" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={paths.area} fill="url(#hs-shelly-fill)" />
      <path d={paths.line} fill="none" stroke={color} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Row({ name, watts, max, color, dim }: { name: string; watts: number | null; max: number; color: string; dim?: boolean }) {
  const pct = watts !== null && max > 0 ? Math.min(100, Math.max(2, (Math.max(0, watts) / max) * 100)) : 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25em', opacity: dim ? 0.7 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5em' }}>
        <span style={{ fontSize: '0.95em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <span style={{ fontSize: '1.05em', fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {watts === null ? '–' : formatPower(watts)}
        </span>
      </div>
      <div style={{ height: '0.35em', borderRadius: '0.2em', background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: color,
            borderRadius: '0.2em',
            transition: 'width 0.8s ease',
          }}
        />
      </div>
    </div>
  );
}

export default function ShellyPowerPlugin({ config, style }: PluginComponentProps) {
  const devices = React.useMemo(
    () => parseDevices(config.devices),
    [config.devices],
  );
  const refreshMs = Math.max(5000, Number(config.refreshIntervalMs) || DEFAULT_REFRESH_MS);
  const title = typeof config.title === 'string' ? config.title.trim() : 'Strom';
  const state = usePower(devices, refreshMs);

  const main = devices[0];
  const others = devices.slice(1);
  // Geräte ohne Leistungsmessung (nur An/Aus) getrennt von den Messwerten.
  const rest = others.filter((d) => !switchOnly.has(keyOf(d)));
  const switches = others.filter((d) => switchOnly.has(keyOf(d)));
  const mainReading = main ? state.readings[keyOf(main)] : null;
  const mainWatts = mainReading?.watts ?? null;
  const loaded = state.updatedAt !== null;
  const sum = rest.reduce((acc, d) => acc + (state.readings[keyOf(d)]?.watts ?? 0), 0);
  const other = mainWatts !== null && rest.length > 0 ? mainWatts - sum : null;
  const barMax = Math.max(mainWatts ?? 0, sum, 1);
  const accent = PALETTE[0];

  return (
    <div style={{ ...hostFrameStyle(style), display: 'flex', flexDirection: 'column', gap: '0.7em' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: '1.3em', fontWeight: 600 }}>{title}</span>
        {loaded && !mainReading && <span style={{ fontSize: '0.7em', opacity: 0.6 }}>keine Verbindung</span>}
      </div>

      {devices.length === 0 && <div style={{ fontSize: '0.85em', opacity: 0.6 }}>Keine Geräte eingetragen.</div>}

      {main && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: '0.8em', opacity: 0.6 }}>{main.name} jetzt</div>
          <div style={{ fontSize: '3em', fontWeight: 300, lineHeight: 1.05, fontVariantNumeric: 'tabular-nums' }}>
            {mainWatts !== null ? formatPower(mainWatts) : loaded ? '–' : '…'}
          </div>
          {state.today && (state.today.since === null || Date.now() - state.today.since >= 30 * 60 * 1000) && (
            <div style={{ fontSize: '0.85em', opacity: 0.75, marginTop: '0.2em' }}>
              {state.today.since === null
                ? 'Heute '
                : `Seit ${new Date(state.today.since).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} `}
              <strong>{formatKwh(state.today.wh)}</strong>
            </div>
          )}
        </div>
      )}

      {main && (
        <div style={{ flex: '1 1 0', minHeight: '4em', maxHeight: '9em' }}>
          <Spark values={state.history[keyOf(main)] ?? []} color={accent} />
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7em' }}>
        {rest.map((d, i) => (
          <Row
            key={keyOf(d)}
            name={d.name}
            watts={state.readings[keyOf(d)]?.watts ?? null}
            max={barMax}
            color={PALETTE[(i + 1) % PALETTE.length]}
          />
        ))}
        {other !== null && other > 1 && (
          <Row name="Übrige Verbraucher" watts={other} max={barMax} color="rgba(255,255,255,0.45)" dim />
        )}
      </div>

      {switches.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.45em',
            paddingTop: '0.6em',
            borderTop: '1px solid rgba(255,255,255,0.1)',
          }}
        >
          <span style={{ fontSize: '0.7em', opacity: 0.55, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Weitere Shellys
          </span>
          {switches.map((d) => {
            const reading = state.readings[keyOf(d)];
            const on = reading ? reading.on : null;
            return (
              <div key={keyOf(d)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5em' }}>
                <span style={{ fontSize: '0.95em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.name}
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4em', fontSize: '0.9em', opacity: 0.9 }}>
                  <span
                    style={{
                      width: '0.55em',
                      height: '0.55em',
                      borderRadius: '50%',
                      background: on === null ? 'rgba(255,255,255,0.3)' : on ? '#34d399' : 'rgba(255,255,255,0.35)',
                      boxShadow: on ? '0 0 0.5em #34d399' : 'none',
                    }}
                  />
                  {on === null ? '–' : on ? 'An' : 'Aus'}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
