// Spring easings for the console's CSS transitions, as CSS `linear()` curves sampled from a damped spring.
// Ported from Motion (motiondivision/motion, MIT, commit f95ab9418d9524b906c8681994b95d15cb03d5fc):
// `generateLinearEasing` in packages/motion-dom/src/animation/waapi/utils/linear.ts, and the bounce -> damping-ratio
// and visual-duration -> stiffness mapping in packages/motion-dom/src/animation/generators/spring.ts. Motion resolves
// the spring numerically; this port uses the closed-form position of a spring released from rest, which is the same
// curve for these inputs. Nothing here runs in the browser: the curves are generated once and written into
// styles.css as tokens, and apps/web/test/studio-spring-tokens.test.ts fails if a token drifts from this generator.

export type Easing = (progress: number) => number;

/** Motion's mapping from "bounce" to a damping ratio: 0 is critically damped, towards 1 is bouncier. */
export const bounceToDampingRatio = (bounce: number): number =>
  bounce < 0 ? 1 / Math.max(1 + bounce, 0.05) : Math.max(1 - bounce, 0.05);

/**
 * A spring from 0 to 1 released at rest, as an easing over `durationMs`. `visualDurationS` is the time the motion
 * appears to take (Motion's `visualDuration`); `bounce` 0 never overshoots the target.
 */
export function springEasing({
  bounce,
  visualDurationS,
  durationMs,
}: {
  bounce: number;
  visualDurationS: number;
  durationMs: number;
}): Easing {
  const zeta = bounceToDampingRatio(bounce);
  if (zeta > 1) throw new Error('overdamped springs are not used by the console');
  // Motion: root = 2π / (visualDuration × 1.2); stiffness = root², so the undamped angular frequency is root.
  const w0 = (2 * Math.PI) / (visualDurationS * 1.2);
  const position = (tS: number): number => {
    if (zeta === 1) return 1 - Math.exp(-w0 * tS) * (1 + w0 * tS);
    const w1 = w0 * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * w0 * tS);
    return 1 - decay * (Math.cos(w1 * tS) + ((zeta * w0) / w1) * Math.sin(w1 * tS));
  };
  return (p) => (p >= 1 ? 1 : position((p * durationMs) / 1000));
}

/** Motion's `generateLinearEasing`: sample an easing every `resolution` ms into a CSS `linear()` function. */
export function generateLinearEasing(easing: Easing, duration: number, resolution = 10): string {
  let points = '';
  const numPoints = Math.max(Math.round(duration / resolution), 2);
  for (let i = 0; i < numPoints; i++) points += Math.round(easing(i / (numPoints - 1)) * 10000) / 10000 + ', ';
  return `linear(${points.substring(0, points.length - 2)})`;
}

/**
 * The console's two springs. `settle` (critically damped, never past the target) moves the faceplate thermal scale and
 * the fleet signal-mix bar, so a reading is never drawn beyond where it is. `glide` (a slight bounce) moves the incident
 * section indicator, which carries no value.
 */
export const SPRINGS = {
  settle: { bounce: 0, visualDurationS: 0.4, durationMs: 700, resolution: 20 },
  glide: { bounce: 0.15, visualDurationS: 0.22, durationMs: 420, resolution: 20 },
} as const;

export function springToken(name: keyof typeof SPRINGS): string {
  const s = SPRINGS[name];
  return generateLinearEasing(springEasing(s), s.durationMs, s.resolution);
}
