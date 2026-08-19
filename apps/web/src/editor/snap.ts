/**
 * The snapping system — 04 §6.
 *
 * Four mechanisms, and §6.2 fixes the order they resolve in:
 *
 *     surface seat  >  grid  >  edge/centre alignment  >  equal spacing
 *
 * That ladder is quoted rather than interpreted: the first applicable rule
 * wins outright. It has a consequence worth naming, because it is the kind of
 * thing that looks like a bug later — with the grid on (the default) alignment
 * and spacing never move the ghost, so they read as *guides* until the user
 * presses `G`. Both are still computed and returned so the canvas can draw
 * them; only the chosen position obeys the ladder.
 *
 * Nothing here is inside the determinism surface. Snapping decides what number
 * the author authored; once authored, the number is quantized (02 §2) and
 * simulated like any other.
 */

import type { Id, ObjectType, Scene, Vec2 } from '@physics/scene-format';
import type { CanonicalObject, CanonicalScene } from '@physics/engine/geometry';
import { canonicalize, objectGeometry } from '@physics/engine/geometry';
import { EDITOR, gearSnapTol } from './model.js';
import { aabbOf, gravityDir, rayShapes, support, worldShapes, type Aabb } from './shapes.js';
import { q } from './write.js';

/** 04 §5.2: the cast only ever seats on static geometry, and only on these. */
export const SURFACE_SNAP_TARGETS: readonly ObjectType[] = ['platform', 'ramp', 'curve', 'conveyor'];

/** Grid snap (04 §6.1). `step <= 0` or Alt-held means no snapping at all. */
export function snapToGrid(pos: Vec2, step: number): Vec2 {
  if (!(step > 0)) return [q(pos[0]), q(pos[1])];
  return [q(Math.round(pos[0] / step) * step), q(Math.round(pos[1] / step) * step)];
}

/** Rotation snap: 15°, or 1° with Alt (04 §6.1). Numeric entry is never snapped. */
export function snapRotation(deg: number, fine = false): number {
  const step = fine ? EDITOR.ROT_SNAP_FINE_DEG : EDITOR.ROT_SNAP_DEG;
  return q(Math.round(deg / step) * step);
}

/** Arrow-key nudge (04 §5.4): one snap step, ×5 with Shift, 1 mm with Alt. */
export function nudgeDistance(snapStep: number, mods: { shift?: boolean; alt?: boolean } = {}): number {
  if (mods.alt) return EDITOR.NUDGE_FINE_M;
  return snapStep * (mods.shift ? EDITOR.NUDGE_LARGE_FACTOR : 1);
}

// ---------------------------------------------------------------------------
// A canonical view of the document, for geometry queries
// ---------------------------------------------------------------------------

/**
 * Geometry cache for one document state.
 *
 * Every §6 query needs expanded geometry, and expansion is not free: rebuilding
 * it per pointer-move over a 5 000-object scene would be the one place the
 * editor could plausibly drop frames. The canonical scene is built once per
 * document version and the per-object shapes are memoized on first touch.
 */
export class GeometryView {
  readonly canonical: CanonicalScene;
  private readonly shapeCache = new Map<Id, ReturnType<typeof worldShapes>>();
  private readonly aabbCache = new Map<Id, Aabb | null>();

  constructor(scene: Scene) {
    this.canonical = canonicalize(scene);
  }

  object(id: Id): CanonicalObject | undefined {
    return this.canonical.byId.get(id);
  }

  shapes(id: Id): ReturnType<typeof worldShapes> {
    const cached = this.shapeCache.get(id);
    if (cached) return cached;
    const obj = this.canonical.byId.get(id);
    const shapes = obj ? worldShapes(objectGeometry(obj)) : [];
    this.shapeCache.set(id, shapes);
    return shapes;
  }

  aabb(id: Id): Aabb | null {
    if (this.aabbCache.has(id)) return this.aabbCache.get(id) ?? null;
    const box = aabbOf(this.shapes(id));
    this.aabbCache.set(id, box);
    return box;
  }

  ids(): Id[] {
    return this.canonical.objects.map((o) => o.id);
  }
}

/**
 * A not-yet-placed object, expanded for geometry queries.
 *
 * The ghost is canonicalized through the same path a real object takes, so its
 * defaults, its reference point and its collider set are the ones it will have
 * the instant it is placed — which is the whole point of a preview.
 */
export function ghostGeometry(
  type: ObjectType,
  pos: Vec2,
  rot: number,
  props: Record<string, unknown> = {},
  engineVersion = '0.0.0',
): CanonicalObject {
  const scene: Scene = {
    schemaVersion: 1,
    engineVersion,
    world: {},
    objects: [{ id: 'ghost', type, pos, rot, props } as never],
  };
  return canonicalize(scene).byId.get('ghost') as CanonicalObject;
}

// ---------------------------------------------------------------------------
// Surface snap — the "smart drop" (04 §5.2)
// ---------------------------------------------------------------------------

export interface SurfaceSeat {
  /** Where the ghost's reference point goes so it rests on the surface. */
  pos: Vec2;
  /** The static object it seated on. */
  on: Id;
  /** How far the ghost moved along gravity to get there, meters. */
  drop: number;
}

/**
 * Seat a ghost on the static surface below it (04 §5.2).
 *
 * "Below" is along the *gravity* direction, `rotate((0,−1), planeAngle)` — on a
 * tilted board the drop is not down the screen. The cast starts at the ghost's
 * own lowest point rather than at its reference point, which is what makes the
 * rule "reference-point aware: a domino lands on its base": a domino's
 * reference point already *is* its base, a marble's is its centre, and using
 * the support along gravity handles both without a per-type table.
 *
 * Dynamic bodies are never targets — predicting rest on something that is about
 * to move is a lie (04 §5.2).
 */
export function surfaceSeat(
  view: GeometryView,
  ghost: CanonicalObject,
  opts: { range?: number; ignore?: ReadonlySet<Id> } = {},
): SurfaceSeat | null {
  const range = opts.range ?? EDITOR.SURFACE_SNAP_RANGE_M;
  const dir = gravityDir(view.canonical.world.planeAngle);
  const ghostShapes = worldShapes(objectGeometry(ghost));
  if (ghostShapes.length === 0) return null;

  // Distance from the reference point to the ghost's lowest extent along
  // gravity. `support` is a projection onto `dir`, and the reference point
  // projects to `pos · dir`, so the difference is the overhang below it.
  const refProjection = ghost.pos[0] * dir[0] + ghost.pos[1] * dir[1];
  const overhang = support(ghostShapes, dir) - refProjection;
  const origin: Vec2 = [ghost.pos[0] + dir[0] * overhang, ghost.pos[1] + dir[1] * overhang];

  let best: SurfaceSeat | null = null;
  for (const obj of view.canonical.objects) {
    if (obj.id === ghost.id || opts.ignore?.has(obj.id)) continue;
    if (!SURFACE_SNAP_TARGETS.includes(obj.type)) continue;
    // `anchored` cannot make a dynamic type a seat target: the rule is about
    // the *catalog* type being scenery, not about this instance being frozen.
    const t = rayShapes(origin, dir, view.shapes(obj.id), range);
    if (t === null) continue;
    if (best === null || t < best.drop) {
      best = { pos: [q(ghost.pos[0] + dir[0] * t), q(ghost.pos[1] + dir[1] * t)], on: obj.id, drop: t };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Smart guides (04 §6.2)
// ---------------------------------------------------------------------------

export interface AlignmentGuide {
  axis: 'x' | 'y';
  /** The world coordinate the guide line sits at. */
  at: number;
  /** The object whose edge or centre produced it. */
  with: Id;
  /** How far the ghost must move to land on it. */
  delta: number;
}

export interface SmartGuides {
  guides: AlignmentGuide[];
  /** Best per-axis alignment within `ALIGN_SNAP_M`, if any. */
  snap: { x?: AlignmentGuide; y?: AlignmentGuide };
  /** The equal-spacing continuation, if the two nearest same-type objects offer one. */
  spacing: { pos: Vec2; from: [Id, Id]; distance: number } | null;
}

/** Candidate objects near the ghost — spatial pre-filter for §6.2. */
function nearbyCandidates(view: GeometryView, at: Vec2, ignore: ReadonlySet<Id>): CanonicalObject[] {
  const r2 = EDITOR.SMART_GUIDE_RADIUS_M * EDITOR.SMART_GUIDE_RADIUS_M;
  return view.canonical.objects
    .filter((o) => !ignore.has(o.id))
    .map((o) => ({ o, d2: (o.pos[0] - at[0]) ** 2 + (o.pos[1] - at[1]) ** 2 }))
    .filter((c) => c.d2 <= r2)
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, EDITOR.SMART_GUIDE_MAX_CANDIDATES)
    .map((c) => c.o);
}

/**
 * Edge/centre alignment and the equal-spacing repeat (04 §6.2).
 *
 * Alignment compares three lines per axis on each side — min edge, centre, max
 * edge — so a domino lines up with the *edge* of a platform as readily as with
 * its middle. Spacing offers the continuation of a run: if the two nearest
 * same-type objects are `d` apart, the next one goes `d` beyond the nearer.
 */
export function smartGuides(
  view: GeometryView,
  ghost: CanonicalObject,
  ignore: ReadonlySet<Id> = new Set(),
): SmartGuides {
  const ghostBox = aabbOf(worldShapes(objectGeometry(ghost)));
  const candidates = nearbyCandidates(view, ghost.pos, new Set([...ignore, ghost.id]));
  const guides: AlignmentGuide[] = [];

  if (ghostBox) {
    const mine = {
      x: [ghostBox.minX, (ghostBox.minX + ghostBox.maxX) / 2, ghostBox.maxX],
      y: [ghostBox.minY, (ghostBox.minY + ghostBox.maxY) / 2, ghostBox.maxY],
    };
    for (const other of candidates) {
      const box = view.aabb(other.id);
      if (!box) continue;
      const theirs = {
        x: [box.minX, (box.minX + box.maxX) / 2, box.maxX],
        y: [box.minY, (box.minY + box.maxY) / 2, box.maxY],
      };
      for (const axis of ['x', 'y'] as const) {
        for (const m of mine[axis]) {
          for (const t of theirs[axis]) {
            const delta = t - m;
            if (Math.abs(delta) <= EDITOR.ALIGN_SNAP_M) {
              guides.push({ axis, at: t, with: other.id, delta });
            }
          }
        }
      }
    }
  }

  const bestOn = (axis: 'x' | 'y'): AlignmentGuide | undefined =>
    guides
      .filter((g) => g.axis === axis)
      .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))[0];

  const sameType = candidates.filter((o) => o.type === ghost.type);
  let spacing: SmartGuides['spacing'] = null;
  if (sameType.length >= 2) {
    const [near, next] = sameType as [CanonicalObject, CanonicalObject];
    const dx = near.pos[0] - next.pos[0];
    const dy = near.pos[1] - next.pos[1];
    const distance = Math.hypot(dx, dy);
    if (distance > 1e-6) {
      spacing = { pos: [q(near.pos[0] + dx), q(near.pos[1] + dy)], from: [near.id, next.id], distance };
    }
  }

  const snap: SmartGuides['snap'] = {};
  const gx = bestOn('x');
  if (gx) snap.x = gx;
  const gy = bestOn('y');
  if (gy) snap.y = gy;
  return { guides, snap, spacing };
}

// ---------------------------------------------------------------------------
// The ladder (04 §6.2 rule 3)
// ---------------------------------------------------------------------------

export type SnapKind = 'none' | 'grid' | 'surface' | 'alignment' | 'spacing';

export interface SnapResult {
  pos: Vec2;
  kind: SnapKind;
  /** Set when `kind === 'surface'`. */
  seat?: SurfaceSeat;
  /** Always computed, so the canvas can draw guides the ladder did not pick. */
  guides: SmartGuides;
}

export interface SnapOptions {
  /** Status-bar step, meters (04 §6.1). */
  step: number;
  /** `G` off means no grid *and* no grid snap — "what you see is what you snap to". */
  gridOn: boolean;
  /** Alt held: bypasses all snapping momentarily (04 §6.1). */
  bypass?: boolean;
  /** Ids the ghost stands for, so a drag does not snap to itself. */
  ignore?: ReadonlySet<Id>;
}

/**
 * Resolve the position for a ghost at `desired`, applying §6.2's precedence.
 *
 * The ghost is re-expanded at the raw pointer position first, because both the
 * seat cast and the alignment boxes are properties of where it *is*, not of
 * where the grid would put it.
 */
export function resolveSnap(view: GeometryView, ghost: CanonicalObject, opts: SnapOptions): SnapResult {
  const ignore = opts.ignore ?? new Set<Id>();
  const guides = smartGuides(view, ghost, ignore);

  if (opts.bypass) return { pos: [q(ghost.pos[0]), q(ghost.pos[1])], kind: 'none', guides };

  const seat = surfaceSeat(view, ghost, { ignore });
  if (seat) return { pos: seat.pos, kind: 'surface', seat, guides };

  if (opts.gridOn) return { pos: snapToGrid(ghost.pos, opts.step), kind: 'grid', guides };

  if (guides.snap.x || guides.snap.y) {
    return {
      pos: [q(ghost.pos[0] + (guides.snap.x?.delta ?? 0)), q(ghost.pos[1] + (guides.snap.y?.delta ?? 0))],
      kind: 'alignment',
      guides,
    };
  }

  if (guides.spacing) {
    const d = Math.hypot(guides.spacing.pos[0] - ghost.pos[0], guides.spacing.pos[1] - ghost.pos[1]);
    if (d <= EDITOR.ALIGN_SNAP_M) return { pos: guides.spacing.pos, kind: 'spacing', guides };
  }

  return { pos: [q(ghost.pos[0]), q(ghost.pos[1])], kind: 'none', guides };
}

// ---------------------------------------------------------------------------
// Gear snap → auto-`gearMesh` (04 §6.4, D9)
// ---------------------------------------------------------------------------

export interface GearSnap {
  /** Snapped centre: exactly `rA + rB` from the partner, along the centre line. */
  pos: Vec2;
  partner: Id;
  /** Centre distance before snapping — what the tolerance was measured against. */
  centerDist: number;
}

const gearRadius = (obj: CanonicalObject): number => (obj.props as { r: number }).r;

/**
 * The gear this one would mesh with at `pos`, and where it snaps to (04 §6.4).
 *
 * Tolerance is `clamp(0.15·min(rA, rB), 3 mm, 20 mm)` on the *pitch-circle gap*,
 * not on the centre distance — so a big gear and a small one snap at the same
 * visual closeness. Nearest partner wins.
 */
export function gearSnapAt(view: GeometryView, movingId: Id, pos: Vec2, radius: number): GearSnap | null {
  let best: GearSnap | null = null;
  let bestGap = Infinity;
  for (const other of view.canonical.objects) {
    if (other.type !== 'gear' || other.id === movingId) continue;
    const rB = gearRadius(other);
    const dx = pos[0] - other.pos[0];
    const dy = pos[1] - other.pos[1];
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-9) continue;
    const target = radius + rB;
    const gap = Math.abs(dist - target);
    if (gap > gearSnapTol(radius, rB) || gap >= bestGap) continue;
    bestGap = gap;
    best = {
      pos: [q(other.pos[0] + (dx / dist) * target), q(other.pos[1] + (dy / dist) * target)],
      partner: other.id,
      centerDist: dist,
    };
  }
  return best;
}

/**
 * Whether two gears are still within meshing tolerance — the test that decides
 * if a *geometric* mesh survives a drag (04 §6.4).
 */
export function gearsAreMeshed(a: CanonicalObject, b: CanonicalObject): boolean {
  const rA = gearRadius(a);
  const rB = gearRadius(b);
  const dist = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]);
  return Math.abs(dist - (rA + rB)) <= gearSnapTol(rA, rB);
}
