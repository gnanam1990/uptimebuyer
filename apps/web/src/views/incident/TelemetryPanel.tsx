// Live telemetry panel (UI-SPEC §8.1, T-052): an SVG chart with a text alternative (accessible name and current-value
// summary), an equivalent data table, a pause/resume control that stops polling (and polling also stops while the
// tab is hidden), anomaly samples marked by a distinct triangle shape plus "Above threshold" text, the threshold line
// from the incident's pinned rule, and transitions that prefers-reduced-motion removes. Freshness, ingestion class,
// quality flags and SIMULATED_INPUT are shown as text; stale data never renders as healthy.
// The chart's coordinate system follows its rendered width (one SVG unit = one CSS px), so axis text never stretches
// and stays 12 px at every width; nothing is positioned with inline styles (CSP).
import { useLayoutEffect, useState } from 'react';
import type { Telemetry } from '@uptimebuyer/api-client';
import type { Resource } from '../../api';
import { useAnnounce } from '../../announce';
import { AxisBadge } from '../../components/AxisBadge';
import { formatMilliCelsius, formatUtc } from '../../format';
import { gridTicks } from './chartTicks.js';
import { selectReading } from './readout';

const PAD = { l: 52, r: 14, t: 14, b: 30 };

/** Follow an element's content width (initially `fallback`), for a chart that redraws instead of scaling. */
function useWidth<T extends HTMLElement>(fallback: number) {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setWidth(Math.max(240, Math.round(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width] as const;
}

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
  const [frameRef, W] = useWidth<HTMLDivElement>(640);
  const H = W < 480 ? 200 : 240;
  const t = telemetry.data;
  // Same device and series as the incident faceplate (./readout.ts).
  const { device, samples, last, threshold, simulated } = selectReading(t);
  // After a failed refresh the retained freshness is not current and is not shown as if it were.
  const failed = telemetry.error !== null;
  const isAnomaly = (v: number) =>
    threshold !== null && (threshold.comparator === 'ABOVE' ? v > threshold.thresholdInt : v < threshold.thresholdInt);

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
  // Horizontal grid every 2 °C or more (milli-degrees), labelled on the left; bounded for any reported value.
  const ticks = gridTicks(vmin, vmax);
  const plotTop = PAD.t;
  const plotBottom = H - PAD.b;
  const ty = threshold ? y(threshold.thresholdInt) : null;

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
            {failed ? (
              <span className="tag-unknown">Freshness not current: the latest refresh failed</span>
            ) : (
              <AxisBadge axis="freshness" value={device.freshness} />
            )}
            {simulated ? <span className="label-sim">SIMULATED_INPUT</span> : null}
          </div>
          <div data-testid="current-value" className="current-value">
            {last ? (
              <>
                <span className="cv-primary">
                  {failed ? 'Last loaded value' : 'Current value'}: <strong>{formatMilliCelsius(last.valueInt)}</strong>{' '}
                  at {formatUtc(last.eventAt)}
                </span>
                <span className="cv-fact">
                  <span>Ingestion</span> {last.ingestionClass}
                </span>
                <span className="cv-fact">
                  <span>Quality</span> {last.qualityFlags.length ? last.qualityFlags.join(', ') : 'GOOD'}
                </span>
                <span className="cv-fact">
                  <span>Freshness</span> {failed ? 'Not current (latest refresh failed)' : freshLabel(device.freshness)}
                </span>
                {simulated ? (
                  <span className="cv-fact">
                    <span>Input</span> SIMULATED_INPUT
                  </span>
                ) : null}
                {threshold ? (
                  <span className="cv-fact">
                    <span>Threshold</span> {formatMilliCelsius(threshold.thresholdInt)} (
                    {threshold.comparator.toLowerCase()})
                  </span>
                ) : null}
              </>
            ) : (
              <span className="cv-primary">
                No reading in the last 30 minutes ·{' '}
                {failed ? 'Freshness not current (latest refresh failed)' : freshLabel(device.freshness)}
              </span>
            )}
          </div>
          <figure className="chart">
            <div className="chart-frame" ref={frameRef}>
              <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={name} className="chart-svg">
                <rect
                  x={PAD.l}
                  y={plotTop}
                  width={W - PAD.l - PAD.r}
                  height={plotBottom - plotTop}
                  className="chart-bg"
                />
                {ty !== null && threshold ? (
                  <rect
                    x={PAD.l}
                    width={W - PAD.l - PAD.r}
                    y={threshold.comparator === 'ABOVE' ? plotTop : ty}
                    height={Math.max(0, threshold.comparator === 'ABOVE' ? ty - plotTop : plotBottom - ty)}
                    className="chart-band"
                  />
                ) : null}
                {ticks.map((v) => (
                  <g key={v}>
                    <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="chart-grid" />
                    <text x={PAD.l - 8} y={y(v) + 4} textAnchor="end" className="chart-label">
                      {(v / 1000).toFixed(0)} °C
                    </text>
                  </g>
                ))}
                {threshold && ty !== null ? (
                  <g>
                    <line data-threshold-line x1={PAD.l} x2={W - PAD.r} y1={ty} y2={ty} className="chart-threshold" />
                    <text
                      x={PAD.l + 8}
                      y={threshold.comparator === 'ABOVE' ? ty - 6 : ty + 16}
                      className="chart-label chart-label-threshold"
                    >
                      Threshold {formatMilliCelsius(threshold.thresholdInt)}
                    </text>
                  </g>
                ) : null}
                {/* Keyed by width: a new reading eases the line, a resize redraws it without sweeping across. */}
                <path key={W} d={path} className="chart-line" fill="none" />
                {samples.map((s) => {
                  const cx = x(Date.parse(s.eventAt));
                  const cy = y(s.valueInt);
                  return isAnomaly(s.valueInt) ? (
                    <polygon
                      key={s.sampleId}
                      data-point
                      data-anomaly="above-threshold"
                      data-shape="triangle"
                      points={`${cx},${cy - 7} ${cx + 7},${cy + 5} ${cx - 7},${cy + 5}`}
                      className="chart-anomaly"
                    />
                  ) : (
                    <circle
                      key={s.sampleId}
                      data-point
                      data-shape="circle"
                      cx={cx}
                      cy={cy}
                      r={3}
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
            </div>
            <figcaption>
              Triangles mark samples above the pinned threshold; the dashed line is the threshold and the shaded band is
              the range beyond it. Values are milli-degree readings shown in °C.
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
