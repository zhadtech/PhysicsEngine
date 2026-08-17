/**
 * Input canonicalization — 03 §3, rules DET-3 and DET-4.
 *
 * Everything downstream of this module sees one shape: objects and links in id
 * order, every number quantized, every angle in radians, every default filled
 * from the format's own tables. Expansion, the force layer and the renderer all
 * consume `CanonicalScene`, never the raw document — which is what makes the
 * round-trip property in §12 true by construction rather than by care:
 * `expand(scene)` and `expand(parse(serialize(scene)))` cannot differ, because
 * serialization is 4-digit and so is this.
 *
 * Contract: docs/03-SIMULATION-CORE.md §3; docs/02-SCENE-FORMAT.md §2, §5.2–§5.3.
 */

import {
  DYN_COMMON_DEFAULTS,
  LINK_PROP_DEFAULTS,
  MATERIAL_DEFAULTS,
  PROP_DEFAULTS,
  STATIC_SURFACE_DEFAULTS,
  WORLD_DEFAULTS,
} from '@physics/scene-format';
import type {
  DynProps,
  Endpoint,
  Id,
  Link,
  LinkType,
  ObjectType,
  Scene,
  SceneObject,
  Vec2,
} from '@physics/scene-format';
import { DEG2RAD, dcos, dsin } from './dmath.js';

/**
 * DET-4's quantum: the writer emits 4 fractional digits, so the reader rounds
 * to the same grid. Applying it on the way in is what makes "serialize → parse
 * → expand" bit-identical to expanding the in-memory original.
 */
export function quantize(x: number): number {
  const q = Math.round(x * 1e4) / 1e4;
  // −0 normalized to +0. Invisible in JSON and equal under `===`, but not under
  // `Object.is` — and `datan2` reads the sign bit to pick a quadrant, so a
  // coordinate that arrived as −0 would otherwise point a fan the other way.
  return q === 0 ? 0 : q;
}

/** Quantize an angle in degrees, then convert once (DET-4). */
export function quantizeAngle(deg: number): number {
  const r = quantize(deg) * DEG2RAD;
  return r === 0 ? 0 : r;
}

function quantizeVec(v: Vec2): Vec2 {
  return [quantize(v[0]), quantize(v[1])];
}

type ObjOf<T extends ObjectType> = Extract<SceneObject, { type: T }>;
/** A type's own props — the catalog row's, minus the shared material/motion set. */
type OwnProps<T extends ObjectType> = Omit<NonNullable<ObjOf<T>['props']>, keyof DynProps>;
type ScalarDefaultKey<T extends ObjectType> = keyof (typeof PROP_DEFAULTS)[T];
type ListDefaultKey<T extends ObjectType> = T extends keyof typeof LIST_DEFAULTS
  ? keyof (typeof LIST_DEFAULTS)[T]
  : never;
type DefaultedKey<T extends ObjectType> = ScalarDefaultKey<T> | ListDefaultKey<T>;

/**
 * A type's props with every defaultable key filled in. The few that have no
 * constant default (`lever.minAngle`/`maxAngle`) stay optional — their meaning
 * is "absent", not "zero", and expansion branches on that.
 */
export type ResolvedProps<T extends ObjectType> = {
  [K in keyof OwnProps<T> as K extends DefaultedKey<T> ? K : never]-?: NonNullable<OwnProps<T>[K]>;
} & {
  [K in keyof OwnProps<T> as K extends DefaultedKey<T> ? never : K]?: NonNullable<OwnProps<T>[K]>;
};

/**
 * The one list-valued object default. Kept out of the format's `PROP_DEFAULTS`
 * table on purpose — a shared mutable array as a module-level constant is a
 * footgun — so each scene gets a fresh empty list here instead. (`rope.via` is
 * the link-side equivalent, filled in `canonicalLink`.)
 */
const LIST_DEFAULTS = {
  trigger: { targets: [] as readonly Id[] },
} as const;

/** Resolved contact material. `density` is absent for types with no dynamic body. */
export interface ResolvedMaterial {
  density?: number;
  friction: number;
  restitution: number;
  magnetic: boolean;
  /** `true` builds the prefab's dynamic body as fixed (03 §6). */
  anchored: boolean;
}

/** Resolved initial motion. `angVel` is rad/s — the file's deg/s converted once. */
export interface ResolvedMotion {
  vel: Vec2;
  angVel: number;
}

export interface CanonicalObject<T extends ObjectType = ObjectType> {
  id: Id;
  type: T;
  /** Reference point (02 §5.3), quantized. */
  pos: Vec2;
  /** Radians. */
  rot: number;
  props: ResolvedProps<T>;
  material: ResolvedMaterial;
  motion: ResolvedMotion;
  skin?: string;
}

/** `CanonicalObject` narrowed to one catalog type — what the geometry table takes. */
export type CanonicalOf<T extends ObjectType> = CanonicalObject<T>;

type LinkOf<T extends LinkType> = Extract<Link, { type: T }>;
type LinkOwnProps<T extends LinkType> = NonNullable<LinkOf<T>['props']>;
type LinkDefaultKey<T extends LinkType> = keyof (typeof LINK_PROP_DEFAULTS)[T];

export type ResolvedLinkProps<T extends LinkType> = {
  [K in keyof LinkOwnProps<T> as K extends LinkDefaultKey<T> ? K : never]-?: NonNullable<LinkOwnProps<T>[K]>;
} & {
  [K in keyof LinkOwnProps<T> as K extends LinkDefaultKey<T> ? never : K]?: NonNullable<LinkOwnProps<T>[K]>;
} & {
  /** Always present; `[]` when the rope routes over no pulleys (02 §6.2). */
  via?: readonly Id[];
};

export interface CanonicalLink<T extends LinkType = LinkType> {
  id: Id;
  type: T;
  a: Endpoint;
  b: Endpoint;
  props: ResolvedLinkProps<T>;
}

export interface CanonicalWorld {
  /** Magnitude, m/s². */
  gravity: number;
  /** Radians. */
  planeAngle: number;
  /** The vector the solver uses: `rotate((0, −gravity), planeAngle)` (02 §1). */
  gravityVec: Vec2;
  seed: number;
  bounds: Vec2;
}

export interface CanonicalScene {
  world: CanonicalWorld;
  /** Sorted by id (DET-3). */
  objects: readonly CanonicalObject[];
  /** Sorted by id (DET-3). */
  links: readonly CanonicalLink[];
  /** id → object, for anchor resolution and link wiring. */
  byId: ReadonlyMap<Id, CanonicalObject>;
}

/**
 * DET-3's ordering: lexicographic *byte* order.
 *
 * Ids are ASCII by the 02 §3 pattern, and for ASCII the UTF-16 code-unit order
 * that `<`/`>` give is byte order — so a plain comparison is the byte
 * comparison the rule asks for. `Array.prototype.sort` with an explicit
 * comparator is specified as stable, and ids are unique anyway (02 E1).
 * `localeCompare` would be the trap here: it is locale-dependent, i.e. exactly
 * the kind of environment leak DET-3 exists to prevent.
 */
export function compareIds(a: Id, b: Id): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function resolveMaterial(type: ObjectType, props: Readonly<Record<string, unknown>>): ResolvedMaterial {
  const material = (MATERIAL_DEFAULTS as Readonly<Record<string, { density: number; friction: number; restitution: number }>>)[type];
  const num = (key: string, fallback: number): number => {
    const v = props[key];
    return typeof v === 'number' ? quantize(v) : fallback;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const v = props[key];
    return typeof v === 'boolean' ? v : fallback;
  };
  const base: ResolvedMaterial = {
    friction: num('friction', material?.friction ?? STATIC_SURFACE_DEFAULTS.friction),
    restitution: num('restitution', material?.restitution ?? STATIC_SURFACE_DEFAULTS.restitution),
    magnetic: bool('magnetic', DYN_COMMON_DEFAULTS.magnetic),
    anchored: bool('anchored', DYN_COMMON_DEFAULTS.anchored),
  };
  if (material) base.density = num('density', material.density);
  return base;
}

function resolveMotion(props: Readonly<Record<string, unknown>>): ResolvedMotion {
  const vel = props['vel'];
  const angVel = props['angVel'];
  const [vx, vy] = DYN_COMMON_DEFAULTS.vel;
  return {
    vel: Array.isArray(vel) && vel.length === 2 ? quantizeVec(vel as Vec2) : [vx, vy],
    angVel: typeof angVel === 'number' ? quantizeAngle(angVel) : DYN_COMMON_DEFAULTS.angVel,
  };
}

/** Fill a type's own props from `PROP_DEFAULTS` + `LIST_DEFAULTS`, quantizing numbers. */
function resolveProps(obj: SceneObject): Record<string, unknown> {
  const given = (obj.props ?? {}) as Readonly<Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  const scalarDefaults = PROP_DEFAULTS[obj.type] as Readonly<Record<string, number | boolean | string>>;
  const listDefaults = (LIST_DEFAULTS as Readonly<Record<string, Readonly<Record<string, unknown>>>>)[obj.type] ?? {};
  for (const [key, def] of Object.entries({ ...scalarDefaults, ...listDefaults })) {
    const v = given[key];
    out[key] = v === undefined ? def : typeof v === 'number' ? quantize(v) : v;
  }
  // Props with no constant default keep their given value or stay absent.
  for (const [key, v] of Object.entries(given)) {
    if (key in out || MATERIAL_OR_MOTION.has(key)) continue;
    out[key] = typeof v === 'number' ? quantize(v) : v;
  }
  return out;
}

const MATERIAL_OR_MOTION: ReadonlySet<string> = new Set([
  'density',
  'friction',
  'restitution',
  'magnetic',
  'anchored',
  'vel',
  'angVel',
]);

/** Angle-valued props: stored in degrees by the format, radians past this line. */
const ANGLE_PROPS: ReadonlySet<string> = new Set(['motorSpeed', 'minAngle', 'maxAngle']);

function canonicalObject(obj: SceneObject): CanonicalObject {
  const props = resolveProps(obj);
  for (const key of ANGLE_PROPS) {
    const v = props[key];
    if (typeof v === 'number') props[key] = quantizeAngle(v);
  }
  const given = (obj.props ?? {}) as Readonly<Record<string, unknown>>;
  const out: CanonicalObject = {
    id: obj.id,
    type: obj.type,
    pos: quantizeVec(obj.pos),
    rot: quantizeAngle(obj.rot ?? 0),
    props: props as ResolvedProps<ObjectType>,
    material: resolveMaterial(obj.type, given),
    motion: resolveMotion(given),
  };
  if (obj.skin !== undefined) out.skin = obj.skin;
  return out;
}

function canonicalLink(link: Link): CanonicalLink {
  const given = (link.props ?? {}) as Readonly<Record<string, unknown>>;
  const props: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(
    LINK_PROP_DEFAULTS[link.type] as Readonly<Record<string, number | boolean | string>>,
  )) {
    const v = given[key];
    props[key] = v === undefined ? def : typeof v === 'number' ? quantize(v) : v;
  }
  for (const [key, v] of Object.entries(given)) {
    if (key in props) continue;
    props[key] = typeof v === 'number' ? quantize(v) : v;
  }
  // `axle.motorSpeed` is deg/s in the file exactly as `gear.motorSpeed` is, and
  // 03 §6 realizes them with the same motor — so it converts by the same rule.
  for (const key of ANGLE_PROPS) {
    const v = props[key];
    if (typeof v === 'number') props[key] = quantizeAngle(v);
  }
  if (link.type === 'rope' && props['via'] === undefined) props['via'] = [];
  return {
    id: link.id,
    type: link.type,
    a: canonicalEndpoint(link.a),
    b: canonicalEndpoint(link.b),
    props: props as ResolvedLinkProps<LinkType>,
  };
}

function canonicalEndpoint(ep: Endpoint): Endpoint {
  if ('at' in ep && ep.at !== undefined) return { obj: ep.obj, at: quantizeVec(ep.at) };
  return ep;
}

function canonicalWorld(scene: Scene): CanonicalWorld {
  const w = scene.world;
  const gravity = quantize(w.gravity ?? WORLD_DEFAULTS.gravity);
  const planeAngle = quantizeAngle(w.planeAngle ?? WORLD_DEFAULTS.planeAngle);
  // 02 §1: gravity is stored as a magnitude plus a plane angle, and the engine
  // derives the vector — one knob, no chance of the two disagreeing.
  const c = dcos(planeAngle);
  const s = dsin(planeAngle);
  return {
    gravity,
    planeAngle,
    gravityVec: [gravity * s, -gravity * c],
    seed: w.seed ?? WORLD_DEFAULTS.seed,
    bounds: w.bounds ? quantizeVec(w.bounds) : [...WORLD_DEFAULTS.bounds],
  };
}

/**
 * Canonicalize a *validated* scene (05 §5.3 has already run: the document is
 * schema-clean, semantically sound and at this `schemaVersion`). Ordering is
 * DET-3, numbers are DET-4, angles are radians from here on.
 */
export function canonicalize(scene: Scene): CanonicalScene {
  const objects = [...scene.objects].sort((a, b) => compareIds(a.id, b.id)).map(canonicalObject);
  const links = [...(scene.links ?? [])].sort((a, b) => compareIds(a.id, b.id)).map(canonicalLink);
  return {
    world: canonicalWorld(scene),
    objects,
    links,
    byId: new Map(objects.map((o) => [o.id, o])),
  };
}
