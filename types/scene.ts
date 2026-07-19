/**
 * Scene format v1 — TypeScript interfaces.
 *
 * Normative sources: 02-SCENE-FORMAT.md (spec) and scene.schema.json (JSON Schema).
 * This file mirrors them for compile-time safety in client + server + tools.
 * Lives in the shared `scene-format` package (used by builder, engine worker,
 * backend validation, procgen, and the AI pipeline).
 *
 * Conventions (spec §2): SI units, meters, seconds, newtons; angles in DEGREES
 * (CCW positive); 2D density in kg/m²; X right, Y up, origin at board center.
 * Writers quantize every number to ≤ 4 fractional digits.
 */

// ---------------------------------------------------------------------------
// Scalars & shared shapes
// ---------------------------------------------------------------------------

/** `^[A-Za-z0-9_-]{1,24}$` — one namespace shared by objects and links. */
export type Id = string;

/** [x, y] in meters (or m/s for velocities). */
export type Vec2 = [number, number];

export const SCHEMA_VERSION = 1 as const;

/** Hard document limits (spec §7). */
export const LIMITS = {
  maxObjects: 5000,
  maxLinks: 1000,
  maxJsonBytes: 1_000_000,
  maxTargets: 32,
  maxRopeVia: 4,
  /** Max fractional digits a writer may emit. */
  maxFractionDigits: 4,
} as const;

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,24}$/;

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export interface Scene {
  schemaVersion: typeof SCHEMA_VERSION;
  /** Semver of the deterministic engine build the scene targets. */
  engineVersion: string;
  meta?: SceneMeta;
  world: World;
  objects: SceneObject[];
  links?: Link[];
}

export interface SceneMeta {
  /** 1–80 chars. Default "Untitled". */
  title?: string;
  /** ≤ 500 chars. */
  description?: string;
  /** ≤ 10 tags, each 1–24 chars. */
  tags?: string[];
  /** Target run length in seconds (1–600). Hint, not a hard stop. */
  durationHint?: number;
}

export interface World {
  /** m/s², 0–100. Default 9.81. */
  gravity?: number;
  /** Degrees, −180–180. Rotates the gravity vector. Default 0. */
  planeAngle?: number;
  /** uint32. Feeds the worker PRNG (PCG32). Default 1. */
  seed?: number;
  /** [w, h] play area in meters, centered on origin. Default [4, 2.4]. */
  bounds?: Vec2;
}

// ---------------------------------------------------------------------------
// Objects — common parts
// ---------------------------------------------------------------------------

export type ObjectType =
  | 'platform'
  | 'ramp'
  | 'curve'
  | 'domino'
  | 'marble'
  | 'crate'
  | 'plank'
  | 'gear'
  | 'lever'
  | 'spring'
  | 'pendulum'
  | 'piston'
  | 'conveyor'
  | 'pulley'
  | 'fan'
  | 'magnet'
  | 'trigger'
  | 'goal';

interface ObjBase<T extends ObjectType> {
  id: Id;
  type: T;
  /** Position of the type's reference point (spec §5.3), meters. */
  pos: Vec2;
  /** Degrees, CCW. Default 0. */
  rot?: number;
  /** Visual preset name. Rendering only — never affects simulation. */
  skin?: string;
}

/** Contact material props for static surfaces. */
export interface StaticSurfaceProps {
  /** 0–2. */
  friction?: number;
  /** 0–1. */
  restitution?: number;
}

/** Common props for every dynamic body (spec §5.2). */
export interface DynProps extends StaticSurfaceProps {
  /** kg/m² (2D), 0.1–100. Default per type. */
  density?: number;
  /** Only magnetic bodies feel magnets. Default false. */
  magnetic?: boolean;
  /** true = frozen in place (static). Default false. */
  anchored?: boolean;
  /** Initial linear velocity, m/s, each component −50–50. Default [0, 0]. */
  vel?: Vec2;
  /** Initial angular velocity, deg/s, −3600–3600. Default 0. */
  angVel?: number;
}

// ---------------------------------------------------------------------------
// Objects — the 18 catalog types
// ---------------------------------------------------------------------------

// Structural (static)

export interface PlatformObject extends ObjBase<'platform'> {
  props?: StaticSurfaceProps & {
    /** Width, m. Default 1. */
    w?: number;
    /** Height, m. Default 0.05. */
    h?: number;
  };
}

export interface RampObject extends ObjBase<'ramp'> {
  props?: StaticSurfaceProps & {
    /** Default 0.5. */
    w?: number;
    /** Default 0.3. */
    h?: number;
    /** Mirror horizontally. Default false (slope descends left→right). */
    flip?: boolean;
  };
}

export interface CurveObject extends ObjBase<'curve'> {
  props?: StaticSurfaceProps & {
    /** Arc radius. Default 0.4. */
    r?: number;
    /** Channel wall thickness. Default 0.03. */
    thickness?: number;
    /** Arc sweep, degrees 15–180. Default 90. */
    sweep?: number;
    flip?: boolean;
  };
}

// Simple dynamic bodies

export interface DominoObject extends ObjBase<'domino'> {
  props?: DynProps & {
    /** Height, m. Width = h/5 (fixed proportion). Default 0.08. */
    h?: number;
  };
}

export interface MarbleObject extends ObjBase<'marble'> {
  props?: DynProps & {
    /** Radius, m. Default 0.025. */
    r?: number;
  };
}

export interface CrateObject extends ObjBase<'crate'> {
  props?: DynProps & {
    /** Default 0.08. */
    w?: number;
    /** Default 0.08. */
    h?: number;
  };
}

export interface PlankObject extends ObjBase<'plank'> {
  props?: DynProps & {
    /** Default 0.4. */
    w?: number;
    /** Default 0.02. */
    h?: number;
  };
}

// Mechanisms (compound prefabs)

export interface GearObject extends ObjBase<'gear'> {
  props?: DynProps & {
    /** Radius, m. Default 0.1. */
    r?: number;
    /** deg/s, signed. 0 = free-spinning. Default 0. */
    motorSpeed?: number;
    /** N·m. Default 0.5. */
    maxTorque?: number;
  };
}

export interface LeverObject extends ObjBase<'lever'> {
  props?: DynProps & {
    /** Arm length, m. Default 0.4. */
    len?: number;
    /** Arm thickness. Default 0.02. */
    h?: number;
    /** Fulcrum position, fraction from left end, 0–1. Default 0.5. */
    pivot?: number;
    /** Optional rotation limits, degrees. */
    minAngle?: number;
    maxAngle?: number;
  };
}

export interface SpringObject extends ObjBase<'spring'> {
  props?: DynProps & {
    /** Pad width. Default 0.1. */
    w?: number;
    /** Compression travel, m. Default 0.08. */
    travel?: number;
    /** N/m. Default 25. */
    stiffness?: number;
    /** Default 0.5. */
    damping?: number;
    /** Default "passive". "triggered" starts compressed + latched. */
    mode?: 'passive' | 'triggered';
  };
}

export interface PendulumObject extends ObjBase<'pendulum'> {
  props?: DynProps & {
    /** Arm length. Default 0.3. */
    len?: number;
    /** Bob radius. Default 0.04. */
    bobR?: number;
    /** Default "rod". */
    arm?: 'rod' | 'rope';
  };
}

export interface PistonObject extends ObjBase<'piston'> {
  props?: DynProps & {
    /** Extension length, m. Default 0.15. */
    stroke?: number;
    /** Head width. Default 0.06. */
    w?: number;
    /** m/s. Default 0.2. */
    speed?: number;
    /** N. Default 5. */
    force?: number;
    /** Default "cycle". "triggered": extends once when activated. */
    mode?: 'cycle' | 'triggered';
    /** Cycle period, s. Default 2. */
    period?: number;
    /** Cycle offset, 0–1. Default 0. */
    phase?: number;
  };
}

export interface ConveyorObject extends ObjBase<'conveyor'> {
  props?: StaticSurfaceProps & {
    /** Default 0.5. */
    w?: number;
    /** Default 0.05. */
    h?: number;
    /** Surface speed, m/s, signed. Default 0.3. */
    speed?: number;
    /** Default true. */
    active?: boolean;
  };
}

export interface PulleyObject extends ObjBase<'pulley'> {
  props?: StaticSurfaceProps & {
    /** Wheel radius. Default 0.06. */
    r?: number;
  };
}

// Fields (static emitters)

export interface FanObject extends ObjBase<'fan'> {
  props?: {
    /** N (peak, at the fan; linear falloff to 0 at range). Default 0.4. */
    strength?: number;
    /** m. Default 0.5. */
    range?: number;
    /** Cone half-angle, degrees 5–90. Default 25. */
    spread?: number;
    /** Default true. */
    active?: boolean;
  };
}

export interface MagnetObject extends ObjBase<'magnet'> {
  props?: {
    /** N at the 5 cm reference distance (03 §7.2). Positive attracts, negative repels. Default 3. */
    strength?: number;
    /** m. Default 0.4. */
    range?: number;
    /** Default true. */
    active?: boolean;
  };
}

// Logic (sensors)

export interface TriggerObject extends ObjBase<'trigger'> {
  props?: {
    /** Default 0.1. */
    w?: number;
    /** Default 0.1. */
    h?: number;
    /** Objects to activate (≤ 32). Default []. */
    targets?: Id[];
    /** Fire only on first entry. Default true. */
    once?: boolean;
  };
}

export interface GoalObject extends ObjBase<'goal'> {
  props?: {
    /** Default 0.1. */
    w?: number;
    /** Default 0.1. */
    h?: number;
    /** Which bodies count as success. Default "any". */
    accepts?: 'any' | Id[];
  };
}

/** Discriminated union over all 18 object types. */
export type SceneObject =
  | PlatformObject
  | RampObject
  | CurveObject
  | DominoObject
  | MarbleObject
  | CrateObject
  | PlankObject
  | GearObject
  | LeverObject
  | SpringObject
  | PendulumObject
  | PistonObject
  | ConveyorObject
  | PulleyObject
  | FanObject
  | MagnetObject
  | TriggerObject
  | GoalObject;

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export type LinkType = 'rope' | 'springLink' | 'weld' | 'axle' | 'gearMesh';

/** Where a link attaches. `anchor` and `at` are mutually exclusive; neither = "center". */
export interface Endpoint {
  obj: Id;
  /** Named anchor point (spec §6.3), e.g. "top", "endB", "bob". */
  anchor?: string;
  /** Offset in the object's local frame, meters. */
  at?: Vec2;
}

interface LinkBase<T extends LinkType> {
  id: Id;
  type: T;
  a: Endpoint;
  b: Endpoint;
}

export interface RopeLink extends LinkBase<'rope'> {
  props?: {
    /** m. Default: distance between endpoints at load. */
    length?: number;
    /** 0 (default) = ideal rope; 2–64 = collidable segmented rope. */
    segments?: number;
    /** Pulley object ids the rope routes through, ordered a→b (≤ 4). */
    via?: Id[];
  };
}

export interface SpringLinkLink extends LinkBase<'springLink'> {
  props?: {
    /** N/m. Default 50. */
    stiffness?: number;
    /** Default 0.5. */
    damping?: number;
    /** m. Default: initial distance. */
    restLength?: number;
  };
}

export interface WeldLink extends LinkBase<'weld'> {
  props?: Record<string, never>;
}

export interface AxleLink extends LinkBase<'axle'> {
  props?: {
    /** deg/s. Default 0 (free hinge). */
    motorSpeed?: number;
    /** N·m. Default 0.5. */
    maxTorque?: number;
  };
}

export interface GearMeshLink extends LinkBase<'gearMesh'> {
  props?: {
    /** Default −rA/rB (meshed gears counter-rotate). Positive = belt drive. */
    ratio?: number;
  };
}

/** Discriminated union over all 5 link types. */
export type Link = RopeLink | SpringLinkLink | WeldLink | AxleLink | GearMeshLink;

// ---------------------------------------------------------------------------
// Defaults & classification tables (single source for engine + builder + docs)
// ---------------------------------------------------------------------------

export interface MaterialDefaults {
  density: number;
  friction: number;
  restitution: number;
}

/** Per-type material defaults for dynamic-bodied types (spec §5.3; tuning pass: M2/U7). */
export const MATERIAL_DEFAULTS: Record<
  'domino' | 'marble' | 'crate' | 'plank' | 'gear' | 'lever' | 'spring' | 'pendulum' | 'piston',
  MaterialDefaults
> = {
  domino: { density: 6, friction: 0.5, restitution: 0.05 },
  marble: { density: 2.5, friction: 0.3, restitution: 0.3 },
  crate: { density: 4, friction: 0.5, restitution: 0.1 },
  plank: { density: 5, friction: 0.5, restitution: 0.1 },
  gear: { density: 6, friction: 0.6, restitution: 0.05 },
  lever: { density: 5, friction: 0.5, restitution: 0.1 },
  spring: { density: 5, friction: 0.5, restitution: 0.1 },
  pendulum: { density: 6, friction: 0.4, restitution: 0.2 },
  piston: { density: 6, friction: 0.5, restitution: 0.05 },
} as const;

export const WORLD_DEFAULTS = {
  gravity: 9.81,
  planeAngle: 0,
  seed: 1,
  bounds: [4, 2.4] as Vec2,
} as const;

/** Types whose primary body is dynamic (can move; accept DynProps). */
export const DYNAMIC_TYPES: readonly ObjectType[] = [
  'domino',
  'marble',
  'crate',
  'plank',
  'gear',
  'lever',
  'spring',
  'pendulum',
  'piston',
] as const;

/** Types that are valid `axle` endpoints (dynamic-bodied). */
export const AXLE_ATTACHABLE_TYPES: readonly ObjectType[] = DYNAMIC_TYPES;

/** Types a trigger can meaningfully activate (spec §5.4). */
export const ACTIVATABLE_TYPES: readonly ObjectType[] = [
  'fan',
  'magnet',
  'conveyor',
  'piston',
  'spring',
  'gear',
] as const;

/** Named anchors per type (spec §6.3). Every type also accepts "center" and `at`. */
export const NAMED_ANCHORS: Record<ObjectType, readonly string[]> = {
  platform: ['top', 'bottom', 'left', 'right'],
  ramp: ['top', 'bottom', 'left', 'right'],
  curve: ['endA', 'endB'],
  domino: ['top', 'bottom', 'left', 'right'],
  marble: [],
  crate: ['top', 'bottom', 'left', 'right'],
  plank: ['top', 'bottom', 'left', 'right'],
  gear: [],
  lever: ['endA', 'endB', 'pivot'],
  spring: ['base', 'plate'],
  pendulum: ['pivot', 'bob'],
  piston: ['base', 'head'],
  conveyor: ['top', 'bottom', 'left', 'right'],
  pulley: [],
  fan: [],
  magnet: [],
  trigger: ['top', 'bottom', 'left', 'right'],
  goal: ['top', 'bottom', 'left', 'right'],
} as const;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

const OBJECT_TYPES: readonly ObjectType[] = [
  'platform',
  'ramp',
  'curve',
  'domino',
  'marble',
  'crate',
  'plank',
  'gear',
  'lever',
  'spring',
  'pendulum',
  'piston',
  'conveyor',
  'pulley',
  'fan',
  'magnet',
  'trigger',
  'goal',
] as const;

const LINK_TYPES: readonly LinkType[] = ['rope', 'springLink', 'weld', 'axle', 'gearMesh'] as const;

export function isObjectType(t: string): t is ObjectType {
  return (OBJECT_TYPES as readonly string[]).includes(t);
}

export function isLinkType(t: string): t is LinkType {
  return (LINK_TYPES as readonly string[]).includes(t);
}

export function isDynamicType(t: ObjectType): boolean {
  return DYNAMIC_TYPES.includes(t);
}

export { OBJECT_TYPES, LINK_TYPES };
