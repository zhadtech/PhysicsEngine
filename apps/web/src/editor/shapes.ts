/**
 * World-space shapes and the 2D queries the editor asks of them.
 *
 * 03 §5.3 is emphatic that there is one expansion module and the renderer and
 * the editor both use it — "static geometry is not sent" over the worker
 * boundary precisely so the picture cannot drift from the physics. That module
 * (`@physics/engine/geometry`) emits colliders in *body-local* frames, which is
 * what a physics build wants; hit-testing, marquee selection, framing and the
 * §5.2 surface cast all want them in world space. This is that conversion, plus
 * the three queries built on it — support, AABB, and ray.
 *
 * The queries are ordinary computational geometry and deliberately so: nothing
 * here is inside the determinism surface (it decides where a ghost *appears*,
 * and the placement it produces is quantized like any other authored number),
 * so it is held to being correct rather than to being bit-reproducible.
 */

import type { Vec2 } from '@physics/scene-format';
import type { ColliderShape, ObjectGeometry } from '@physics/engine/geometry';
import { dcos, dsin } from '@physics/engine/geometry';

/** An oriented box, a circle or a convex polygon, in world coordinates. */
export type WorldShape =
  | { kind: 'obb'; center: Vec2; hx: number; hy: number; rot: number }
  | { kind: 'circle'; center: Vec2; r: number }
  | { kind: 'polygon'; points: readonly Vec2[] };

export interface Aabb {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const rotate = (v: Vec2, c: number, s: number): Vec2 => [v[0] * c - v[1] * s, v[0] * s + v[1] * c];

/**
 * Unit gravity direction, `rotate((0,−1), planeAngle)` (02 §1).
 *
 * Takes **radians**, because that is what the canonical world carries (DET-4
 * converts the file's degrees exactly once) — asking for degrees here would put
 * a needless conversion round trip between the world and the cast.
 */
export function gravityDir(planeAngleRad: number): Vec2 {
  return [dsin(planeAngleRad), -dcos(planeAngleRad)];
}

/** Lift one piece's colliders into world space. */
function shapesOfPiece(pose: { pos: Vec2; rot: number }, colliders: readonly ColliderShape[]): WorldShape[] {
  const c = dcos(pose.rot);
  const s = dsin(pose.rot);
  const toWorld = (p: Vec2): Vec2 => {
    const r = rotate(p, c, s);
    return [pose.pos[0] + r[0], pose.pos[1] + r[1]];
  };
  return colliders.map((col): WorldShape => {
    if (col.kind === 'ball') return { kind: 'circle', center: toWorld(col.offset), r: col.r };
    if (col.kind === 'polygon') return { kind: 'polygon', points: col.points.map(toWorld) };
    return { kind: 'obb', center: toWorld(col.offset), hx: col.hx, hy: col.hy, rot: pose.rot + col.rot };
  });
}

/** Every collider of an expanded object, in world space. */
export function worldShapes(geom: ObjectGeometry): WorldShape[] {
  return geom.pieces.flatMap((piece) => shapesOfPiece(piece.pose, piece.colliders));
}

/** Farthest extent of a shape along `dir` (a support function). */
export function supportOf(shape: WorldShape, dir: Vec2): number {
  switch (shape.kind) {
    case 'circle':
      return shape.center[0] * dir[0] + shape.center[1] * dir[1] + shape.r;
    case 'obb': {
      const c = dcos(shape.rot);
      const s = dsin(shape.rot);
      const ex: Vec2 = [c, s];
      const ey: Vec2 = [-s, c];
      return (
        shape.center[0] * dir[0] +
        shape.center[1] * dir[1] +
        Math.abs(shape.hx * (ex[0] * dir[0] + ex[1] * dir[1])) +
        Math.abs(shape.hy * (ey[0] * dir[0] + ey[1] * dir[1]))
      );
    }
    case 'polygon':
      return Math.max(...shape.points.map((p) => p[0] * dir[0] + p[1] * dir[1]));
  }
}

/** Farthest extent of a whole object along `dir`; `-Infinity` if bodiless. */
export function support(shapes: readonly WorldShape[], dir: Vec2): number {
  return shapes.length === 0 ? -Infinity : Math.max(...shapes.map((s) => supportOf(s, dir)));
}

/** Axis-aligned bounds of an object — marquee tests, framing, alignment guides. */
export function aabbOf(shapes: readonly WorldShape[]): Aabb | null {
  if (shapes.length === 0) return null;
  return {
    minX: -support(shapes, [-1, 0]),
    maxX: support(shapes, [1, 0]),
    minY: -support(shapes, [0, -1]),
    maxY: support(shapes, [0, 1]),
  };
}

export function aabbUnion(a: Aabb, b: Aabb): Aabb {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** 04 §5.3: marquee selects on *intersection*, never containment. */
export function aabbIntersects(a: Aabb, b: Aabb): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

// ---------------------------------------------------------------------------
// Ray casting — the §5.2 surface cast, and click picking
// ---------------------------------------------------------------------------

const EPS = 1e-9;

function rayCircle(o: Vec2, d: Vec2, shape: { center: Vec2; r: number }): number | null {
  const ox = o[0] - shape.center[0];
  const oy = o[1] - shape.center[1];
  const b = ox * d[0] + oy * d[1];
  const c = ox * ox + oy * oy - shape.r * shape.r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  const t0 = -b - root;
  const t1 = -b + root;
  if (t0 >= 0) return t0;
  return t1 >= 0 ? t1 : null;
}

function rayObb(o: Vec2, d: Vec2, shape: { center: Vec2; hx: number; hy: number; rot: number }): number | null {
  // Into the box frame: the slab test is trivial there and exact.
  const c = dcos(shape.rot);
  const s = dsin(shape.rot);
  const px = o[0] - shape.center[0];
  const py = o[1] - shape.center[1];
  const lo: Vec2 = [px * c + py * s, -px * s + py * c];
  const ld: Vec2 = [d[0] * c + d[1] * s, -d[0] * s + d[1] * c];
  let tMin = -Infinity;
  let tMax = Infinity;
  const half = [shape.hx, shape.hy];
  for (let axis = 0; axis < 2; axis++) {
    const h = half[axis] as number;
    const origin = lo[axis] as number;
    const dir = ld[axis] as number;
    if (Math.abs(dir) < EPS) {
      if (origin < -h || origin > h) return null;
      continue;
    }
    const inv = 1 / dir;
    let t1 = (-h - origin) * inv;
    let t2 = (h - origin) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  if (tMax < 0) return null;
  return tMin >= 0 ? tMin : 0;
}

/** Convex polygon by half-plane clipping — the winding is CCW (03 §6 ramp). */
function rayPolygon(o: Vec2, d: Vec2, points: readonly Vec2[]): number | null {
  let tEnter = -Infinity;
  let tExit = Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Vec2;
    const qq = points[(i + 1) % points.length] as Vec2;
    const ex = qq[0] - p[0];
    const ey = qq[1] - p[1];
    // Outward normal of a CCW edge is (ey, −ex).
    const nx = ey;
    const ny = -ex;
    const denom = nx * d[0] + ny * d[1];
    const dist = nx * (o[0] - p[0]) + ny * (o[1] - p[1]);
    if (Math.abs(denom) < EPS) {
      if (dist > 0) return null; // parallel and outside
      continue;
    }
    const t = -dist / denom;
    if (denom < 0) tEnter = Math.max(tEnter, t);
    else tExit = Math.min(tExit, t);
    if (tEnter > tExit) return null;
  }
  if (tExit < 0) return null;
  return tEnter >= 0 ? tEnter : 0;
}

/** Distance along a unit ray to the first hit on `shape`, or null. */
export function rayShape(origin: Vec2, dir: Vec2, shape: WorldShape): number | null {
  switch (shape.kind) {
    case 'circle':
      return rayCircle(origin, dir, shape);
    case 'obb':
      return rayObb(origin, dir, shape);
    case 'polygon':
      return rayPolygon(origin, dir, shape.points);
  }
}

/** Nearest hit across a set of shapes, within `maxDistance`. */
export function rayShapes(origin: Vec2, dir: Vec2, shapes: readonly WorldShape[], maxDistance = Infinity): number | null {
  let best: number | null = null;
  for (const shape of shapes) {
    const t = rayShape(origin, dir, shape);
    if (t === null || t > maxDistance) continue;
    if (best === null || t < best) best = t;
  }
  return best;
}

/** Whether a world point is inside a shape — click picking (04 §5.3). */
export function containsPoint(shape: WorldShape, p: Vec2): boolean {
  switch (shape.kind) {
    case 'circle': {
      const dx = p[0] - shape.center[0];
      const dy = p[1] - shape.center[1];
      return dx * dx + dy * dy <= shape.r * shape.r;
    }
    case 'obb': {
      const c = dcos(shape.rot);
      const s = dsin(shape.rot);
      const px = p[0] - shape.center[0];
      const py = p[1] - shape.center[1];
      return Math.abs(px * c + py * s) <= shape.hx && Math.abs(-px * s + py * c) <= shape.hy;
    }
    case 'polygon': {
      for (let i = 0; i < shape.points.length; i++) {
        const a = shape.points[i] as Vec2;
        const b = shape.points[(i + 1) % shape.points.length] as Vec2;
        // Outside if the point is right of any CCW edge.
        if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) < 0) return false;
      }
      return true;
    }
  }
}
