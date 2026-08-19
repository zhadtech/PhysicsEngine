/**
 * The render plan — 09 §4's classification, made a data structure.
 *
 * The renderer's whole performance argument is that **draw calls are bounded by
 * kinds, not by object count**: a 5 000-domino scene is one instanced draw. That
 * argument is a property of this file, not of Three.js, so it is computed here
 * as plain data and checked by `node:test` — the binding in `three.ts` only
 * uploads what this decides.
 *
 * Nothing here re-derives geometry. Every shape comes from the engine's own §6
 * expansion through `@physics/engine/geometry`, because 03 §5.3's "static
 * geometry is not sent over the boundary" is only safe if the picture and the
 * physics come out of the same function (P3a made the same argument for the
 * status bar's body count).
 *
 * ## The one thing 09 §4 undercounts, found here
 *
 * §4 gives the ceiling as `MAX_INSTANCE_GROUPS = 11 types × 8 skins = 88` and
 * treats that as the draw-call ceiling. A group and a draw are the same thing
 * only if every prefab of a type is one primitive — and one is not. A `pendulum`
 * with `arm: 'rigid'` is a single body carrying **two** colliders of different
 * kinds (03 §6: a ball bob at `[0, −len]` and a cuboid rod), whose sizes come
 * from two independent props (`bobR`, `len`). No single unit mesh under an
 * affine per-instance transform draws both: scale it uniformly and the rod is
 * wrong, scale it non-uniformly and the bob is an ellipsoid.
 *
 * So the two ceilings are separated rather than conflated, and both are kept:
 *   - `MAX_INSTANCE_GROUPS` (88) — the number of **(type, skin) groups**, which
 *     is what selection, per-type LOD meshes and material assignment key on. The
 *     compile proof in `perf.ts` is untouched.
 *   - `MAX_INSTANCE_DRAWS` (96) — the number of **InstancedMesh draws**, which is
 *     what a frame actually costs and what P3d's gate measures. It is derived
 *     from the primitives the §6 table really emits, not asserted; `verify-web`
 *     part G re-derives it from the engine and fails if the two disagree.
 *
 * The claim 09 §4 exists to make survives intact: 96 is still a constant, still
 * independent of object count, still one draw for five thousand dominoes.
 *
 * Contract: docs/09-PERFORMANCE.md §4; docs/04-BUILDER-UX.md §12.
 */

import type { Id, ObjectType, Scene, Vec2 } from '@physics/scene-format';
import type { BodyPiece } from '@physics/engine/protocol';
import type { CanonicalObject, CanonicalScene, ColliderShape, ObjectGeometry, Pose } from '@physics/engine/geometry';
import { canonicalize, dcos, dsin, objectGeometry } from '@physics/engine/geometry';
import { DEFAULT_SKIN, SKIN_NAMES, type SkinName } from '../editor/model.js';
import { INSTANCED_TYPES, MAX_INSTANCE_GROUPS, RENDER, RENDER_CLASS, type RenderClass } from './perf.js';

/** A catalog type 09 §4 draws with an `InstancedMesh`. */
export type InstancedType = (typeof INSTANCED_TYPES)[number];

/**
 * The unit meshes the instanced batch is built from. `box` and `sphere` are the
 * collider kinds directly; `disc` is a *render* choice for the one type whose
 * ball collider is a wheel seen edge-on in 2.5D (a gear is not a marble), which
 * is why this table is declared rather than derived from collider kinds alone.
 */
export type InstancePrimitive = 'box' | 'sphere' | 'disc';

/**
 * Primitives per instanced type, in the order 03 §6 emits their colliders.
 *
 * Ten types are one primitive each; `pendulum` is the exception described in the
 * header. `verify-web` part G derives the collider kinds this must correspond to
 * by expanding every type (and, for types whose props change their expansion,
 * every variant) through the engine, so a §6 change that adds a piece cannot
 * pass unnoticed.
 */
export const INSTANCE_PRIMITIVES = {
  platform: ['box'],
  domino: ['box'],
  marble: ['sphere'],
  crate: ['box'],
  plank: ['box'],
  gear: ['disc'],
  lever: ['box'],
  spring: ['box'],
  pendulum: ['sphere', 'box'],
  piston: ['box'],
  conveyor: ['box'],
} as const satisfies Record<InstancedType, readonly InstancePrimitive[]>;

/** The collider kind each primitive is drawn for — the tie `verify-web` re-derives. */
export const PRIMITIVE_COLLIDER = {
  box: 'cuboid',
  sphere: 'ball',
  disc: 'ball',
} as const satisfies Record<InstancePrimitive, ColliderShape['kind']>;

/**
 * The real draw-call ceiling: one `InstancedMesh` per (type, skin, primitive).
 * 12 × 8 = 96 — a constant, independent of object count (09 §4, corrected above).
 */
export const MAX_INSTANCE_DRAWS =
  INSTANCED_TYPES.reduce((n, t) => n + INSTANCE_PRIMITIVES[t].length, 0) * SKIN_NAMES.length;

/**
 * Worst-case draws from the solid batch once `RENDER.INSTANCE_MIN` is applied.
 *
 * A group holding fewer than `INSTANCE_MIN` instances is cheaper drawn one at a
 * time than as an `InstancedMesh` (setup cost), which trades one draw for up to
 * `INSTANCE_MIN − 1`. That is still object-count-independent — and it can only
 * happen in a scene with at most this many instances in total, i.e. exactly the
 * scenes where draw count does not matter. Above that size every group is large
 * and the count is back under `MAX_INSTANCE_DRAWS`.
 */
export const MAX_SOLID_DRAWS = MAX_INSTANCE_DRAWS * (RENDER.INSTANCE_MIN - 1);

/** `type:skin` — 09 §4's group, the key for material and per-type LOD mesh. */
export type GroupKey = `${InstancedType}:${SkinName}`;
/** `type:skin:primitive` — one `InstancedMesh`. */
export type MeshKey = `${GroupKey}:${InstancePrimitive}`;

/**
 * One drawn primitive. `pose` is the *static* world pose for a fixed body; a
 * dynamic body's pose arrives per frame in the SAB, and `slot` says where.
 */
export interface Instance {
  objId: Id;
  piece: BodyPiece;
  primitive: InstancePrimitive;
  /** Collider offset in the body's local frame, and its extra rotation. */
  offset: Vec2;
  offsetRot: number;
  /** Half-extents for `box`; `r` for `sphere`/`disc`. */
  hx: number;
  hy: number;
  r: number;
  /** World pose for a body the simulation never moves; `null` when `slot` drives it. */
  pose: Pose | null;
  /** Index into the frame buffer, filled by `bindRegistry`; −1 until then. */
  slot: number;
}

export interface InstanceMesh {
  key: MeshKey;
  type: InstancedType;
  skin: SkinName;
  primitive: InstancePrimitive;
  instances: Instance[];
}

/** Bespoke per-object vertices — ramps and curves (09 §4 `generated`). */
export interface GeneratedShape {
  objId: Id;
  type: ObjectType;
  skin: SkinName;
  /** Closed polygon (ramp) or the arc's segment boxes (curve), in world space. */
  outline: readonly Vec2[];
  pose: Pose;
}

/** Translucent guides — fields, sensors and the pulley wheel (09 §4 `overlay`). */
export interface OverlayShape {
  objId: Id;
  type: ObjectType;
  skin: SkinName;
  pose: Pose;
  /** Sensor/field extent: a box (`trigger`/`goal`), a radius (`magnet`/`pulley`) or a cone (`fan`). */
  shape:
    | { kind: 'box'; hx: number; hy: number }
    | { kind: 'radius'; r: number }
    | { kind: 'cone'; dir: Vec2; spreadDeg: number; range: number };
}

export interface RenderPlan {
  meshes: readonly InstanceMesh[];
  generated: readonly GeneratedShape[];
  overlays: readonly OverlayShape[];
  /** The canonical scene the plan was built from — the renderer needs its world. */
  scene: CanonicalScene;
}

/**
 * 02 §5.1: an unknown skin falls back to the type default rather than failing.
 * The file is not re-validated here — the gate already ran (04 §10.1) — so this
 * is the same tolerance the loader applies, in the one place the picture needs it.
 */
export function resolveSkin(type: ObjectType, skin: string | undefined): SkinName {
  if (skin !== undefined && (SKIN_NAMES as readonly string[]).includes(skin)) return skin as SkinName;
  return DEFAULT_SKIN[type];
}

export function groupKey(type: InstancedType, skin: SkinName): GroupKey {
  return `${type}:${skin}`;
}

export function meshKey(type: InstancedType, skin: SkinName, primitive: InstancePrimitive): MeshKey {
  return `${type}:${skin}:${primitive}`;
}

const isInstanced = (t: ObjectType): t is InstancedType => RENDER_CLASS[t] === 'instanced';

/** Compose a collider's local offset with the body pose, giving a world point. */
function worldOf(pose: Pose, local: Vec2, cos: number, sin: number): Vec2 {
  return [pose.pos[0] + local[0] * cos - local[1] * sin, pose.pos[1] + local[0] * sin + local[1] * cos];
}

/**
 * Which primitive a collider draws as, given its type's declared list.
 *
 * The list is in §6 emission order, so a type with two primitives is matched by
 * collider kind; a mismatch means §6 changed under the table and is a bug worth
 * an exception rather than a silently wrong picture.
 */
function primitiveFor(type: InstancedType, collider: ColliderShape): InstancePrimitive {
  const declared = INSTANCE_PRIMITIVES[type] as readonly InstancePrimitive[];
  const match = declared.find((p) => PRIMITIVE_COLLIDER[p] === collider.kind);
  if (match === undefined) {
    throw new Error(
      `render: ${type} expands to a ${collider.kind} collider, which INSTANCE_PRIMITIVES does not declare (09 §4)`,
    );
  }
  return match;
}

function instancesOf(geom: ObjectGeometry, type: InstancedType): Instance[] {
  const out: Instance[] = [];
  for (const piece of geom.pieces) {
    const cos = dcos(piece.pose.rot);
    const sin = dsin(piece.pose.rot);
    for (const collider of piece.colliders) {
      if (collider.kind === 'polygon') continue; // classified `generated`, never instanced
      const primitive = primitiveFor(type, collider);
      const local: Vec2 = collider.offset;
      const offsetRot = collider.kind === 'cuboid' ? collider.rot : 0;
      out.push({
        objId: geom.id,
        piece: piece.piece,
        primitive,
        offset: local,
        offsetRot,
        hx: collider.kind === 'cuboid' ? collider.hx : 0,
        hy: collider.kind === 'cuboid' ? collider.hy : 0,
        r: collider.kind === 'ball' ? collider.r : 0,
        // A body the simulation never moves keeps the pose §6 gave it; a dynamic
        // one is overwritten every frame from the buffer (03 §5.3/§5.5).
        pose:
          piece.kind === 'dynamic'
            ? null
            : { pos: worldOf(piece.pose, local, cos, sin), rot: piece.pose.rot + offsetRot },
        slot: -1,
      });
    }
  }
  return out;
}

function generatedOf(geom: ObjectGeometry, skin: SkinName): GeneratedShape | null {
  const piece = geom.pieces[0];
  if (!piece) return null;
  const cos = Math.cos(piece.pose.rot);
  const sin = Math.sin(piece.pose.rot);
  const outline: Vec2[] = [];
  for (const collider of piece.colliders) {
    if (collider.kind === 'polygon') outline.push(...collider.points.map((p) => worldOf(piece.pose, p, cos, sin)));
    // A curve is tessellated into consecutive boxes; their centres trace the arc,
    // which is exactly the strip the renderer sweeps its thickness along.
    else if (collider.kind === 'cuboid') outline.push(worldOf(piece.pose, collider.offset, cos, sin));
  }
  return { objId: geom.id, type: geom.type, skin, outline, pose: piece.pose };
}

function overlayOf(obj: CanonicalObject, geom: ObjectGeometry, skin: SkinName): OverlayShape | null {
  const props = obj.props as Record<string, number | undefined>;
  const pose: Pose = { pos: obj.pos, rot: obj.rot };
  const base = { objId: obj.id, type: obj.type, skin, pose };
  switch (obj.type) {
    case 'trigger':
    case 'goal': {
      const collider = geom.pieces[0]?.colliders[0];
      if (!collider || collider.kind !== 'cuboid') return null;
      return { ...base, shape: { kind: 'box', hx: collider.hx, hy: collider.hy } };
    }
    case 'pulley':
    case 'magnet':
      return { ...base, shape: { kind: 'radius', r: props['r'] ?? props['range'] ?? 0 } };
    case 'fan': {
      const dir = geom.derived.axis ?? ([1, 0] as Vec2);
      return {
        ...base,
        shape: { kind: 'cone', dir, spreadDeg: props['spread'] ?? 0, range: props['range'] ?? 0 },
      };
    }
    default:
      return null;
  }
}

/**
 * Build the plan for a whole scene.
 *
 * Meshes come out in a stable order — `INSTANCED_TYPES` order, then `SKIN_NAMES`
 * order, then the type's primitive order — so two runs of the same document
 * produce the same buffers in the same slots. That is not a determinism
 * requirement (rendering is outside DET-1) but it is what makes a draw-call
 * count reproducible enough to gate on at P3d.
 */
export function buildRenderPlan(scene: Scene | CanonicalScene): RenderPlan {
  const canonical: CanonicalScene = 'byId' in scene ? scene : canonicalize(scene);
  const byMesh = new Map<MeshKey, InstanceMesh>();
  const generated: GeneratedShape[] = [];
  const overlays: OverlayShape[] = [];

  for (const obj of canonical.objects) {
    const skin = resolveSkin(obj.type, obj.skin);
    const geom = objectGeometry(obj);
    const cls: RenderClass = RENDER_CLASS[obj.type];
    if (cls === 'instanced' && isInstanced(obj.type)) {
      for (const inst of instancesOf(geom, obj.type)) {
        const key = meshKey(obj.type, skin, inst.primitive);
        let mesh = byMesh.get(key);
        if (!mesh) {
          mesh = { key, type: obj.type, skin, primitive: inst.primitive, instances: [] };
          byMesh.set(key, mesh);
        }
        mesh.instances.push(inst);
      }
    } else if (cls === 'generated') {
      const shape = generatedOf(geom, skin);
      if (shape) generated.push(shape);
    } else {
      const overlay = overlayOf(obj, geom, skin);
      if (overlay) overlays.push(overlay);
    }
  }

  const meshes: InstanceMesh[] = [];
  for (const type of INSTANCED_TYPES) {
    for (const skin of SKIN_NAMES) {
      for (const primitive of INSTANCE_PRIMITIVES[type] as readonly InstancePrimitive[]) {
        const mesh = byMesh.get(meshKey(type, skin, primitive));
        if (mesh) meshes.push(mesh);
      }
    }
  }
  return { meshes, generated, overlays, scene: canonical };
}

/** The (type, skin) groups a plan uses — 09 §4's `MAX_INSTANCE_GROUPS` counts these. */
export function groupKeys(plan: RenderPlan): GroupKey[] {
  const seen = new Set<GroupKey>();
  for (const mesh of plan.meshes) seen.add(groupKey(mesh.type, mesh.skin));
  return [...seen];
}

export interface DrawCallCount {
  /** `InstancedMesh` draws, plus the individual draws small groups fall back to. */
  solid: number;
  generated: number;
  overlays: number;
  total: number;
}

/**
 * What this plan costs in draw calls — the number P3d's gate measures.
 *
 * Overlays are counted but a tier may switch them off entirely (`fieldOverlays`,
 * 09 §7), so they are reported separately rather than folded into `solid`.
 */
export function countDrawCalls(plan: RenderPlan): DrawCallCount {
  let solid = 0;
  for (const mesh of plan.meshes) {
    solid += mesh.instances.length < RENDER.INSTANCE_MIN ? mesh.instances.length : 1;
  }
  const generated = plan.generated.length;
  const overlays = plan.overlays.length;
  return { solid, generated, overlays, total: solid + generated + overlays };
}

/**
 * Bind every dynamic instance to its slot in the frame buffer.
 *
 * The worker's `loaded` message carries `registry: BodyRegistryEntry[]`, index =
 * slot (03 §5.3). Matching on `(objId, piece)` rather than assuming the plan and
 * the registry were built in the same order is the point: both walk the scene in
 * DET-3 id order today, and a renderer that silently depends on that would break
 * the first time either side gains a piece.
 *
 * Returns the number of instances left unbound — always 0 for a plan and
 * registry built from the same document, and a caller-visible fault otherwise.
 */
export function bindRegistry(plan: RenderPlan, registry: readonly { objId: Id; piece: BodyPiece }[]): number {
  const slotOf = new Map<string, number>();
  registry.forEach((entry, slot) => slotOf.set(`${entry.objId}/${entry.piece}`, slot));
  let unbound = 0;
  for (const mesh of plan.meshes) {
    for (const inst of mesh.instances) {
      if (inst.pose !== null) continue; // static: never in the registry
      const slot = slotOf.get(`${inst.objId}/${inst.piece}`);
      if (slot === undefined) unbound++;
      else inst.slot = slot;
    }
  }
  return unbound;
}

/** Every instance in the plan, in mesh order — the flat view the frame reader walks. */
export function allInstances(plan: RenderPlan): Instance[] {
  return plan.meshes.flatMap((m) => m.instances);
}

/** Guard for the 09 §4 ceilings; throws rather than drawing a scene it cannot bound. */
export function assertWithinCeilings(plan: RenderPlan): void {
  const groups = groupKeys(plan).length;
  if (groups > MAX_INSTANCE_GROUPS) {
    throw new Error(`render: ${groups} instance groups exceeds MAX_INSTANCE_GROUPS (${MAX_INSTANCE_GROUPS}), 09 §4`);
  }
  if (plan.meshes.length > MAX_INSTANCE_DRAWS) {
    throw new Error(`render: ${plan.meshes.length} instanced meshes exceeds MAX_INSTANCE_DRAWS (${MAX_INSTANCE_DRAWS}), 09 §4`);
  }
}
