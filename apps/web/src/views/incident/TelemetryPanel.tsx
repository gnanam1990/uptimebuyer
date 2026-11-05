// Live telemetry panel (UI-SPEC §8.1, T-052): an SVG chart with a text alternative (accessible name and current-value
// summary), an equivalent data table, a pause/resume control that stops polling (and polling also stops while the
// tab is hidden), anomaly samples marked by a distinct triangle shape plus "Above threshold" text, the threshold line
// from the incident's pinned rule, and transitions that prefers-reduced-motion removes. Freshness, ingestion class,
// quality flags and SIMULATED_INPUT are shown as text; stale data never renders as healthy.
import { useState } from 'react';
import type { Telemetry } from '@uptimebuyer/api-client';
import type { Resource } from '../../api';
import { useAnnounce } from '../../announce';
import { AxisBadge } from '../../components/AxisBadge';
import { formatMilliCelsius, formatUtc } from '../../format';

const W = 640;
const H = 220;
const PAD = { l: 48, r: 12, t: 12, b: 28 };

export function TelemetryPanel({
  telemetry,
  paused,
  setPaused,
}: {
  telemetry: Resource<Telemetry | null>;
  paused: boolean;
  setPaused: (p: boolean) => void;
}) {
  const announce = useAnnounce();
  const [showTable, setShowTable] = useState(false);
  const t = telemetry.data;
  const device = t?.devices[0];
  const series = device?.series.find((s) => s.kind === 'TEMPERATURE') ?? device?.series[0];
  const samples = series?.samples ?? [];
  const threshold = t?.threshold ?? null;
  const isAnomaly = (v: number) =>
    threshold !== null && (threshold.comparator === 'ABOVE' ? v > threshold.thresholdInt : v < threshold.thresholdInt);
  const last = samples.at(-1);

  const t0 = t ? Date.parse(t.windowStart) : 0;
  const t1 = t ? Date.parse(t.asOf) : 1;
  const values = samples.map((s) => s.valueInt).concat(threshold ? [threshold.thresholdInt] : []);
  const vmin = Math.min(...values, 0) - 500;
  const vmax = Math.max(...values, 10_000) + 500;
  const x = (ms: number) => PAD.l + ((ms - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - vmin) / Math.max(1, vmax - vmin)) * (H - PAD.t - PAD.b);
  const path = samples
    .map((s, i) => `${i === 0 ? 'M' : 'L'}${x(Date.parse(s.eventAt)).toFixed(1)},${y(s.valueInt).toFixed(1)}`)
    .join(' ');
  const anomalyCount = samples.filter((s) => isAnomaly(s.valueInt)).length;
  const name = `Temperature chart, last 30 minutes, ${samples.length} samples, threshold ${threshold ? formatMilliCelsius(threshold.thresholdInt) : 'not pinned'}, ${anomalyCount} above threshold, current ${last ? formatMilliCelsius(last.valueInt) : 'not reported'}`;

  return (
    <section className="panel" role="region" aria-label="Telemetry">
      <h2>Telemetry</h2>
      {telemetry.data === null && telemetry.loading ? <p role="status">Loading telemetry…</p> : null}
      {telemetry.error ? <p className="notice notice-warning">Telemetry refresh failed: {telemetry.error}</p> : null}
      {t && t.devices.length === 0 ? (
        <p>
          <AxisBadge axis="freshness" value="NO_SIGNAL" /> No sensor is bound to this asset; health cannot be shown.
        </p>
      ) : null}
      {device ? (
        <>
          <div className="telemetry-controls">
            <button
              type="button"
              className="btn btn-secondary"
              aria-pressed={paused}
              onClick={() => {
                const next = !paused;
                setPaused(next);
                announce(
                  next
                    ? 'Live updates paused. The chart and table keep the last loaded data.'
                    : 'Live updates resumed from the server.',
                );
                if (!next) void telemetry.reload();
              }}
            >
              Pause live updates
            </button>
            <span className="muted small">
              {paused ? 'Live updates paused' : 'Updating every 5 s while this tab is visible'}
            </span>
            <AxisBadge axis="freshness" value={device.freshness} />
            {device.inputClass === 'SIMULATOR' ? <span className="label-sim">SIMULATED_INPUT</span> : null}
          </div>
          <p data-testid="current-value" className="current-value">
            {last ? (
              <>
                Current value: <strong>{formatMilliCelsius(last.valueInt)}</strong> at {formatUtc(last.eventAt)} ·{' '}
                {last.ingestionClass} · quality {last.qualityFlags.length ? last.qualityFlags.join(', ') : 'GOOD'} ·{' '}
                {freshLabel(device.freshness)}
                {device.inputClass === 'SIMULATOR' ? ' · SIMULATED_INPUT' : ''}
                {threshold
                  ? ` · threshold ${formatMilliCelsius(threshold.thresholdInt)} (${threshold.comparator.toLowerCase()})`
                  : ''}
              </>
            ) : (
              <>No reading in the last 30 minutes · {freshLabel(device.freshness)}</>
            )}
          </p>
          <figure className="chart">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              role="img"
              aria-label={name}
              preserveAspectRatio="none"
              className="chart-svg"
            >
              <rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b} className="chart-bg" />
              {threshold ? (
                <g>
                  <line
                    data-threshold-line
                    x1={PAD.l}
                    x2={W - PAD.r}
                    y1={y(threshold.thresholdInt)}
                    y2={y(threshold.thresholdInt)}
                    className="chart-threshold"
                  />
                  <text x={W - PAD.r - 4} y={y(threshold.thresholdInt) - 4} textAnchor="end" className="chart-label">
                    threshold {formatMilliCelsius(threshold.thresholdInt)}
                  </text>
                </g>
              ) : null}
              <path d={path} className="chart-line" fill="none" />
              {samples.map((s) => {
                const cx = x(Date.parse(s.eventAt));
                const cy = y(s.valueInt);
                return isAnomaly(s.valueInt) ? (
                  <polygon
                    key={s.sampleId}
                    data-point
                    data-anomaly="above-threshold"
                    data-shape="triangle"
                    points={`${cx},${cy - 6} ${cx + 6},${cy + 5} ${cx - 6},${cy + 5}`}
                    className="chart-anomaly"
                  />
                ) : (
                  <circle
                    key={s.sampleId}
                    data-point
                    data-shape="circle"
                    cx={cx}
                    cy={cy}
                    r={2.5}
                    className="chart-point"
                  />
                );
              })}
              <text x={PAD.l} y={H - 8} className="chart-label">
                {formatUtc(t?.windowStart).slice(11, 16)} UTC
              </text>
              <text x={W - PAD.r} y={H - 8} textAnchor="end" className="chart-label">
                {formatUtc(t?.asOf).slice(11, 16)} UTC
              </text>
            </svg>
            <figcaption>
              Triangles mark samples above the pinned threshold; the dashed line is the threshold. Values are
              milli-degree readings shown in °C.
            </figcaption>
          </figure>
          <button
            type="button"
            className="btn btn-secondary"
            aria-expanded={showTable}
            aria-controls="telemetry-table"
            onClick={() => setShowTable(!showTable)}
          >
            Show data table
          </button>
          <div id="telemetry-table" hidden={!showTable}>
            <div
              className="table-wrap"
              data-scroll-region
              role="region"
              aria-label="Telemetry samples table"
              tabIndex={0}
            >
              <table className="responsive">
                <caption>Telemetry samples</caption>
                <thead>
                  <tr>
                    <th scope="col">Time (UTC)</th>
                    <th scope="col">Value</th>
                    <th scope="col">Unit</th>
                    <th scope="col">Ingestion</th>
                    <th scope="col">Quality</th>
                    <th scope="col">Origin</th>
                    <th scope="col">Anomaly</th>
                  </tr>
                </thead>
                <tbody>
                  {[...samples].reverse().map((s) => (
                    <tr key={s.sampleId}>
                      <td data-label="Time (UTC)">{formatUtc(s.eventAt)}</td>
                      <td data-label="Value">{formatMilliCelsius(s.valueInt)}</td>
                      <td data-label="Unit">{s.unit}</td>
                      <td data-label="Ingestion">{s.ingestionClass}</td>
                      <td data-label="Quality">{s.qualityFlags.length ? s.qualityFlags.join(', ') : 'GOOD'}</td>
                      <td data-label="Origin">{s.inputOrigin}</td>
                      <td data-label="Anomaly">{isAnomaly(s.valueInt) ? 'Above threshold' : 'None'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}

function freshLabel(f: string): string {
  return (
    ({ FRESH: 'Fresh', STALE: 'Stale', OFFLINE: 'Offline', INVALID: 'Invalid' } as Record<string, string>)[f] ??
    'Freshness not reported'
  );
}
