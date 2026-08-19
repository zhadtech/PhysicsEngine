/**
 * Builder/editor model — the machine-checked half of 04-BUILDER-UX.md.
 *
 * Normative source: 04-BUILDER-UX.md (§5 interaction, §6 snapping, §8 inspector,
 * §9 undo/redo, §13 input maps). Inspector field descriptors whose keys are
 * compile-time-checked against the prop types in `@physics/scene-format`, the
 * palette grouping (with a type-level coverage proof), the editor command
 * (undo/redo) union, editor constants, and the default keymap.
 *
 * Moved here from `types/editor.ts` at P3 — its own header always said "lives in
 * the web app"; `types/editor.ts` is now a forwarding stub, the arrangement
 * `types/scene.ts` got at P1 and `types/protocol.ts` at P2. Nothing in this file
 * changed in the move except the import path.
 *
 * Prop ranges mirror `scene.schema.json`; `def` values mirror the 02 §5.3
 * catalog tables. This table is the UI + strict-writer source for type-prop
 * defaults; the engine's fill order is governed by 03 DET-4.
 */

import type {
  DynProps,
  Id,
  Link,
  LinkType,
  ObjectType,
  SceneMeta,
  SceneObject,
  StaticSurfaceProps,
  Vec2,
  World,
} from '@physics/scene-format';

// ---------------------------------------------------------------------------
// Editor constants (04 — normative; UX-tuning changes here never touch physics)
// ---------------------------------------------------------------------------

export const EDITOR = {
  /** Grid/position snap steps, meters (status-bar selector; `[` `]` cycle). */
  POS_SNAP_CHOICES_M: [0.005, 0.01, 0.02, 0.05, 0.1],
  POS_SNAP_DEFAULT_M: 0.01,
  /** Rotation snap, degrees (Alt = fine). */
  ROT_SNAP_DEG: 15,
  ROT_SNAP_FINE_DEG: 1,
  /** Arrow-key nudge: 1 snap step; Shift ×factor; Alt = fine meters. */
  NUDGE_LARGE_FACTOR: 5,
  NUDGE_FINE_M: 0.001,
  /** Smart guides (04 §6.2): alignment capture and candidate search. */
  ALIGN_SNAP_M: 0.005,
  SMART_GUIDE_RADIUS_M: 0.5,
  SMART_GUIDE_MAX_CANDIDATES: 24,
  /** Anchor dots capture radius, screen px (04 §6.3). */
  ANCHOR_PICK_RADIUS_PX: 12,
  /** Seat-on-static-surface cast range, meters (04 §5.2). */
  SURFACE_SNAP_RANGE_M: 0.02,
  /** Gear pitch-circle snap tolerance = clamp(factor·min(r), min, max) (04 §6.4). */
  GEAR_SNAP_TOL_FACTOR: 0.15,
  GEAR_SNAP_TOL_MIN_M: 0.003,
  GEAR_SNAP_TOL_MAX_M: 0.02,
  /** Domino-run spacing = factor × domino h; slider range (04 §5.2). */
  DOMINO_RUN_SPACING_FACTOR: 0.75,
  DOMINO_RUN_SPACING_RANGE: [0.4, 0.95],
  /** Touch (04 §13.2). */
  LONG_PRESS_MS: 350,
  TOUCH_MIN_TARGET_PX: 44,
  /** Undo history ring (04 §9). */
  HISTORY_CAP: 200,
  /** Autosave to IndexedDB (04 §14). */
  AUTOSAVE_INTERVAL_S: 30,
  AUTOSAVE_RING: 5,
  /** Live validation debounce (04 §8.5). */
  VALIDATE_DEBOUNCE_MS: 300,
  /** Amber warning threshold on object/link/body budgets (04 §14). */
  BUDGET_WARN_FRACTION: 0.8,
  /** Camera (04 §4): pitch presets/clamp; view roll clamp for planeAngle. */
  CAMERA_TILT_DEFAULT_DEG: 15,
  CAMERA_TILT_MAX_DEG: 35,
  PLANE_ROLL_CLAMP_DEG: 25,
  /**
   * Vertical field of view. 04 §4 says "perspective" and states the zoom range
   * in *pixels*, which only becomes a distance once an FOV exists — a silence
   * filled at P3b (04 §17). 50° is Three.js's own default, so the number is
   * adopted rather than invented, and every zoom limit derives from it.
   */
  CAMERA_FOV_DEG: 50,
  /** Zoom-out limit: "fit-bounds + 20% margin" (04 §4). */
  CAMERA_FIT_MARGIN: 0.2,
  /** Zoom-in limit, stated as a resolution: "~1 cm spanning ~50 px" (04 §4). */
  CAMERA_MIN_SPAN_M: 0.01,
  CAMERA_MIN_SPAN_PX: 50,
  /** Grid (04 §4): a major line every this many minor lines. */
  GRID_MAJOR_EVERY: 10,
  /** Thumbnail render size (04 §11.2). */
  THUMB_W: 640,
  THUMB_H: 360,
} as const;

// ---------------------------------------------------------------------------
// Modes, tools, selection
// ---------------------------------------------------------------------------

export type EditorMode = 'edit' | 'test';

export type PlaceTool = `place:${ObjectType}`;
export type LinkTool = `link:${LinkType}`;

/** pick* tools are inspector-initiated canvas modes (04 §7.2–7.3). */
export type ToolId =
  | 'select'
  | 'pan'
  | PlaceTool
  | LinkTool
  | 'pickTargets'
  | 'pickAccepts'
  | 'pickVia';

export interface Selection {
  objects: readonly Id[];
  links: readonly Id[];
}

// ---------------------------------------------------------------------------
// Undo/redo commands (04 §9) — every store mutation is one of these
// ---------------------------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [k: string]: JsonValue };

export interface Placement {
  pos: Vec2;
  rot: number;
}

export interface TransformDelta {
  id: Id;
  before: Placement;
  after: Placement;
}

/**
 * One scalar/field change. `key` is a dot-path from the object/link root
 * ("props.stiffness", "skin", "rot"). `undefined` = field omitted (default) —
 * the strict writer never emits defaults (02 §2).
 */
export interface PropDelta {
  id: Id;
  key: string;
  before: JsonValue | undefined;
  after: JsonValue | undefined;
}

/** Reference-list edit captured by delete cascades (04 §5.5) for exact undo. */
export interface RefEdit {
  owner: Id;
  list: 'targets' | 'accepts' | 'via';
  index: number;
  removed: Id;
}

export type EditorCommand =
  | { op: 'add'; objects: readonly SceneObject[]; links: readonly Link[] }
  | {
      op: 'remove';
      objects: readonly SceneObject[];
      links: readonly Link[];
      refEdits: readonly RefEdit[];
      /**
       * The document index each removed object/link sat at — parallel to the
       * arrays above, ascending.
       *
       * Added at P3a (04 §9, §15). The union as designed could restore the
       * *content* of a delete but not its place: re-adding at the end after an
       * undo silently rewrites the document's object order. Physics does not
       * care (DET-3 sorts by id at load), but 04 §14's export does — a file
       * would come back from a delete/undo with its objects shuffled, and the
       * "imports byte-stable" claim would hold only for documents nobody had
       * edited.
       */
      at: { objects: readonly number[]; links: readonly number[] };
    }
  | { op: 'transform'; deltas: readonly TransformDelta[] }
  | { op: 'props'; deltas: readonly PropDelta[] }
  | { op: 'world'; before: World; after: World }
  | { op: 'meta'; before: SceneMeta; after: SceneMeta }
  | { op: 'rename'; from: Id; to: Id }
  | { op: 'composite'; label: string; commands: readonly EditorCommand[] };

// ---------------------------------------------------------------------------
// Inspector field descriptors (04 §8.1) — keys compile-checked against scene.ts
// ---------------------------------------------------------------------------

export type Unit =
  | 'm'
  | 'deg'
  | 'kg/m2'
  | 'N'
  | 'N·m'
  | 'N/m'
  | 'm/s'
  | 'deg/s'
  | 's'
  | '';

export interface NumberField<K extends string = string> {
  kind: 'number';
  key: K;
  label: string;
  unit: Unit;
  min: number;
  max: number;
  /** Scrub/stepper increment (UI only; typed entry is free within range). */
  step: number;
  /** Omitted = optional prop with no default (e.g. lever limits, auto lengths). */
  def?: number;
}

export interface BooleanField<K extends string = string> {
  kind: 'boolean';
  key: K;
  label: string;
  def: boolean;
}

export interface EnumField<K extends string = string> {
  kind: 'enum';
  key: K;
  label: string;
  options: readonly string[];
  def: string;
}

export interface Vec2Field<K extends string = string> {
  kind: 'vec2';
  key: K;
  label: string;
  unit: Unit;
  min: number;
  max: number;
  step: number;
  def: Vec2;
}

/** Id-list picker with canvas pick mode (04 §7.3). */
export interface IdListField<K extends string = string> {
  kind: 'idList';
  key: K;
  label: string;
  max: number;
  /** Which objects highlight as valid picks. */
  valid: 'activatable' | 'pulley' | 'any';
  /** goal.accepts: list may be replaced by the literal "any". */
  orAny?: boolean;
}

export type PropField<K extends string = string> =
  | NumberField<K>
  | BooleanField<K>
  | EnumField<K>
  | Vec2Field<K>
  | IdListField<K>;

type PropsOf<T extends ObjectType> = NonNullable<Extract<SceneObject, { type: T }>['props']>;
type PropKey<T extends ObjectType> = Extract<keyof PropsOf<T>, string>;
type LinkPropsOf<T extends LinkType> = NonNullable<Extract<Link, { type: T }>['props']>;
type LinkPropKey<T extends LinkType> = Extract<keyof LinkPropsOf<T>, string>;

/** Type-specific fields (the "<Type>" inspector section, 04 §8.1). */
export const TYPE_PROP_FIELDS: { [T in ObjectType]: readonly PropField<PropKey<T>>[] } = {
  platform: [
    { kind: 'number', key: 'w', label: 'Width', unit: 'm', min: 0.02, max: 200, step: 0.01, def: 1 },
    { kind: 'number', key: 'h', label: 'Height', unit: 'm', min: 0.02, max: 200, step: 0.01, def: 0.05 },
  ],
  ramp: [
    { kind: 'number', key: 'w', label: 'Width', unit: 'm', min: 0.05, max: 10, step: 0.01, def: 0.5 },
    { kind: 'number', key: 'h', label: 'Height', unit: 'm', min: 0.05, max: 10, step: 0.01, def: 0.3 },
    { kind: 'boolean', key: 'flip', label: 'Flip', def: false },
  ],
  curve: [
    { kind: 'number', key: 'r', label: 'Radius', unit: 'm', min: 0.05, max: 5, step: 0.01, def: 0.4 },
    { kind: 'number', key: 'thickness', label: 'Wall', unit: 'm', min: 0.01, max: 0.2, step: 0.005, def: 0.03 },
    { kind: 'number', key: 'sweep', label: 'Sweep', unit: 'deg', min: 15, max: 180, step: 1, def: 90 },
    { kind: 'boolean', key: 'flip', label: 'Flip', def: false },
  ],
  domino: [
    { kind: 'number', key: 'h', label: 'Height', unit: 'm', min: 0.02, max: 1, step: 0.005, def: 0.08 },
  ],
  marble: [
    { kind: 'number', key: 'r', label: 'Radius', unit: 'm', min: 0.005, max: 0.5, step: 0.005, def: 0.025 },
  ],
  crate: [
    { kind: 'number', key: 'w', label: 'Width', unit: 'm', min: 0.02, max: 2, step: 0.01, def: 0.08 },
    { kind: 'number', key: 'h', label: 'Height', unit: 'm', min: 0.02, max: 2, step: 0.01, def: 0.08 },
  ],
  plank: [
    { kind: 'number', key: 'w', label: 'Length', unit: 'm', min: 0.05, max: 4, step: 0.01, def: 0.4 },
    { kind: 'number', key: 'h', label: 'Thickness', unit: 'm', min: 0.005, max: 0.2, step: 0.005, def: 0.02 },
  ],
  gear: [
    { kind: 'number', key: 'r', label: 'Radius', unit: 'm', min: 0.02, max: 1, step: 0.005, def: 0.1 },
    { kind: 'number', key: 'motorSpeed', label: 'Motor speed', unit: 'deg/s', min: -3600, max: 3600, step: 5, def: 0 },
    { kind: 'number', key: 'maxTorque', label: 'Max torque', unit: 'N·m', min: 0, max: 100, step: 0.05, def: 0.5 },
  ],
  lever: [
    { kind: 'number', key: 'len', label: 'Length', unit: 'm', min: 0.05, max: 4, step: 0.01, def: 0.4 },
    { kind: 'number', key: 'h', label: 'Thickness', unit: 'm', min: 0.005, max: 0.2, step: 0.005, def: 0.02 },
    { kind: 'number', key: 'pivot', label: 'Pivot', unit: '', min: 0, max: 1, step: 0.05, def: 0.5 },
    { kind: 'number', key: 'minAngle', label: 'Min angle', unit: 'deg', min: -360, max: 360, step: 1 },
    { kind: 'number', key: 'maxAngle', label: 'Max angle', unit: 'deg', min: -360, max: 360, step: 1 },
  ],
  spring: [
    { kind: 'number', key: 'w', label: 'Pad width', unit: 'm', min: 0.02, max: 1, step: 0.01, def: 0.1 },
    { kind: 'number', key: 'travel', label: 'Travel', unit: 'm', min: 0.01, max: 0.5, step: 0.005, def: 0.08 },
    { kind: 'number', key: 'stiffness', label: 'Stiffness', unit: 'N/m', min: 1, max: 5000, step: 1, def: 25 },
    { kind: 'number', key: 'damping', label: 'Damping', unit: '', min: 0, max: 100, step: 0.1, def: 0.5 },
    { kind: 'enum', key: 'mode', label: 'Mode', options: ['passive', 'triggered'], def: 'passive' },
  ],
  pendulum: [
    { kind: 'number', key: 'len', label: 'Arm length', unit: 'm', min: 0.05, max: 5, step: 0.01, def: 0.3 },
    { kind: 'number', key: 'bobR', label: 'Bob radius', unit: 'm', min: 0.01, max: 0.5, step: 0.005, def: 0.04 },
    { kind: 'enum', key: 'arm', label: 'Arm', options: ['rod', 'rope'], def: 'rod' },
  ],
  piston: [
    { kind: 'number', key: 'stroke', label: 'Stroke', unit: 'm', min: 0.02, max: 2, step: 0.01, def: 0.15 },
    { kind: 'number', key: 'w', label: 'Head width', unit: 'm', min: 0.02, max: 0.5, step: 0.01, def: 0.06 },
    { kind: 'number', key: 'speed', label: 'Speed', unit: 'm/s', min: 0.01, max: 5, step: 0.01, def: 0.2 },
    { kind: 'number', key: 'force', label: 'Force', unit: 'N', min: 0.1, max: 500, step: 0.1, def: 5 },
    { kind: 'enum', key: 'mode', label: 'Mode', options: ['cycle', 'triggered'], def: 'cycle' },
    { kind: 'number', key: 'period', label: 'Period', unit: 's', min: 0.2, max: 60, step: 0.1, def: 2 },
    { kind: 'number', key: 'phase', label: 'Phase', unit: '', min: 0, max: 1, step: 0.05, def: 0 },
  ],
  conveyor: [
    { kind: 'number', key: 'w', label: 'Length', unit: 'm', min: 0.05, max: 10, step: 0.01, def: 0.5 },
    { kind: 'number', key: 'h', label: 'Height', unit: 'm', min: 0.02, max: 0.5, step: 0.01, def: 0.05 },
    { kind: 'number', key: 'speed', label: 'Belt speed', unit: 'm/s', min: -5, max: 5, step: 0.05, def: 0.3 },
    { kind: 'boolean', key: 'active', label: 'Active', def: true },
  ],
  pulley: [
    { kind: 'number', key: 'r', label: 'Wheel radius', unit: 'm', min: 0.02, max: 0.5, step: 0.005, def: 0.06 },
  ],
  fan: [
    { kind: 'number', key: 'strength', label: 'Strength', unit: 'N', min: 0.1, max: 100, step: 0.05, def: 0.4 },
    { kind: 'number', key: 'range', label: 'Range', unit: 'm', min: 0.05, max: 10, step: 0.05, def: 0.5 },
    { kind: 'number', key: 'spread', label: 'Spread', unit: 'deg', min: 5, max: 90, step: 1, def: 25 },
    { kind: 'boolean', key: 'active', label: 'Active', def: true },
  ],
  magnet: [
    { kind: 'number', key: 'strength', label: 'Strength @5cm', unit: 'N', min: -100, max: 100, step: 0.5, def: 3 },
    { kind: 'number', key: 'range', label: 'Range', unit: 'm', min: 0.05, max: 10, step: 0.05, def: 0.4 },
    { kind: 'boolean', key: 'active', label: 'Active', def: true },
  ],
  trigger: [
    { kind: 'number', key: 'w', label: 'Width', unit: 'm', min: 0.02, max: 5, step: 0.01, def: 0.1 },
    { kind: 'number', key: 'h', label: 'Height', unit: 'm', min: 0.02, max: 5, step: 0.01, def: 0.1 },
    { kind: 'idList', key: 'targets', label: 'Targets', max: 32, valid: 'activatable' },
    { kind: 'boolean', key: 'once', label: 'Fire once', def: true },
  ],
  goal: [
    { kind: 'number', key: 'w', label: 'Width', unit: 'm', min: 0.02, max: 5, step: 0.01, def: 0.1 },
    { kind: 'number', key: 'h', label: 'Height', unit: 'm', min: 0.02, max: 5, step: 0.01, def: 0.1 },
    { kind: 'idList', key: 'accepts', label: 'Accepts', max: 32, valid: 'any', orAny: true },
  ],
};

/** Link inspector fields (04 §7.2). */
export const LINK_PROP_FIELDS: { [T in LinkType]: readonly PropField<LinkPropKey<T>>[] } = {
  rope: [
    // def omitted: auto = distance between endpoints at load (02 §6.2).
    { kind: 'number', key: 'length', label: 'Length', unit: 'm', min: 0.01, max: 500, step: 0.01 },
    // 1 is schema-invalid (0 or 2–64); the field's commit logic skips it.
    { kind: 'number', key: 'segments', label: 'Segments', unit: '', min: 0, max: 64, step: 1, def: 0 },
    { kind: 'idList', key: 'via', label: 'Via pulleys', max: 4, valid: 'pulley' },
  ],
  springLink: [
    { kind: 'number', key: 'stiffness', label: 'Stiffness', unit: 'N/m', min: 1, max: 5000, step: 1, def: 50 },
    { kind: 'number', key: 'damping', label: 'Damping', unit: '', min: 0, max: 100, step: 0.1, def: 0.5 },
    // def omitted: auto = initial distance.
    { kind: 'number', key: 'restLength', label: 'Rest length', unit: 'm', min: 0.01, max: 500, step: 0.01 },
  ],
  weld: [],
  axle: [
    { kind: 'number', key: 'motorSpeed', label: 'Motor speed', unit: 'deg/s', min: -3600, max: 3600, step: 5, def: 0 },
    { kind: 'number', key: 'maxTorque', label: 'Max torque', unit: 'N·m', min: 0, max: 100, step: 0.05, def: 0.5 },
  ],
  gearMesh: [
    // def omitted: geometric mesh, ratio −rA/rB (04 §6.4); explicit value = manual.
    { kind: 'number', key: 'ratio', label: 'Ratio', unit: '', min: -100, max: 100, step: 0.05 },
  ],
};

/** Shared Material-section fields (04 §8.1), keyed against the shared prop types. */
export const DYN_MATERIAL_FIELDS: readonly PropField<Extract<keyof DynProps, string>>[] = [
  { kind: 'number', key: 'density', label: 'Density', unit: 'kg/m2', min: 0.1, max: 100, step: 0.1 },
  { kind: 'number', key: 'friction', label: 'Friction', unit: '', min: 0, max: 2, step: 0.05 },
  { kind: 'number', key: 'restitution', label: 'Bounciness', unit: '', min: 0, max: 1, step: 0.05 },
  { kind: 'boolean', key: 'magnetic', label: 'Magnetic', def: false },
  { kind: 'boolean', key: 'anchored', label: 'Anchored', def: false },
];

/** Motion section (collapsed by default). */
export const DYN_MOTION_FIELDS: readonly PropField<Extract<keyof DynProps, string>>[] = [
  { kind: 'vec2', key: 'vel', label: 'Velocity', unit: 'm/s', min: -50, max: 50, step: 0.1, def: [0, 0] },
  { kind: 'number', key: 'angVel', label: 'Spin', unit: 'deg/s', min: -3600, max: 3600, step: 5, def: 0 },
];

export const STATIC_SURFACE_FIELDS: readonly PropField<Extract<keyof StaticSurfaceProps, string>>[] = [
  { kind: 'number', key: 'friction', label: 'Friction', unit: '', min: 0, max: 2, step: 0.05 },
  { kind: 'number', key: 'restitution', label: 'Bounciness', unit: '', min: 0, max: 1, step: 0.05 },
];

/**
 * Which Material section a type gets (04 §8.1). Density defaults for 'dyn'
 * types come from MATERIAL_DEFAULTS in scene.ts.
 */
export const MATERIAL_SECTION: Record<ObjectType, 'dyn' | 'staticSurface' | 'none'> = {
  platform: 'staticSurface',
  ramp: 'staticSurface',
  curve: 'staticSurface',
  domino: 'dyn',
  marble: 'dyn',
  crate: 'dyn',
  plank: 'dyn',
  gear: 'dyn',
  lever: 'dyn',
  spring: 'dyn',
  pendulum: 'dyn',
  piston: 'dyn',
  conveyor: 'staticSurface',
  pulley: 'staticSurface',
  fan: 'none',
  magnet: 'none',
  trigger: 'none',
  goal: 'none',
};

// ---------------------------------------------------------------------------
// Palette (04 §3.1) — grouping with a type-level coverage proof
// ---------------------------------------------------------------------------

export interface PaletteGroup {
  id: string;
  label: string;
  items: readonly ObjectType[];
}

export const PALETTE_GROUPS = [
  { id: 'structure', label: 'Structure', items: ['platform', 'ramp', 'curve'] },
  { id: 'movers', label: 'Movers', items: ['domino', 'marble', 'crate', 'plank'] },
  {
    id: 'mechanisms',
    label: 'Mechanisms',
    items: ['gear', 'lever', 'spring', 'pendulum', 'piston', 'conveyor', 'pulley'],
  },
  { id: 'fields', label: 'Fields', items: ['fan', 'magnet'] },
  { id: 'logic', label: 'Logic', items: ['trigger', 'goal'] },
] as const satisfies readonly PaletteGroup[];

export const LINK_TOOL_ORDER = ['rope', 'springLink', 'weld', 'axle', 'gearMesh'] as const satisfies readonly LinkType[];

// Compile-time proofs: every ObjectType appears in the palette, every LinkType
// in the link group. A gap makes these assignments fail with the missing name.
type PaletteItem = (typeof PALETTE_GROUPS)[number]['items'][number];
const paletteCoversAllTypes: Exclude<ObjectType, PaletteItem> extends never ? true : Exclude<ObjectType, PaletteItem> = true;
type LinkToolItem = (typeof LINK_TOOL_ORDER)[number];
const linkToolsCoverAllTypes: Exclude<LinkType, LinkToolItem> extends never ? true : Exclude<LinkType, LinkToolItem> = true;
void paletteCoversAllTypes;
void linkToolsCoverAllTypes;

// ---------------------------------------------------------------------------
// Id generation (04 §5.2): `<prefix><n>`, n = smallest unused positive integer
// ---------------------------------------------------------------------------

export const ID_PREFIX: Record<ObjectType | LinkType, string> = {
  platform: 'pla',
  ramp: 'ram',
  curve: 'cur',
  domino: 'dom',
  marble: 'mar',
  crate: 'cra',
  plank: 'plk',
  gear: 'gear',
  lever: 'lev',
  spring: 'spr',
  pendulum: 'pen',
  piston: 'pis',
  conveyor: 'con',
  pulley: 'pul',
  fan: 'fan',
  magnet: 'mag',
  trigger: 'tri',
  goal: 'goal',
  rope: 'rope',
  springLink: 'sprl',
  weld: 'weld',
  axle: 'axle',
  gearMesh: 'mesh',
};

// ---------------------------------------------------------------------------
// Skins (04 §12.3) — names normative here; materials are M8 (U11)
// ---------------------------------------------------------------------------

export const SKIN_NAMES = ['wood', 'steel', 'brass', 'stone', 'glass', 'rubber', 'neon', 'candy'] as const;
export type SkinName = (typeof SKIN_NAMES)[number];

/** Unknown skin strings in a file fall back to these (02 §5.1). */
export const DEFAULT_SKIN: Record<ObjectType, SkinName> = {
  platform: 'stone',
  ramp: 'wood',
  curve: 'steel',
  domino: 'wood',
  marble: 'glass',
  crate: 'wood',
  plank: 'wood',
  gear: 'brass',
  lever: 'wood',
  spring: 'steel',
  pendulum: 'steel',
  piston: 'steel',
  conveyor: 'rubber',
  pulley: 'brass',
  fan: 'steel',
  magnet: 'candy',
  trigger: 'neon',
  goal: 'neon',
};

// ---------------------------------------------------------------------------
// gearMesh visuals — D9 (04 §12.1) and the snap tolerance it shares with §6.4
// ---------------------------------------------------------------------------

export type GearMeshVisual = 'contact' | 'openBelt' | 'crossedBelt' | 'dashed';

export function gearSnapTol(rA: number, rB: number): number {
  return Math.min(
    EDITOR.GEAR_SNAP_TOL_MAX_M,
    Math.max(EDITOR.GEAR_SNAP_TOL_MIN_M, EDITOR.GEAR_SNAP_TOL_FACTOR * Math.min(rA, rB)),
  );
}

/**
 * D9 classifier. `ratio` = the link's explicit prop (undefined = geometric mesh).
 * Open belt needs outer tangents (dist > |rA−rB|); crossed belt needs inner
 * tangents (dist > rA+rB). Touching + explicit positive ratio is geometrically
 * belt-less → dashed fallback rather than a lying mesh glint.
 */
export function gearMeshVisual(
  ratio: number | undefined,
  rA: number,
  rB: number,
  centerDist: number,
): GearMeshVisual {
  const touching = Math.abs(centerDist - (rA + rB)) <= gearSnapTol(rA, rB);
  if (touching) return ratio !== undefined && ratio > 0 ? 'dashed' : 'contact';
  if (centerDist <= Math.abs(rA - rB) || centerDist < 1e-6) return 'dashed'; // nested/degenerate
  const rho = ratio ?? -(rA / rB);
  if (rho >= 0) return 'openBelt';
  return centerDist > rA + rB ? 'crossedBelt' : 'dashed';
}

// ---------------------------------------------------------------------------
// Keymap (04 §13.1) — single machine-readable source for bindings + help sheet
// ---------------------------------------------------------------------------

export type KeyContext = 'edit' | 'test' | 'both';
/** 'mod' = Cmd on macOS, Ctrl elsewhere. */
export type KeyMod = 'mod' | 'shift' | 'alt';

export type EditorAction =
  | 'tool.select'
  | 'tool.pan'
  | 'palette.search'
  | 'link.quickPick'
  | 'edit.nudge'
  | 'edit.rotateCW'
  | 'edit.rotateCCW'
  | 'edit.flip'
  | 'edit.toggleAnchored'
  | 'edit.duplicate'
  | 'edit.delete'
  | 'edit.copy'
  | 'edit.cut'
  | 'edit.paste'
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.selectAll'
  | 'edit.save'
  | 'edit.gridToggle'
  | 'edit.snapStepDown'
  | 'edit.snapStepUp'
  | 'view.frame'
  | 'view.resetCamera'
  | 'view.cameraPreset'
  | 'view.holdPan'
  | 'test.toggle'
  | 'test.playPause'
  | 'test.step'
  | 'test.step10'
  | 'test.speedDown'
  | 'test.speedUp'
  | 'test.reset'
  | 'test.playAgain'
  | 'test.debugOverlay'
  | 'app.escape';

export interface KeyBinding {
  action: EditorAction;
  /** KeyboardEvent.key, except letters given uppercase for display. */
  key: string;
  mods?: readonly KeyMod[];
  context: KeyContext;
}

/**
 * Defaults (04 §13.1 renders this table). Modifier scaling of `edit.nudge`
 * (Shift ×NUDGE_LARGE_FACTOR, Alt = NUDGE_FINE_M) is handler logic, not
 * separate bindings; Alt-hold snap bypass and Shift axis-lock are pointer
 * chords, not keymap entries.
 */
export const DEFAULT_KEYMAP: readonly KeyBinding[] = [
  { action: 'tool.select', key: 'V', context: 'edit' },
  { action: 'tool.pan', key: 'H', context: 'edit' },
  { action: 'palette.search', key: '/', context: 'edit' },
  { action: 'link.quickPick', key: 'L', context: 'edit' },
  { action: 'edit.nudge', key: 'ArrowLeft', context: 'edit' },
  { action: 'edit.nudge', key: 'ArrowRight', context: 'edit' },
  { action: 'edit.nudge', key: 'ArrowUp', context: 'edit' },
  { action: 'edit.nudge', key: 'ArrowDown', context: 'edit' },
  { action: 'edit.rotateCW', key: 'R', context: 'edit' },
  { action: 'edit.rotateCCW', key: 'R', mods: ['shift'], context: 'edit' },
  { action: 'edit.flip', key: 'X', context: 'edit' },
  { action: 'edit.toggleAnchored', key: 'A', context: 'edit' },
  { action: 'edit.duplicate', key: 'D', mods: ['mod'], context: 'edit' },
  { action: 'edit.delete', key: 'Delete', context: 'edit' },
  { action: 'edit.delete', key: 'Backspace', context: 'edit' },
  { action: 'edit.copy', key: 'C', mods: ['mod'], context: 'edit' },
  { action: 'edit.cut', key: 'X', mods: ['mod'], context: 'edit' },
  { action: 'edit.paste', key: 'V', mods: ['mod'], context: 'edit' },
  { action: 'edit.undo', key: 'Z', mods: ['mod'], context: 'edit' },
  { action: 'edit.redo', key: 'Z', mods: ['mod', 'shift'], context: 'edit' },
  { action: 'edit.selectAll', key: 'A', mods: ['mod'], context: 'edit' },
  { action: 'edit.save', key: 'S', mods: ['mod'], context: 'edit' },
  { action: 'edit.gridToggle', key: 'G', context: 'edit' },
  { action: 'edit.snapStepDown', key: '[', context: 'edit' },
  { action: 'edit.snapStepUp', key: ']', context: 'edit' },
  { action: 'view.frame', key: 'F', context: 'both' },
  { action: 'view.resetCamera', key: '0', context: 'both' },
  { action: 'view.cameraPreset', key: 'C', context: 'both' },
  { action: 'view.holdPan', key: ' ', context: 'edit' },
  { action: 'test.toggle', key: 'P', context: 'both' },
  { action: 'test.toggle', key: 'Enter', mods: ['mod'], context: 'both' },
  { action: 'test.playPause', key: ' ', context: 'test' },
  { action: 'test.step', key: '.', context: 'test' },
  { action: 'test.step10', key: '.', mods: ['shift'], context: 'test' },
  { action: 'test.speedDown', key: '-', context: 'test' },
  { action: 'test.speedUp', key: '+', context: 'test' },
  { action: 'test.reset', key: 'Backspace', context: 'test' },
  { action: 'test.playAgain', key: 'Enter', context: 'test' },
  { action: 'test.debugOverlay', key: 'F3', context: 'test' },
  { action: 'app.escape', key: 'Escape', context: 'both' },
];

// ---------------------------------------------------------------------------
// Clipboard (04 §5.5)
// ---------------------------------------------------------------------------

export const CLIP_FORMAT = 'physics-sandbox/objects@1' as const;

export interface ClipboardPayload {
  clip: typeof CLIP_FORMAT;
  objects: readonly SceneObject[];
  links: readonly Link[];
}
