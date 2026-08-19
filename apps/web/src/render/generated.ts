/**
 * Per-link generated geometry — 04 §12.1 (belts, gear mesh) and §12.2 (ropes,
 * pulleys).
 *
 * These are the only object-count-linear draws in the frame (09 §4), and they
 * are the visuals D9 chose to resolve U8 *without touching physics or schema*:
 * a `gearMesh` renders by ratio sign and pitch-circle contact, and none of it
 * changes what the solver does. So this module is pure geometry — it takes the
 * canonical scene and returns polylines — and the only rule it enforces is that
 * a picture it cannot draw honestly says so (`degenerate`) rather than drawing
 * something plausible.
 *
 * ## A correction to 04 §12.2's rope sag, made here
 *
 * §12.2 says slack "renders as a quadratic sag between endpoints (depth ∝
 * slack)". Depth linear in slack is wrong in a way that shows: a parabola of
 * chord `L` and depth `h` has arc length ≈ `L(1 + 8h²/3L²)`, so matching the
 * drawn curve to the rope's actual length gives `h = √(3·L·slack/8)` — depth
 * grows with the **square root** of slack, not linearly. The linear rule draws a
 * curve longer than the rope it depicts as soon as the slack is appreciable,
 * which for a rope is exactly the state the author is looking at. The √ form is
 * used, and it is not a tuned constant: it is the depth at which the drawn curve
 * is the length of the rope (04 §17).
 *
 * Contract: docs/04-BUILDER-UX.md §12.1–§12.2; docs/02-SCENE-FORMAT.md §6.2.
 */

import type { Id, Vec2 } from '@physics/scene-format';
import type { CanonicalLink, CanonicalObject, CanonicalScene } from '@physics/engine/geometry';
import { resolveAnchor } from '@physics/engine/geometry';

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const len = (v: Vec2): number => Math.sqrt(v[0] * v[0] + v[1] * v[1]);
const norm = (v: Vec2): Vec2 => {
  const l = len(v) || 1;
  return [v[0] / l, v[1] / l];
};

// ---------------------------------------------------------------------------
// Ribbons along a polyline (curves, belts)
// ---------------------------------------------------------------------------

/**
 * Offset a polyline into a ribbon of the given thickness.
 *
 * Used for curve rails and belt runs. The curve case traces the *collider*
 * centres rather than the ideal arc, which is a deliberate 0.2 %-of-radius
 * difference: 03 §5.3 exists so the picture and the physics cannot drift, and
 * the boxes are what the marble actually rolls on.
 */
export function ribbon(path: readonly Vec2[], thickness: number): { left: Vec2[]; right: Vec2[] } {
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  const half = thickness / 2;
  for (let i = 0; i < path.length; i++) {
    const p = path[i] as Vec2;
    const prev = path[i - 1] ?? p;
    const next = path[i + 1] ?? p;
    const t = norm(sub(next, prev));
    const n: Vec2 = [-t[1], t[0]];
    left.push([p[0] + n[0] * half, p[1] + n[1] * half]);
    right.push([p[0] - n[0] * half, p[1] - n[1] * half]);
  }
  return { left, right };
}

// ---------------------------------------------------------------------------
// Rope sag (04 §12.2)
// ---------------------------------------------------------------------------

/**
 * Sag depth for a rope of `length` spanning `chord`.
 *
 * Zero when taut. Capped at `length / 2`, the fully-slack limit — a rope with
 * both ends at one point hangs straight down and doubles back, and no parabola
 * describes that, so the cap is where the approximation is retired rather than
 * extrapolated.
 */
export function sagDepth(chord: number, length: number): number {
  const slack = length - chord;
  if (!(slack > 0)) return 0;
  return Math.min(length / 2, Math.sqrt((3 * chord * slack) / 8));
}

/**
 * Sampled quadratic sag from `a` to `b`, hanging along `gravityDir`.
 *
 * The sag follows the scene's gravity rather than screen-down, so a rope on a
 * tilted board (`planeAngle ≠ 0`) hangs the way the simulation would hang it.
 */
export function ropeSag(a: Vec2, b: Vec2, length: number, gravityDir: Vec2, samples = 12): Vec2[] {
  const chord = len(sub(b, a));
  const depth = sagDepth(chord, length);
  const out: Vec2[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    // 4t(1−t) is the unit parabola: 0 at both ends, 1 at the middle.
    const drop = depth * 4 * t * (1 - t);
    out.push([
      a[0] + (b[0] - a[0]) * t + gravityDir[0] * drop,
      a[1] + (b[1] - a[1]) * t + gravityDir[1] * drop,
    ]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Belts and gear mesh (04 §12.1, D9)
// ---------------------------------------------------------------------------

export type BeltStyle = 'glint' | 'open' | 'crossed' | 'degenerate';

export interface BeltVisual {
  linkId: Id;
  style: BeltStyle;
  /** Tangent points, `[fromA, toB, fromB, toA]`, empty when degenerate. */
  tangents: readonly Vec2[];
  /** Centre-line fallback (`degenerate`) or the contact point (`glint`). */
  marks: readonly Vec2[];
  /** Surface speed for the UV scroll, m/s — `ω_A·r_A` (04 §12.1). */
  surfaceSpeed: number;
  /** `degenerate` carries the warning tint (04 §12.1). */
  warn: boolean;
}

/**
 * Common tangents between two circles.
 *
 * `outer` (an open belt: both wheels turn the same way) exists unless one circle
 * contains the other; `inner` (a crossed belt: counter-rotation, which is what a
 * negative `ratio` at a distance means, 02 §6.2) exists only once the circles are
 * clear of each other. `null` is the honest answer in the excluded cases — 04
 * §12.1 asks for a dashed centre-line there, not a guessed ribbon.
 */
export function commonTangents(
  cA: Vec2,
  rA: number,
  cB: Vec2,
  rB: number,
  kind: 'outer' | 'inner',
): { a1: Vec2; b1: Vec2; b2: Vec2; a2: Vec2 } | null {
  const d = len(sub(cB, cA));
  const dr = kind === 'outer' ? rA - rB : rA + rB;
  if (d <= 1e-9 || Math.abs(dr) > d) return null;
  const base = Math.atan2(cB[1] - cA[1], cB[0] - cA[0]);
  const alpha = Math.acos(dr / d);
  const sign = kind === 'outer' ? 1 : -1;
  const at = (c: Vec2, r: number, angle: number): Vec2 => [c[0] + r * Math.cos(angle), c[1] + r * Math.sin(angle)];
  return {
    a1: at(cA, rA, base + alpha),
    b1: at(cB, sign * rB, base + alpha),
    b2: at(cB, sign * rB, base - alpha),
    a2: at(cA, rA, base - alpha),
  };
}

/** Pitch circles touch within the §6.4 tolerance — D9's geometric mesh. */
export function pitchCirclesTouch(cA: Vec2, rA: number, cB: Vec2, rB: number, tol: number): boolean {
  return Math.abs(len(sub(cB, cA)) - (rA + rB)) <= tol;
}

/**
 * The visual for one `gearMesh` link — D9's four cases, in the order 04 §12.1
 * tabulates them.
 *
 * `ratio` absent means the mesh is geometric (the editor created it on a
 * pitch-circle snap), so touching is the expected state and a glint is the
 * picture. An explicit ratio is a drive at a distance: positive = open belt,
 * negative = crossed.
 */
export function beltVisual(
  link: CanonicalLink,
  a: CanonicalObject,
  b: CanonicalObject,
  angVelA: number,
  tol: number,
): BeltVisual {
  const rA = (a.props as { r?: number }).r ?? 0;
  const rB = (b.props as { r?: number }).r ?? 0;
  const ratio = (link.props as { ratio?: number }).ratio;
  const surfaceSpeed = angVelA * rA;
  const touching = pitchCirclesTouch(a.pos, rA, b.pos, rB, tol);

  if (ratio === undefined || touching) {
    const dir = norm(sub(b.pos, a.pos));
    const contact: Vec2 = [a.pos[0] + dir[0] * rA, a.pos[1] + dir[1] * rA];
    return { linkId: link.id, style: 'glint', tangents: [], marks: [contact], surfaceSpeed, warn: false };
  }

  const kind = ratio >= 0 ? 'outer' : 'inner';
  const t = commonTangents(a.pos, rA, b.pos, rB, kind);
  if (!t) {
    return {
      linkId: link.id,
      style: 'degenerate',
      tangents: [],
      marks: [a.pos, b.pos],
      surfaceSpeed,
      warn: true,
    };
  }
  return {
    linkId: link.id,
    style: kind === 'outer' ? 'open' : 'crossed',
    tangents: [t.a1, t.b1, t.b2, t.a2],
    marks: [],
    surfaceSpeed,
    warn: false,
  };
}

// ---------------------------------------------------------------------------
// Rope routing (04 §12.2)
// ---------------------------------------------------------------------------

export interface RopeVisual {
  linkId: Id;
  /** World polyline, including the sag or the pulley route. */
  path: readonly Vec2[];
  /** True when the drawn path is a sag rather than a straight/taut run. */
  slack: boolean;
}

/**
 * Route one rope for drawing.
 *
 * Three cases, in 04 §12.2's order: an ideal rope sags between its endpoints; a
 * `via` rope runs to each pulley's **rim** rather than its centre — the ≤ r
 * discrepancy against the constraint (03 §8.2 uses centres) is accepted and
 * documented there — and a segmented rope is not drawn here at all, because its
 * `segN` bodies are real instances that arrive in the frame buffer.
 */
export function ropeVisual(link: CanonicalLink, scene: CanonicalScene, gravityDir: Vec2): RopeVisual | null {
  const objA = scene.byId.get(link.a.obj);
  const objB = scene.byId.get(link.b.obj);
  if (!objA || !objB) return null;
  const props = link.props as { via?: readonly Id[]; segments?: number; length?: number };
  if ((props.segments ?? 0) >= 2 && (props.via ?? []).length === 0) return null; // drawn as bodies

  const a = resolveAnchor(objA, link.a).world;
  const b = resolveAnchor(objB, link.b).world;
  const via = props.via ?? [];
  if (via.length === 0) {
    const length = props.length ?? len(sub(b, a));
    const depth = sagDepth(len(sub(b, a)), length);
    if (depth <= 0) return { linkId: link.id, path: [a, b], slack: false };
    return { linkId: link.id, path: ropeSag(a, b, length, gravityDir), slack: true };
  }

  // Over pulleys: rim-to-rim, so the rope visually wraps the wheel.
  const path: Vec2[] = [a];
  let from = a;
  for (const id of via) {
    const wheel = scene.byId.get(id);
    if (!wheel) continue;
    const r = (wheel.props as { r?: number }).r ?? 0;
    const inDir = norm(sub(wheel.pos, from));
    path.push([wheel.pos[0] - inDir[0] * r, wheel.pos[1] - inDir[1] * r]);
    path.push([wheel.pos[0] + inDir[0] * r, wheel.pos[1] + inDir[1] * r]);
    from = wheel.pos;
  }
  path.push(b);
  return { linkId: link.id, path, slack: false };
}
