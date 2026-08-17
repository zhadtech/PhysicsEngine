/**
 * Prefab geometry — 03 §6's expansion tables, and 02 §6.3's anchors.
 *
 * This is the module 03 §5.3 requires to exist: "static geometry is not sent"
 * over the worker boundary, because the renderer derives every static placement
 * — ramp vertices, curve tessellation, spring and piston base poses — from the
 * scene document through *this* code, the same code SimCore expands with. One
 * source of truth, nothing to serialize, and no way for the picture to drift
 * from the physics.
 *
 * It is deliberately Rapier-free. What comes out is a plain description —
 * poses, shapes, densities, anchor points — that P2b hands to the physics build
 * and P3 hands to Three.js. Keeping it that way is also what lets it be tested
 * exhaustively and hashed cross-engine without a WASM module in the loop.
 *
 * Everything here runs at load time, so it may use `dmath` (DET-5) freely.
 *
 * Contract: docs/03-SIMULATION-CORE.md §6; docs/02-SCENE-FORMAT.md §5.3, §6.3.
 */

import type { Id, ObjectType, Vec2 } from '@physics/scene-format';
import type { BodyPiece } from '../protocol.js';
import type { CanonicalObject, CanonicalScene } from './canonical.js';
import { DEG2RAD, datan2, dcos, dsin, length2 } from './dmath.js';

/**
 * Expansion constants from the 03 §6 tables — the dimensions the spec fixes for
 * prefab parts that have no catalog prop of their own.
 *
 * Every one of these is inside the determinism surface: 03 §2 makes "any
 * expansion-rule change (§6)" an `engineVersion` bump, because moving a spring
 * plate by a millimetre changes every golden hash in the repo.
 */
export const EXPAND = {
  /** Domino width is a fixed proportion of its height (02 §5.3). */
  DOMINO_W_OVER_H: 1 / 5,
  /** Spring: fixed base slab and the dynamic plate that rides on it. */
  SPRING_BASE_H: 0.02,
  SPRING_PLATE_H: 0.015,
  /** Piston: base slab and head, same thickness. */
  PISTON_BASE_H: 0.03,
  PISTON_HEAD_H: 0.03,
  /** Pendulum rigid arm: width, and a fixed density (it is hittable and adds inertia). */
  PENDULUM_ARM_W: 0.015,
  PENDULUM_ARM_DENSITY: 2,
  /** Segmented rope: capsule radius and density (03 §6 links table). */
  ROPE_SEGMENT_RADIUS: 0.008,
  ROPE_SEGMENT_DENSITY: 1.5,
  /** Curve tessellation: N = max(4, ceil(sweep_deg / 7.5)). */
  CURVE_DEG_PER_SEGMENT: 7.5,
  CURVE_MIN_SEGMENTS: 4,
  /** Arc start angle: pointing down from the arc centre (03 §6). */
  CURVE_START_DEG: -90,
} as const;

/** A collider in its body's local frame. */
export type ColliderShape =
  | { kind: 'cuboid'; hx: number; hy: number; offset: Vec2; rot: number }
  | { kind: 'ball'; r: number; offset: Vec2 }
  /** Convex polygon, CCW-wound (03 §6 ramp). */
  | { kind: 'polygon'; points: readonly Vec2[] };

/** How the body behaves, before `anchored` is applied (03 §6). */
export type BodyKind = 'fixed' | 'dynamic' | 'sensor';

export interface Pose {
  pos: Vec2;
  /** Radians. */
  rot: number;
}

export interface PieceGeometry {
  piece: BodyPiece;
  kind: BodyKind;
  /** World pose of the body origin; collider offsets are relative to it. */
  pose: Pose;
  colliders: readonly ColliderShape[];
  /** Set where 03 §6 fixes a density for the part rather than taking the object's. */
  densityOverride?: number;
  /** 03 §6: on for marbles and pendulum bobs (small, fast), off elsewhere. */
  ccd?: boolean;
}

/** Load-time derived vectors the force layer (§7) needs; all unit-length. */
export interface DerivedVectors {
  /** Fan blow direction, conveyor belt tangent, or spring/piston prismatic axis. */
  axis?: Vec2;
  /** Fan cone test constant, `dcos(spread · DEG2RAD)` (§7.1). */
  cosHalf?: number;
}

export interface ObjectGeometry {
  id: Id;
  type: ObjectType;
  /** In the creation order the §6 table lists (DET-3). Empty for fields. */
  pieces: readonly PieceGeometry[];
  derived: DerivedVectors;
}

/** Rotate a local offset into world space and add it to a position. */
function offsetFrom(pos: Vec2, local: Vec2, rot: number): Vec2 {
  const c = dcos(rot);
  const s = dsin(rot);
  return [pos[0] + local[0] * c - local[1] * s, pos[1] + local[0] * s + local[1] * c];
}

const ORIGIN: Vec2 = [0, 0];

function cuboid(w: number, h: number): ColliderShape {
  return { kind: 'cuboid', hx: w / 2, hy: h / 2, offset: [0, 0], rot: 0 };
}

/**
 * Read a resolved numeric prop.
 *
 * Canonicalization has already filled every default from the format's tables,
 * so a missing key is a bug in `PROP_DEFAULTS`, not a scene problem — hence the
 * throw rather than a silent zero, which would place a body at the origin and
 * be diagnosed as a physics mystery three layers away.
 */
function num(obj: CanonicalObject, key: string): number {
  const v = (obj.props as Readonly<Record<string, unknown>>)[key];
  if (typeof v !== 'number') {
    throw new TypeError(`geometry: ${obj.type} "${obj.id}" has no resolved numeric prop "${key}"`);
  }
  return v;
}

function bool(obj: CanonicalObject, key: string): boolean {
  return (obj.props as Readonly<Record<string, unknown>>)[key] === true;
}

function str(obj: CanonicalObject, key: string): string {
  const v = (obj.props as Readonly<Record<string, unknown>>)[key];
  if (typeof v !== 'string') {
    throw new TypeError(`geometry: ${obj.type} "${obj.id}" has no resolved string prop "${key}"`);
  }
  return v;
}

/** One fixed body at the object's own pose carrying one box collider. */
function staticBox(obj: CanonicalObject, w: number, h: number, kind: BodyKind = 'fixed'): PieceGeometry {
  return {
    piece: 'main',
    kind,
    pose: { pos: obj.pos, rot: obj.rot },
    colliders: [cuboid(w, h)],
  };
}

/** One dynamic body at a local offset from the reference point. */
function dynamicAt(
  obj: CanonicalObject,
  localOffset: Vec2,
  colliders: readonly ColliderShape[],
  piece: BodyPiece = 'main',
): PieceGeometry {
  return {
    piece,
    kind: 'dynamic',
    pose: { pos: offsetFrom(obj.pos, localOffset, obj.rot), rot: obj.rot },
    colliders,
  };
}

// ---------------------------------------------------------------------------
// Curve tessellation (03 §6) — shared by the collider build and the renderer
// ---------------------------------------------------------------------------

export interface CurveTessellation {
  /** Arc points in the object's local frame, `N + 1` of them. */
  points: readonly Vec2[];
  /** One cuboid per consecutive pair, local to the object. */
  segments: readonly ColliderShape[];
}

/**
 * `N = max(4, ceil(sweep_deg / 7.5))` segments from the −90° start, CCW by
 * `sweep` (`flip` → CW).
 *
 * The spec writes the arc points in world space as `pos + R(rot)·r·(cos φ, sin φ)`;
 * they are computed here in the object's *local* frame instead and composed with
 * the body pose by the caller. That is the same geometry — and it is one
 * rotation less per point, which matters only because every avoided
 * floating-point operation is one fewer place for two platforms to disagree.
 */
export function tessellateCurve(r: number, sweepDeg: number, thickness: number, flip: boolean): CurveTessellation {
  const n = Math.max(EXPAND.CURVE_MIN_SEGMENTS, Math.ceil(sweepDeg / EXPAND.CURVE_DEG_PER_SEGMENT));
  const dir = flip ? -1 : 1;
  const stepDeg = (sweepDeg / n) * dir;
  const points: Vec2[] = [];
  for (let j = 0; j <= n; j++) {
    // Degrees→radians once per point, from an exact degree value: the same
    // route DET-4 takes for every other angle in the document.
    const phi = (EXPAND.CURVE_START_DEG + stepDeg * j) * DEG2RAD;
    points.push([r * dcos(phi), r * dsin(phi)]);
  }
  const segments: ColliderShape[] = [];
  for (let j = 0; j < n; j++) {
    const p = points[j] as Vec2;
    const q = points[j + 1] as Vec2;
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    segments.push({
      kind: 'cuboid',
      hx: length2(dx, dy) / 2,
      hy: thickness / 2,
      offset: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2],
      rot: datan2(dy, dx),
    });
  }
  return { points, segments };
}

/**
 * Ramp vertices in the local frame: a right triangle whose slope descends
 * left→right, wound CCW (03 §6). `flip` mirrors x, and the winding is restored
 * by reversing the order — a mirrored polygon is CW, and a CW "convex" polygon
 * is a degenerate collider in most engines rather than an error, which is the
 * kind of bug that shows up as objects falling through a ramp.
 */
export function rampVertices(w: number, h: number, flip: boolean): readonly Vec2[] {
  const v: Vec2[] = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [-w / 2, h / 2],
  ];
  if (!flip) return v;
  return v.map((p): Vec2 => [-p[0], p[1]]).reverse();
}

// ---------------------------------------------------------------------------
// The per-type expansion table (03 §6)
// ---------------------------------------------------------------------------

type GeometryFn = (obj: CanonicalObject) => { pieces: PieceGeometry[]; derived?: DerivedVectors };

/**
 * One entry per catalog type, in 03 §6 table order. Typed as a total map over
 * `ObjectType`, so adding a 19th type to the format fails this file to compile
 * rather than silently expanding to nothing.
 */
const GEOMETRY: { [T in ObjectType]: GeometryFn } = {
  // Structural (static, no slots) ------------------------------------------
  platform: (o) => ({ pieces: [staticBox(o, num(o, 'w'), num(o, 'h'))] }),

  ramp: (o) => ({
    pieces: [
      {
        piece: 'main',
        kind: 'fixed',
        pose: { pos: o.pos, rot: o.rot },
        colliders: [{ kind: 'polygon', points: rampVertices(num(o, 'w'), num(o, 'h'), bool(o, 'flip')) }],
      },
    ],
  }),

  curve: (o) => ({
    pieces: [
      {
        piece: 'main',
        kind: 'fixed',
        pose: { pos: o.pos, rot: o.rot },
        colliders: tessellateCurve(num(o, 'r'), num(o, 'sweep'), num(o, 'thickness'), bool(o, 'flip')).segments,
      },
    ],
  }),

  // Simple dynamic bodies ---------------------------------------------------
  domino: (o) => {
    const h = num(o, 'h');
    // Reference point is the centre of the base edge, so the body centre sits
    // half a height up the object's local +Y — which is why a domino placed on
    // a floor stands on it instead of sinking halfway in.
    return { pieces: [dynamicAt(o, [0, h / 2], [cuboid(h * EXPAND.DOMINO_W_OVER_H, h)])] };
  },

  marble: (o) => ({
    pieces: [{ ...dynamicAt(o, ORIGIN, [{ kind: 'ball', r: num(o, 'r'), offset: [0, 0] }]), ccd: true }],
  }),

  crate: (o) => ({ pieces: [dynamicAt(o, ORIGIN, [cuboid(num(o, 'w'), num(o, 'h'))])] }),

  plank: (o) => ({ pieces: [dynamicAt(o, ORIGIN, [cuboid(num(o, 'w'), num(o, 'h'))])] }),

  // Mechanisms --------------------------------------------------------------
  gear: (o) => ({
    pieces: [dynamicAt(o, ORIGIN, [{ kind: 'ball', r: num(o, 'r'), offset: [0, 0] }])],
  }),

  lever: (o) => {
    const len = num(o, 'len');
    const pivot = num(o, 'pivot');
    // The reference point is the pivot, which is `pivot` of the way along the
    // arm — so the body centre is offset by however far that is from the middle.
    return { pieces: [dynamicAt(o, [(0.5 - pivot) * len, 0], [cuboid(len, num(o, 'h'))])] };
  },

  spring: (o) => {
    const w = num(o, 'w');
    const travel = num(o, 'travel');
    const axis = axisFrom(o.rot);
    // Prismatic limits are [0, travel] with 0 = "plate seated on base". 03 §6
    // fixes both slab thicknesses but not the seated pose; seated can only mean
    // the two faces touching, so the plate centre sits half of each above the
    // base centre. `passive` starts extended, `triggered` starts latched at 0.
    const seated = (EXPAND.SPRING_BASE_H + EXPAND.SPRING_PLATE_H) / 2;
    const extension = str(o, 'mode') === 'passive' ? travel : 0;
    return {
      pieces: [
        staticBox(o, w, EXPAND.SPRING_BASE_H),
        dynamicAt(o, [0, seated + extension], [cuboid(w, EXPAND.SPRING_PLATE_H)], 'plate'),
      ],
      derived: { axis },
    };
  },

  pendulum: (o) => {
    const len = num(o, 'len');
    const bobR = num(o, 'bobR');
    if (str(o, 'arm') === 'rope') {
      // No rigid arm: a free ball on a max-distance joint to the pivot.
      return {
        pieces: [{ ...dynamicAt(o, [0, -len], [{ kind: 'ball', r: bobR, offset: [0, 0] }], 'bob'), ccd: true }],
      };
    }
    // Rigid rod: one body whose origin *is* the pivot, so the revolute joint
    // needs no offset and the arm rotates about the point the author placed.
    return {
      pieces: [
        {
          piece: 'main',
          kind: 'dynamic',
          pose: { pos: o.pos, rot: o.rot },
          colliders: [
            { kind: 'ball', r: bobR, offset: [0, -len] },
            { kind: 'cuboid', hx: EXPAND.PENDULUM_ARM_W / 2, hy: len / 2, offset: [0, -len / 2], rot: 0 },
          ],
          ccd: true,
        },
      ],
    };
  },

  piston: (o) => {
    const w = num(o, 'w');
    // Same seating argument as the spring. Both modes start retracted:
    // `triggered` says so outright, and `cycle` has nowhere else to start —
    // the motor drives toward its step-0 target from here.
    const seated = (EXPAND.PISTON_BASE_H + EXPAND.PISTON_HEAD_H) / 2;
    return {
      pieces: [
        staticBox(o, w, EXPAND.PISTON_BASE_H),
        dynamicAt(o, [0, seated], [cuboid(w, EXPAND.PISTON_HEAD_H)], 'head'),
      ],
      derived: { axis: axisFrom(o.rot) },
    };
  },

  conveyor: (o) => ({
    pieces: [staticBox(o, num(o, 'w'), num(o, 'h'))],
    // Belt tangent R(rot)·(1, 0), precomputed at load so the per-step surface
    // impulse (§7.3) never touches a transcendental (DET-5).
    derived: { axis: [dcos(o.rot), dsin(o.rot)] },
  }),

  pulley: (o) => ({
    pieces: [
      {
        piece: 'main',
        kind: 'fixed',
        pose: { pos: o.pos, rot: o.rot },
        colliders: [{ kind: 'ball', r: num(o, 'r'), offset: [0, 0] }],
      },
    ],
  }),

  // Fields — no bodies, no colliders; entries in the §7 force tables ---------
  fan: (o) => ({
    pieces: [],
    derived: { axis: [dcos(o.rot), dsin(o.rot)], cosHalf: dcos(num(o, 'spread') * DEG2RAD) },
  }),

  magnet: () => ({ pieces: [] }),

  // Logic — sensor zones ----------------------------------------------------
  trigger: (o) => ({ pieces: [staticBox(o, num(o, 'w'), num(o, 'h'), 'sensor')] }),

  goal: (o) => ({ pieces: [staticBox(o, num(o, 'w'), num(o, 'h'), 'sensor')] }),
};

/** Prismatic axis `R(rot)·(0, 1)` — `rot = 0` points up (03 §6 spring/piston). */
function axisFrom(rot: number): Vec2 {
  return [-dsin(rot), dcos(rot)];
}

/** Expand one object's geometry (03 §6). */
export function objectGeometry(obj: CanonicalObject): ObjectGeometry {
  const { pieces, derived } = GEOMETRY[obj.type](obj);
  return { id: obj.id, type: obj.type, pieces, derived: derived ?? {} };
}

/** Expand every object, in id order (DET-3). */
export function sceneGeometry(scene: CanonicalScene): readonly ObjectGeometry[] {
  return scene.objects.map(objectGeometry);
}

// ---------------------------------------------------------------------------
// Anchors (02 §6.3)
// ---------------------------------------------------------------------------

export interface ResolvedAnchor {
  /**
   * The expanded body this anchor belongs to, or `null` for the field types,
   * which have none. 03 §6's rule that links to *static* objects attach to the
   * shared `ground` body is a joint-creation concern, applied at P2b — an
   * anchor still names the part it is geometrically on, which is what the
   * renderer needs to draw a rope end in the right place.
   */
  piece: BodyPiece | null;
  /** In the object's local frame — origin at the reference point, so `center` is `[0, 0]`. */
  local: Vec2;
  /** World point, resolved against the object's *current* props (02 §6.3). */
  world: Vec2;
}

type AnchorFn = (obj: CanonicalObject) => { piece: BodyPiece | null; local: Vec2 };

/** Box-family edge midpoints, for types whose reference point is the box centre. */
function boxAnchors(wKey: string, hKey: string): Record<string, AnchorFn> {
  return {
    top: (o) => ({ piece: 'main', local: [0, num(o, hKey) / 2] }),
    bottom: (o) => ({ piece: 'main', local: [0, -num(o, hKey) / 2] }),
    left: (o) => ({ piece: 'main', local: [-num(o, wKey) / 2, 0] }),
    right: (o) => ({ piece: 'main', local: [num(o, wKey) / 2, 0] }),
  };
}

/**
 * Named anchors per type (02 §6.3). Keys must match `NAMED_ANCHORS` in the
 * format package — `tools/verify-engine.mjs` asserts the two agree, so a name
 * the builder offers can never be one the engine cannot resolve.
 */
const ANCHORS: { [T in ObjectType]: Record<string, AnchorFn> } = {
  platform: boxAnchors('w', 'h'),
  // 02 §6.3: a ramp's anchors are its *bounding box* edge midpoints, not points
  // on the hypotenuse.
  ramp: boxAnchors('w', 'h'),
  curve: {
    endA: (o) => ({ piece: 'main', local: curveEnds(o)[0] }),
    endB: (o) => ({ piece: 'main', local: curveEnds(o)[1] }),
  },
  // The reference point is the base-edge centre, so the box is one half-height up.
  domino: {
    top: (o) => ({ piece: 'main', local: [0, num(o, 'h')] }),
    bottom: () => ({ piece: 'main', local: [0, 0] }),
    left: (o) => ({ piece: 'main', local: [(-num(o, 'h') * EXPAND.DOMINO_W_OVER_H) / 2, num(o, 'h') / 2] }),
    right: (o) => ({ piece: 'main', local: [(num(o, 'h') * EXPAND.DOMINO_W_OVER_H) / 2, num(o, 'h') / 2] }),
  },
  marble: {},
  crate: boxAnchors('w', 'h'),
  plank: boxAnchors('w', 'h'),
  gear: {},
  lever: {
    endA: (o) => ({ piece: 'main', local: [-num(o, 'pivot') * num(o, 'len'), 0] }),
    endB: (o) => ({ piece: 'main', local: [(1 - num(o, 'pivot')) * num(o, 'len'), 0] }),
    pivot: () => ({ piece: 'main', local: [0, 0] }),
  },
  spring: {
    base: () => ({ piece: 'main', local: [0, 0] }),
    // On the plate body itself, wherever the plate currently sits.
    plate: () => ({ piece: 'plate', local: [0, 0] }),
  },
  pendulum: {
    pivot: (o) => ({ piece: str(o, 'arm') === 'rope' ? null : 'main', local: [0, 0] }),
    bob: (o) =>
      str(o, 'arm') === 'rope'
        ? { piece: 'bob', local: [0, -num(o, 'len')] }
        : { piece: 'main', local: [0, -num(o, 'len')] },
  },
  piston: {
    base: () => ({ piece: 'main', local: [0, 0] }),
    head: () => ({ piece: 'head', local: [0, 0] }),
  },
  conveyor: boxAnchors('w', 'h'),
  pulley: {},
  fan: {},
  magnet: {},
  trigger: boxAnchors('w', 'h'),
  goal: boxAnchors('w', 'h'),
};

/** Local-frame arc endpoints of a curve (02 §6.3 `endA`/`endB`). */
function curveEnds(o: CanonicalObject): [Vec2, Vec2] {
  const { points } = tessellateCurve(num(o, 'r'), num(o, 'sweep'), num(o, 'thickness'), bool(o, 'flip'));
  return [points[0] as Vec2, points[points.length - 1] as Vec2];
}

/** Types with no body at all — an anchor on one attaches to the world (03 §6). */
const BODYLESS: ReadonlySet<ObjectType> = new Set<ObjectType>(['fan', 'magnet']);

/**
 * Resolve a link endpoint to a world point (02 §6.3).
 *
 * `anchor` names a point from the table; `at` is a local-frame offset; neither
 * means `center`, which is the local origin — the same point `at: [0, 0]` gives,
 * so the two spellings cannot disagree.
 */
export function resolveAnchor(obj: CanonicalObject, endpoint: { anchor?: string; at?: Vec2 }): ResolvedAnchor {
  const bodyless = BODYLESS.has(obj.type);
  let piece: BodyPiece | null = bodyless ? null : 'main';
  let local: Vec2 = [0, 0];

  if (endpoint.at !== undefined) {
    local = endpoint.at;
  } else if (endpoint.anchor !== undefined && endpoint.anchor !== 'center') {
    const fn = ANCHORS[obj.type][endpoint.anchor];
    if (!fn) {
      throw new RangeError(
        `geometry: ${obj.type} "${obj.id}" has no anchor "${endpoint.anchor}" (02 §6.3) — ` +
          'the validation gate should have rejected this document (rule E5)',
      );
    }
    const r = fn(obj);
    piece = r.piece;
    local = r.local;
  }
  return { piece, local, world: offsetFrom(obj.pos, local, obj.rot) };
}

/** Anchor names this type resolves — the engine's half of the 02 §6.3 table. */
export function anchorNames(type: ObjectType): readonly string[] {
  return Object.keys(ANCHORS[type]);
}
