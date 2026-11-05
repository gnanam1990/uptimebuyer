// One status on one axis: text label + icon shape + accessible description, never color alone (UI-SPEC §5.2, NFR-07).
// data-axis / data-value / data-tone expose the exact server value for tests and tooling.
import { describeAxis, type Axis, type Shape } from '../status/axes';

const PATHS: Record<Shape, string> = {
  check: 'M3 8.5l3 3 7-7',
  triangle: 'M8 2l6.5 11.5h-13z',
  octagon: 'M5 1.5h6l3.5 3.5v6l-3.5 3.5h-6L1.5 11V5z',
  circle: 'M8 2a6 6 0 1 0 0.01 0z',
  diamond: 'M8 1.5l6.5 6.5-6.5 6.5L1.5 8z',
  question: 'M5.5 5.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.7M8 12.5v.5',
  dash: 'M3 8h10',
  clock: 'M8 2a6 6 0 1 0 0.01 0zM8 4.5V8l2.5 1.5',
  pause: 'M5.5 3.5v9M10.5 3.5v9',
  square: 'M3 3h10v10H3z',
};

export function Icon({ shape }: { shape: Shape }) {
  const filled = shape === 'triangle' || shape === 'octagon' || shape === 'diamond' || shape === 'square';
  return (
    <svg
      className="axis-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
      data-shape={shape}
    >
      <path
        d={PATHS[shape]}
        fill={filled ? 'currentColor' : 'none'}
        fillOpacity={filled ? 0.25 : 0}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AxisBadge({ axis, value, prefix }: { axis: Axis; value: string | null | undefined; prefix?: string }) {
  const v = describeAxis(axis, value);
  return (
    <span className={`axis tone-${v.tone}`} data-axis={axis} data-value={v.value} data-tone={v.tone}>
      <Icon shape={v.shape} />
      {prefix ? (
        <span aria-hidden="true" className="axis-prefix">
          {prefix}
        </span>
      ) : null}
      <span className="axis-label" aria-hidden="true">
        {v.label}
      </span>
      <span className="sr-only">{`${prefix ?? v.axisLabel}: ${v.label}. ${v.description}`}</span>
    </span>
  );
}
