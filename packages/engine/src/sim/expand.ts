/**
 * Prefab expansion — 03 §6's catalog-type to Rapier realization.
 *
 * `geometry.ts` (P2a) already answers "what shape, where"; this module answers
 * "which Rapier objects, in what order, wired to what". The split is not
 * cosmetic: the renderer needs the first answer and must never see the second
 * (03 §1 rule 2), and the first is testable exhaustively without a WASM module
 * in the loop, which is how the prefab geometry stays pinned independently of
 * the physics build.
 *
 * Everything here runs once, at load, so `dmath` is available (DET-5). What
 * comes out is deliberately **immutable**: descriptors for the force layer, the
 * constraint layer and the trigger system, with every mutable bit of run state
 * left to `step.ts`, where §11 can serialize all of it in one place. A field's
 * `active` flag living in this file would be a §11 violation that reset and
 * replay would silently disagree about.
 *
 * Contract: docs/03-SIMULATION-CORE.md §6, §9.1; docs/02-SCENE-FORMAT.md §6.3.
 */

import type {
  Collider,
  PrismaticImpulseJoint,
  RevoluteImpulseJoint,
  RigidBody,
  World,
} from '@dimforge/rapier2d-deterministic-compat';
import type { Id, ObjectType, Vec2 } from '@physics/scene-format';
import type { BodyPiece, LoadWarning, SimErrorCode } from '../protocol.js';
import { SIM } from '../protocol.js';
import type { CanonicalLink, CanonicalObject, CanonicalScene } from './canonical.js';
import { datan2, dcos, dsin, length2 } from './dmath.js';
import type { ColliderShape, PieceGeometry } from './geometry.js';
import { EXPAND, objectGeometry, resolveAnchor } from './geometry.js';
import type { Rapier } from './rapier.js';

/** A load that cannot produce a world (§5.3 error codes). */
export class SimLoadError extends Error {
  readonly code: SimErrorCode;
  readonly detail: string | undefined;
  constructor(code: SimErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'SimLoadError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Collision groups (§6). Rapier packs membership in the high 16 bits and the
 * filter mask in the low 16: two colliders interact only if each is a member of
 * something the other filters for.
 *
 * `ROPE` exists so a 64-segment rope does not spend its whole budget solving
 * contacts against itself — a rope whose links collide jitters and costs O(n^2)
 * pairs, and the spec's answer is that segments pass through each other while
 * still colliding with the world.
 */
const GROUP = { DEFAULT: 0x0001, ROPE: 0x0002, SENSOR: 0x0004 } as const;
const COLLISION_GROUPS = {
  /** Physical things: collide with each other and with ropes, enter sensors. */
  default: (GROUP.DEFAULT << 16) | (GROUP.DEFAULT | GROUP.ROPE | GROUP.SENSOR),
  /** Rope segments: the world, but not other rope segments. */
  rope: (GROUP.ROPE << 16) | GROUP.DEFAULT,
  /** Sensors: intersect physical bodies only — never ropes, never each other. */
  sensor: (GROUP.SENSOR << 16) | GROUP.DEFAULT,
} as const;

/** One realized body, in creation order (DET-3). */
export interface BodyRecord {
  objId: Id;
  type: ObjectType;
  piece: BodyPiece;
  /**
   * Index into the render registry / SAB slot table, or -1 for a body with no
   * slot. §5.4: only dynamic bodies get slots, and `anchored: true` realizes a
   * dynamic-bodied type as `fixed` (§6) — so an anchored crate is scenery, and
   * the renderer derives its pose from the document like any other static part.
   */
  slot: number;
  /**
   * Rapier's handle. Stable across `takeSnapshot`/`restoreSnapshot` (measured at
   * P2b), which is what makes §11's reset possible at all: restoring produces a
   * *new* `World`, so every live reference below is stale afterwards and gets
   * re-resolved from this handle by `rebind`.
   */
  handle: number;
  /** Live reference into the current world. Re-bound on restore. */
  body: RigidBody;
  /** Handles of this body's colliders — DET-10's sweep tests them, not the body. */
  colliderHandles: number[];
  /** `props.magnetic` — the only material bit the per-step force layer reads. */
  magnetic: boolean;
}

export interface FanDesc {
  id: Id;
  pos: Vec2;
  /** Unit blow direction (§7.1). */
  axis: Vec2;
  cosHalf: number;
  strength: number;
  range: number;
  /** `props.active` — the *initial* state; the live flag is run state (§11). */
  startsActive: boolean;
}

export interface MagnetDesc {
  id: Id;
  pos: Vec2;
  strength: number;
  range: number;
  startsActive: boolean;
}

export interface ConveyorDesc {
  id: Id;
  colliderHandle: number;
  collider: Collider;
  /** Unit belt tangent (§7.3). */
  tangent: Vec2;
  speed: number;
  startsActive: boolean;
  /**
   * The object's own friction, restored whenever the belt is switched off
   * ("inactive conveyors are plain static boxes", §6). While it runs, the
   * collider's friction is driven to 0 and §7.3's impulse is the only tangential
   * effect at the contact — see `applyConveyors`.
   */
  restFriction: number;
}

/** A motor whose torque cap we enforce ourselves — see `constraints.ts`. */
export interface GearDesc {
  id: Id;
  bodyHandle: number;
  body: RigidBody;
  /** rad/s, from the file; the *live* speed toggles between this and 0 (§9.3). */
  fileSpeed: number;
  maxTorque: number;
}

export interface AxleDesc {
  id: Id;
  aHandle: number;
  bHandle: number;
  a: RigidBody;
  b: RigidBody;
  fileSpeed: number;
  maxTorque: number;
}

export interface PistonDesc {
  id: Id;
  headHandle: number;
  jointHandle: number;
  head: RigidBody;
  joint: PrismaticImpulseJoint;
  /** Unit prismatic axis (§6). */
  axis: Vec2;
  /** World point of the head's centre at displacement 0 — the seated pose. */
  seated: Vec2;
  stroke: number;
  speed: number;
  force: number;
  mode: string;
  period: number;
  phase: number;
}

export interface SpringDesc {
  id: Id;
  jointHandle: number;
  joint: PrismaticImpulseJoint;
  travel: number;
  mode: string;
}

export interface TriggerDesc {
  id: Id;
  colliderHandle: number;
  collider: Collider;
  targets: readonly Id[];
  once: boolean;
}

export interface GoalDesc {
  id: Id;
  colliderHandle: number;
  collider: Collider;
  /** `"any"`, or the object ids whose bodies satisfy it (02 §5.3). */
  accepts: 'any' | readonly Id[];
}

export interface GearMeshDesc {
  id: Id;
  aHandle: number;
  bHandle: number;
  a: RigidBody;
  b: RigidBody;
  /** `ratio`, or `-rA/rB` from the quantized radii (§6). */
  ratio: number;
}

/** A rope routed over pulleys — the §8.2 unilateral constraint. */
export interface PulleyRopeDesc {
  id: Id;
  aHandle: number;
  bHandle: number;
  a: RigidBody;
  /** Attachment point in `a`'s local frame. */
  aLocal: Vec2;
  b: RigidBody;
  bLocal: Vec2;
  /** First and last pulley centres — the ends of the fixed interior run. */
  first: Vec2;
  last: Vec2;
  /** `B = L - sum of interior spans`; the budget the two end spans share. */
  budget: number;
}

export interface ExpandedScene {
  /** Mutable: `rebind` re-points this at the world a restore produced (§11). */
  world: World;
  /** The shared world-attachment body (§6). */
  ground: RigidBody;
  scene: CanonicalScene;
  /** Every realized body, in creation order. */
  bodies: readonly BodyRecord[];
  /** Dynamic bodies only; index = SAB slot / registry index (§5.4). */
  slots: readonly BodyRecord[];
  /** `(objId, piece)` to record — the DET-3 handle table. */
  byKey: ReadonlyMap<string, BodyRecord>;
  /** Collider handle to owning body. Turns an engine event into an object id. */
  colliderOwner: ReadonlyMap<number, BodyRecord>;
  fans: readonly FanDesc[];
  magnets: readonly MagnetDesc[];
  conveyors: readonly ConveyorDesc[];
  gears: readonly GearDesc[];
  axles: readonly AxleDesc[];
  pistons: readonly PistonDesc[];
  springs: readonly SpringDesc[];
  triggers: readonly TriggerDesc[];
  goals: readonly GoalDesc[];
  gearMeshes: readonly GearMeshDesc[];
  pulleyRopes: readonly PulleyRopeDesc[];
  warnings: readonly LoadWarning[];
}

/**
 * Registry key. A space cannot occur in an id (02 §3's pattern is
 * `[A-Za-z0-9_-]`), so this encoding is injective.
 */
export function pieceKey(objId: Id, piece: BodyPiece): string {
  return `${objId} ${piece}`;
}

function num(obj: CanonicalObject, key: string): number {
  const v = (obj.props as Readonly<Record<string, unknown>>)[key];
  if (typeof v !== 'number') throw new TypeError(`expand: ${obj.type} "${obj.id}" prop "${key}" is not resolved`);
  return v;
}

function optNum(obj: CanonicalObject, key: string): number | undefined {
  const v = (obj.props as Readonly<Record<string, unknown>>)[key];
  return typeof v === 'number' ? v : undefined;
}

function bool(obj: CanonicalObject, key: string): boolean {
  return (obj.props as Readonly<Record<string, unknown>>)[key] === true;
}

function str(obj: CanonicalObject, key: string): string {
  const v = (obj.props as Readonly<Record<string, unknown>>)[key];
  return typeof v === 'string' ? v : '';
}

function linkNum(link: CanonicalLink, key: string): number | undefined {
  const v = (link.props as Readonly<Record<string, unknown>>)[key];
  return typeof v === 'number' ? v : undefined;
}

/** World point into a body's local frame. Load-time only, so `dmath` is fair game. */
export function worldToLocal(body: RigidBody, p: Vec2): Vec2 {
  const t = body.translation();
  const r = body.rotation();
  const c = dcos(r);
  const s = dsin(r);
  const dx = p[0] - t.x;
  const dy = p[1] - t.y;
  return [dx * c + dy * s, -dx * s + dy * c];
}

/**
 * How many dynamic bodies this scene expands to.
 *
 * Counted before anything is built, so a scene over `MAX_DYNAMIC_BODIES` fails
 * with `E_LIMITS` instead of allocating its way there first — 8 000 bodies is
 * exactly the size at which "build it, then check" is the wrong order.
 */
function countDynamicBodies(scene: CanonicalScene): number {
  let n = 0;
  for (const obj of scene.objects) {
    if (obj.material.anchored) continue;
    for (const piece of objectGeometry(obj).pieces) if (piece.kind === 'dynamic') n++;
  }
  for (const link of scene.links) {
    if (link.type !== 'rope') continue;
    const via = (link.props as { via?: readonly Id[] }).via ?? [];
    const segments = linkNum(link, 'segments') ?? 0;
    if (via.length === 0 && segments >= 2) n += segments;
  }
  return n;
}

interface Builder {
  rapier: Rapier;
  world: World;
  ground: RigidBody;
  bodies: BodyRecord[];
  slots: BodyRecord[];
  byKey: Map<string, BodyRecord>;
  colliderOwner: Map<number, BodyRecord>;
  warnings: LoadWarning[];
}

function addCollider(
  b: Builder,
  record: BodyRecord,
  shape: ColliderShape,
  opts: { friction: number; restitution: number; density?: number; sensor: boolean; groups: number },
): Collider {
  const { rapier } = b;
  let desc;
  switch (shape.kind) {
    case 'cuboid':
      desc = rapier.ColliderDesc.cuboid(shape.hx, shape.hy)
        .setTranslation(shape.offset[0], shape.offset[1])
        .setRotation(shape.rot);
      break;
    case 'ball':
      desc = rapier.ColliderDesc.ball(shape.r).setTranslation(shape.offset[0], shape.offset[1]);
      break;
    case 'polygon': {
      const flat = new Float32Array(shape.points.length * 2);
      for (let i = 0; i < shape.points.length; i++) {
        const p = shape.points[i] as Vec2;
        flat[i * 2] = p[0];
        flat[i * 2 + 1] = p[1];
      }
      const hull = rapier.ColliderDesc.convexHull(flat);
      if (hull === null) {
        throw new SimLoadError(
          'E_INTERNAL',
          `expand: "${record.objId}" produced a degenerate polygon collider`,
          `${shape.points.length} points`,
        );
      }
      desc = hull;
      break;
    }
  }
  desc = desc
    .setFriction(opts.friction)
    .setRestitution(opts.restitution)
    // How two touching surfaces combine into one coefficient (03 §6). Rapier's
    // default is Average for both, which makes every catalog coefficient mean
    // half of what it says: a restitution-0.3 marble would bounce at 0.15 off a
    // restitution-0 platform, and a friction-0 "ice" platform would still drag
    // at 0.25 under a normal crate — so neither prop would be usable as the
    // design tool the catalog presents it as.
    .setFrictionCombineRule(rapier.CoefficientCombineRule.Min)
    .setRestitutionCombineRule(rapier.CoefficientCombineRule.Max);
  if (opts.density !== undefined) desc = desc.setDensity(opts.density);
  if (opts.sensor) desc = desc.setSensor(true);
  desc = desc.setCollisionGroups(opts.groups).setActiveEvents(rapier.ActiveEvents.COLLISION_EVENTS);
  const collider = b.world.createCollider(desc, record.body);
  b.colliderOwner.set(collider.handle, record);
  record.colliderHandles.push(collider.handle);
  return collider;
}

function createPiece(
  b: Builder,
  obj: CanonicalObject,
  piece: PieceGeometry,
): { record: BodyRecord; colliders: Collider[] } {
  const { rapier } = b;
  // `anchored` demotes a dynamic prefab body to fixed (§6) — its joints are
  // still built, so an anchored lever becomes a fixed fulcrum rather than a
  // lever that has quietly lost its pivot.
  const fixed = piece.kind !== 'dynamic' || obj.material.anchored;
  const desc = (fixed ? rapier.RigidBodyDesc.fixed() : rapier.RigidBodyDesc.dynamic())
    .setTranslation(piece.pose.pos[0], piece.pose.pos[1])
    .setRotation(piece.pose.rot);
  if (!fixed) {
    desc.setLinvel(obj.motion.vel[0], obj.motion.vel[1]).setAngvel(obj.motion.angVel);
    if (piece.ccd === true) desc.setCcdEnabled(true);
  }
  const body = b.world.createRigidBody(desc);
  const record: BodyRecord = {
    objId: obj.id,
    type: obj.type,
    piece: piece.piece,
    slot: fixed ? -1 : b.slots.length,
    handle: body.handle,
    body,
    colliderHandles: [],
    magnetic: obj.material.magnetic,
  };
  if (!fixed) b.slots.push(record);
  b.bodies.push(record);
  b.byKey.set(pieceKey(obj.id, piece.piece), record);

  const density = piece.densityOverride ?? obj.material.density;
  const colliders = piece.colliders.map((shape) =>
    addCollider(b, record, shape, {
      friction: obj.material.friction,
      restitution: obj.material.restitution,
      ...(fixed || density === undefined ? {} : { density }),
      sensor: piece.kind === 'sensor',
      groups: piece.kind === 'sensor' ? COLLISION_GROUPS.sensor : COLLISION_GROUPS.default,
    }),
  );
  return { record, colliders };
}

/**
 * The body a link endpoint attaches to, and the attachment point in its frame.
 *
 * §6: an anchor on a *static* object (or a field, which has no body at all)
 * attaches to the shared `ground` body at the anchor's world point. Resolving
 * that here means the joint builders below never branch on staticness — a rope
 * to a platform and a rope to a crate are built by the same three lines.
 */
function attachment(
  b: Builder,
  scene: CanonicalScene,
  objId: Id,
  ep: { anchor?: string; at?: Vec2 },
): { body: RigidBody; local: Vec2; world: Vec2 } {
  const obj = scene.byId.get(objId);
  if (obj === undefined) throw new SimLoadError('E_INTERNAL', `expand: link endpoint names unknown object "${objId}"`);
  const resolved = resolveAnchor(obj, ep);
  const record = resolved.piece === null ? undefined : b.byKey.get(pieceKey(objId, resolved.piece));
  const body = record !== undefined && record.body.isDynamic() ? record.body : b.ground;
  return { body, local: worldToLocal(body, resolved.world), world: resolved.world };
}

function warn(b: Builder, code: LoadWarning['code'], id: Id, message: string): void {
  b.warnings.push({ code, id, message });
}

// ---------------------------------------------------------------------------
// The expansion
// ---------------------------------------------------------------------------

/**
 * Build the Rapier world for a canonical scene (§6).
 *
 * Order is normative (DET-3): the ground body, then objects by id with each
 * prefab's pieces in the §6 table's row order, then links by id. Handles are
 * whatever Rapier hands back — in this binding they are opaque doubles, not
 * indices — so nothing downstream may order by them; that is what `slot` and
 * the id-sorted descriptor arrays are for.
 */
export function expand(rapier: Rapier, scene: CanonicalScene): ExpandedScene {
  const dynamicCount = countDynamicBodies(scene);
  if (dynamicCount > SIM.MAX_DYNAMIC_BODIES) {
    throw new SimLoadError(
      'E_LIMITS',
      `scene expands to ${dynamicCount} dynamic bodies, over the engine limit of ${SIM.MAX_DYNAMIC_BODIES}`,
      `MAX_DYNAMIC_BODIES=${SIM.MAX_DYNAMIC_BODIES}`,
    );
  }

  const world = new rapier.World({ x: scene.world.gravityVec[0], y: scene.world.gravityVec[1] });
  // DET-1: one fixed step, set once. Rapier stores it as f32; the cast is exact
  // rounding, so every platform gets the same f32 (DET-2).
  world.timestep = SIM.DT;

  const ground = world.createRigidBody(rapier.RigidBodyDesc.fixed());
  const b: Builder = {
    rapier,
    world,
    ground,
    bodies: [],
    slots: [],
    byKey: new Map(),
    colliderOwner: new Map(),
    warnings: [],
  };

  const fans: FanDesc[] = [];
  const magnets: MagnetDesc[] = [];
  const conveyors: ConveyorDesc[] = [];
  const gears: GearDesc[] = [];
  const axles: AxleDesc[] = [];
  const pistons: PistonDesc[] = [];
  const springs: SpringDesc[] = [];
  const triggers: TriggerDesc[] = [];
  const goals: GoalDesc[] = [];
  const gearMeshes: GearMeshDesc[] = [];
  const pulleyRopes: PulleyRopeDesc[] = [];

  for (const obj of scene.objects) {
    const geom = objectGeometry(obj);
    const created = geom.pieces.map((piece) => createPiece(b, obj, piece));
    const main = created[0];

    switch (obj.type) {
      case 'gear': {
        if (main === undefined) break;
        world.createImpulseJoint(
          rapier.JointData.revolute({ x: obj.pos[0], y: obj.pos[1] }, { x: 0, y: 0 }),
          ground,
          main.record.body,
          true,
        );
        gears.push({
          id: obj.id,
          bodyHandle: main.record.handle,
          body: main.record.body,
          fileSpeed: num(obj, 'motorSpeed'),
          maxTorque: num(obj, 'maxTorque'),
        });
        break;
      }

      case 'lever': {
        if (main === undefined) break;
        const pivotLocal = worldToLocal(main.record.body, obj.pos);
        const joint = world.createImpulseJoint(
          rapier.JointData.revolute({ x: obj.pos[0], y: obj.pos[1] }, { x: pivotLocal[0], y: pivotLocal[1] }),
          ground,
          main.record.body,
          true,
        ) as RevoluteImpulseJoint;
        const minAngle = optNum(obj, 'minAngle');
        const maxAngle = optNum(obj, 'maxAngle');
        if (minAngle !== undefined && maxAngle !== undefined) {
          // Absolute angles, not offsets from the initial pose: `ground` sits at
          // rotation 0, so this joint's angle *is* the arm's world angle — the
          // coordinate 02 §5.3 states `rot` in, which is what makes the warning
          // below a comparison of like with like. 03 §6 originally said
          // `[minAngle - rot, maxAngle - rot]`; measured wrong at P2b (03 §15).
          joint.setLimits(minAngle, maxAngle);
          if (obj.rot < minAngle || obj.rot > maxAngle) {
            warn(
              b,
              'W_LEVER_ROT_OUTSIDE_LIMITS',
              obj.id,
              `lever starts at ${obj.rot} rad, outside its limits [${minAngle}, ${maxAngle}]`,
            );
          }
        }
        break;
      }

      case 'spring': {
        const base = created[0];
        const plate = created[1];
        if (base === undefined || plate === undefined) break;
        const seated = (EXPAND.SPRING_BASE_H + EXPAND.SPRING_PLATE_H) / 2;
        const axis = geom.derived.axis ?? [0, 1];
        const travel = num(obj, 'travel');
        const joint = world.createImpulseJoint(
          rapier.JointData.prismatic({ x: 0, y: seated }, { x: 0, y: 0 }, { x: axis[0], y: axis[1] }),
          base.record.body,
          plate.record.body,
          true,
        ) as PrismaticImpulseJoint;
        const mode = str(obj, 'mode');
        // A latched `triggered` spring is held by locking the limits to a point,
        // the only lock this binding offers; §9.3's activation reopens them to
        // [0, travel] and the motor — already configured — fires it.
        joint.setLimits(0, mode === 'triggered' ? 0 : travel);
        // ForceBased, so `stiffness` means newtons per metre. Rapier's default
        // motor model is acceleration-based, where the same number is divided by
        // the plate's mass — measured at P2b: a 25 N/m spring with a 7.5 g plate
        // came out ~3 000x too stiff and never left the seated pose (03 §15).
        joint.configureMotorModel(rapier.MotorModel.ForceBased);
        joint.configureMotorPosition(travel, num(obj, 'stiffness'), num(obj, 'damping'));
        springs.push({ id: obj.id, jointHandle: joint.handle, joint, travel, mode });
        break;
      }

      case 'pendulum': {
        if (main === undefined) break;
        const anchor = { x: obj.pos[0], y: obj.pos[1] };
        if (str(obj, 'arm') === 'rope') {
          world.createImpulseJoint(
            rapier.JointData.rope(num(obj, 'len'), anchor, { x: 0, y: 0 }),
            ground,
            main.record.body,
            true,
          );
        } else {
          world.createImpulseJoint(rapier.JointData.revolute(anchor, { x: 0, y: 0 }), ground, main.record.body, true);
        }
        break;
      }

      case 'piston': {
        const base = created[0];
        const head = created[1];
        if (base === undefined || head === undefined) break;
        const seatedOffset = (EXPAND.PISTON_BASE_H + EXPAND.PISTON_HEAD_H) / 2;
        const axis = geom.derived.axis ?? [0, 1];
        const joint = world.createImpulseJoint(
          rapier.JointData.prismatic({ x: 0, y: seatedOffset }, { x: 0, y: 0 }, { x: axis[0], y: axis[1] }),
          base.record.body,
          head.record.body,
          true,
        ) as PrismaticImpulseJoint;
        joint.setLimits(0, num(obj, 'stroke'));
        const t = head.record.body.translation();
        pistons.push({
          id: obj.id,
          headHandle: head.record.handle,
          jointHandle: joint.handle,
          head: head.record.body,
          joint,
          axis,
          seated: [t.x, t.y],
          stroke: num(obj, 'stroke'),
          speed: num(obj, 'speed'),
          force: num(obj, 'force'),
          mode: str(obj, 'mode'),
          period: num(obj, 'period'),
          phase: num(obj, 'phase'),
        });
        break;
      }

      case 'conveyor': {
        const collider = main?.colliders[0];
        if (collider === undefined) break;
        conveyors.push({
          id: obj.id,
          colliderHandle: collider.handle,
          collider,
          tangent: geom.derived.axis ?? [1, 0],
          speed: num(obj, 'speed'),
          startsActive: bool(obj, 'active'),
          restFriction: obj.material.friction,
        });
        break;
      }

      case 'fan':
        fans.push({
          id: obj.id,
          pos: obj.pos,
          axis: geom.derived.axis ?? [1, 0],
          cosHalf: geom.derived.cosHalf ?? 1,
          strength: num(obj, 'strength'),
          range: num(obj, 'range'),
          startsActive: bool(obj, 'active'),
        });
        break;

      case 'magnet':
        magnets.push({
          id: obj.id,
          pos: obj.pos,
          strength: num(obj, 'strength'),
          range: num(obj, 'range'),
          startsActive: bool(obj, 'active'),
        });
        break;

      case 'trigger': {
        const collider = main?.colliders[0];
        if (collider === undefined) break;
        triggers.push({
          id: obj.id,
          colliderHandle: collider.handle,
          collider,
          targets: (obj.props as { targets?: readonly Id[] }).targets ?? [],
          once: bool(obj, 'once'),
        });
        break;
      }

      case 'goal': {
        const collider = main?.colliders[0];
        if (collider === undefined) break;
        goals.push({
          id: obj.id,
          colliderHandle: collider.handle,
          collider,
          accepts: (obj.props as { accepts?: 'any' | readonly Id[] }).accepts ?? 'any',
        });
        break;
      }

      default:
        break;
    }
  }

  for (const link of scene.links) {
    switch (link.type) {
      case 'rope':
        expandRope(b, rapier, scene, link, pulleyRopes);
        break;

      case 'springLink': {
        const a = attachment(b, scene, link.a.obj, link.a);
        const c = attachment(b, scene, link.b.obj, link.b);
        const rest = linkNum(link, 'restLength') ?? length2(c.world[0] - a.world[0], c.world[1] - a.world[1]);
        world.createImpulseJoint(
          rapier.JointData.spring(
            rest,
            linkNum(link, 'stiffness') ?? 50,
            linkNum(link, 'damping') ?? 0.5,
            { x: a.local[0], y: a.local[1] },
            { x: c.local[0], y: c.local[1] },
          ),
          a.body,
          c.body,
          true,
        );
        break;
      }

      case 'weld': {
        const a = attachment(b, scene, link.a.obj, link.a);
        const c = attachment(b, scene, link.b.obj, link.b);
        // Rest pose = the pose the two bodies are already in, so a weld never
        // snaps anything on the first step: frame2 carries the current relative
        // rotation and frame1 is the identity.
        const relative = a.body.rotation() - c.body.rotation();
        world.createImpulseJoint(
          rapier.JointData.fixed({ x: a.local[0], y: a.local[1] }, 0, { x: c.local[0], y: c.local[1] }, relative),
          a.body,
          c.body,
          true,
        );
        break;
      }

      case 'axle': {
        const a = attachment(b, scene, link.a.obj, link.a);
        const c = attachment(b, scene, link.b.obj, link.b);
        const gap = length2(c.world[0] - a.world[0], c.world[1] - a.world[1]);
        if (gap > 0.05) {
          warn(
            b,
            'W_AXLE_ANCHOR_MISMATCH',
            link.id,
            `axle endpoints resolve ${gap} m apart; the joint uses endpoint a's point`,
          );
        }
        // Both local anchors derive from a's world point P (§6), so a slightly
        // mismatched b is not yanked into place on the first step.
        const bLocal = worldToLocal(c.body, a.world);
        world.createImpulseJoint(
          rapier.JointData.revolute({ x: a.local[0], y: a.local[1] }, { x: bLocal[0], y: bLocal[1] }),
          a.body,
          c.body,
          true,
        );
        const speed = linkNum(link, 'motorSpeed') ?? 0;
        if (speed !== 0) {
          axles.push({
            id: link.id,
            aHandle: a.body.handle,
            bHandle: c.body.handle,
            a: a.body,
            b: c.body,
            fileSpeed: speed,
            maxTorque: linkNum(link, 'maxTorque') ?? 0.5,
          });
        }
        break;
      }

      case 'gearMesh': {
        const objA = scene.byId.get(link.a.obj);
        const objB = scene.byId.get(link.b.obj);
        const recA = b.byKey.get(pieceKey(link.a.obj, 'main'));
        const recB = b.byKey.get(pieceKey(link.b.obj, 'main'));
        if (objA === undefined || objB === undefined || recA === undefined || recB === undefined) break;
        const ratio = linkNum(link, 'ratio') ?? -num(objA, 'r') / num(objB, 'r');
        gearMeshes.push({
          id: link.id,
          aHandle: recA.handle,
          bHandle: recB.handle,
          a: recA.body,
          b: recB.body,
          ratio,
        });
        break;
      }
    }
  }

  return {
    world,
    ground,
    scene,
    bodies: b.bodies,
    slots: b.slots,
    byKey: b.byKey,
    colliderOwner: b.colliderOwner,
    fans,
    magnets,
    conveyors,
    gears,
    axles,
    pistons,
    springs,
    triggers,
    goals,
    gearMeshes,
    pulleyRopes,
    warnings: b.warnings,
  };
}

/**
 * The three rope realizations (§6 links table): native max-distance joint,
 * segmented chain, or the §8.2 pulley constraint. `via` wins over `segments`.
 */
function expandRope(
  b: Builder,
  rapier: Rapier,
  scene: CanonicalScene,
  link: CanonicalLink,
  out: PulleyRopeDesc[],
): void {
  const a = attachment(b, scene, link.a.obj, link.a);
  const c = attachment(b, scene, link.b.obj, link.b);
  const via = (link.props as { via?: readonly Id[] }).via ?? [];
  const segments = linkNum(link, 'segments') ?? 0;

  if (via.length > 0) {
    if (segments >= 2) {
      warn(
        b,
        'W_ROPE_VIA_SEGMENTS_CONFLICT',
        link.id,
        `rope has both "via" and segments=${segments}; via wins (02 §6.2)`,
      );
    }
    const wheels: Vec2[] = [];
    for (const id of via) {
      const p = scene.byId.get(id);
      if (p !== undefined) wheels.push(p.pos);
    }
    const first = wheels[0];
    const last = wheels[wheels.length - 1];
    if (first === undefined || last === undefined) return;
    let interior = 0;
    for (let i = 1; i < wheels.length; i++) {
      const p = wheels[i - 1] as Vec2;
      const q = wheels[i] as Vec2;
      interior += length2(q[0] - p[0], q[1] - p[1]);
    }
    const spanA = length2(a.world[0] - first[0], a.world[1] - first[1]);
    const spanB = length2(c.world[0] - last[0], c.world[1] - last[1]);
    const total = linkNum(link, 'length') ?? spanA + interior + spanB;
    const budget = total - interior;
    // `ROPE_SLOP` of tolerance, not an exact comparison: when `length` is absent
    // the budget is *derived* from these same two spans, so `spanA + spanB` and
    // `budget` are equal up to the rounding of one subtraction — and a strict
    // `>` warned on every correctly-authored pulley rope in the corpus.
    if (budget <= 0 || spanA + spanB > budget + SIM.ROPE_SLOP) {
      warn(
        b,
        'W_ROPE_STARTS_VIOLATED',
        link.id,
        `rope end spans (${spanA + spanB} m) exceed their budget (${budget} m); the bias term pulls it in`,
      );
    }
    out.push({
      id: link.id,
      aHandle: a.body.handle,
      bHandle: c.body.handle,
      a: a.body,
      aLocal: a.local,
      b: c.body,
      bLocal: c.local,
      first,
      last,
      budget,
    });
    return;
  }

  if (segments >= 2) {
    expandSegmentedRope(b, rapier, link, a, c, segments);
    return;
  }

  const length = linkNum(link, 'length') ?? length2(c.world[0] - a.world[0], c.world[1] - a.world[1]);
  b.world.createImpulseJoint(
    rapier.JointData.rope(length, { x: a.local[0], y: a.local[1] }, { x: c.local[0], y: c.local[1] }),
    a.body,
    c.body,
    true,
  );
}

/**
 * A chain of capsule segments between the two anchors (§6). The segments are
 * laid along the straight line between the endpoints — a rope authored slack has
 * shorter segments than the gap and falls into its catenary in the first few
 * steps, rather than being posed into one at load, which would be a second
 * geometry rule to keep bit-identical across platforms.
 */
function expandSegmentedRope(
  b: Builder,
  rapier: Rapier,
  link: CanonicalLink,
  a: { body: RigidBody; local: Vec2; world: Vec2 },
  c: { body: RigidBody; local: Vec2; world: Vec2 },
  segments: number,
): void {
  const dx = c.world[0] - a.world[0];
  const dy = c.world[1] - a.world[1];
  const gap = length2(dx, dy);
  const total = linkNum(link, 'length') ?? gap;
  const segLen = total / segments;
  // Direction along the endpoint line; a degenerate (zero-gap) rope is laid out
  // downward so its segments still have distinct poses to solve from.
  const ux = gap > 1e-9 ? dx / gap : 0;
  const uy = gap > 1e-9 ? dy / gap : -1;
  const half = segLen / 2;
  // Rapier's 2D capsule runs along its body's local Y, so each segment is turned
  // to put local +Y along the endpoint direction. That makes the poses below
  // agree with the joint anchors at (0, +/-half): the chain is seated at load
  // instead of being snapped straight in the first few steps, which would put a
  // load-order artefact into every golden hash a rope appears in.
  const segRot = datan2(uy, ux) - Math.PI / 2;

  const records: BodyRecord[] = [];
  for (let i = 0; i < segments; i++) {
    const cx = a.world[0] + ux * (segLen * i + half);
    const cy = a.world[1] + uy * (segLen * i + half);
    const body = b.world.createRigidBody(rapier.RigidBodyDesc.dynamic().setTranslation(cx, cy).setRotation(segRot));
    const record: BodyRecord = {
      objId: link.id,
      handle: body.handle,
      colliderHandles: [],
      magnetic: false,
      // Segments belong to a link, not to a catalog object; `plank` is the
      // nearest structural stand-in and keeps `type` total over `ObjectType`.
      // Nothing reads it for a segment — the activatable set (§10) is built from
      // scene objects, and a rope is not one.
      type: 'plank',
      piece: `seg${i}`,
      slot: b.slots.length,
      body,
    };
    b.slots.push(record);
    b.bodies.push(record);
    b.byKey.set(pieceKey(link.id, record.piece), record);
    const collider = b.world.createCollider(
      rapier.ColliderDesc.capsule(half, EXPAND.ROPE_SEGMENT_RADIUS)
        .setDensity(EXPAND.ROPE_SEGMENT_DENSITY)
        .setCollisionGroups(COLLISION_GROUPS.rope)
        .setActiveEvents(rapier.ActiveEvents.COLLISION_EVENTS),
      body,
    );
    b.colliderOwner.set(collider.handle, record);
    record.colliderHandles.push(collider.handle);
    records.push(record);
  }

  const firstSeg = records[0];
  const lastSeg = records[records.length - 1];
  if (firstSeg === undefined || lastSeg === undefined) return;
  // Local -Y is the end nearer endpoint a, local +Y the end nearer b.
  b.world.createImpulseJoint(
    rapier.JointData.revolute({ x: a.local[0], y: a.local[1] }, { x: 0, y: -half }),
    a.body,
    firstSeg.body,
    true,
  );
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1] as BodyRecord;
    const cur = records[i] as BodyRecord;
    b.world.createImpulseJoint(
      rapier.JointData.revolute({ x: 0, y: half }, { x: 0, y: -half }),
      prev.body,
      cur.body,
      true,
    );
  }
  b.world.createImpulseJoint(
    rapier.JointData.revolute({ x: 0, y: half }, { x: c.local[0], y: c.local[1] }),
    lastSeg.body,
    c.body,
    true,
  );
}

/**
 * Re-point every live Rapier reference at a freshly restored world (§11).
 *
 * `World.restoreSnapshot` does not restore *into* a world — it returns a new
 * one — so after a reset every `RigidBody`, `Collider` and joint object held
 * above belongs to a world that no longer exists. Handles survive the round
 * trip (they encode arena slot + generation, and the snapshot preserves the
 * arena), so re-resolving each one is enough, and it is enough *exactly* because
 * the descriptor tables themselves — ids, ratios, budgets, local anchors — are
 * pure functions of the document and therefore unchanged by any of this.
 *
 * A handle that no longer resolves belongs to a body removed by DET-10 before
 * the snapshot was taken; that is a valid state, and the record keeps its stale
 * reference while `isRemoved` reports it gone.
 */
export function rebind(ex: ExpandedScene, world: World): void {
  ex.world = world;
  const body = (handle: number, current: RigidBody): RigidBody => world.getRigidBody(handle) ?? current;
  const collider = (handle: number, current: Collider): Collider => world.getCollider(handle) ?? current;

  for (const record of ex.bodies) record.body = body(record.handle, record.body);
  for (const d of ex.conveyors) d.collider = collider(d.colliderHandle, d.collider);
  for (const d of ex.triggers) d.collider = collider(d.colliderHandle, d.collider);
  for (const d of ex.goals) d.collider = collider(d.colliderHandle, d.collider);
  for (const d of ex.gears) d.body = body(d.bodyHandle, d.body);
  for (const d of ex.axles) {
    d.a = body(d.aHandle, d.a);
    d.b = body(d.bHandle, d.b);
  }
  for (const d of ex.gearMeshes) {
    d.a = body(d.aHandle, d.a);
    d.b = body(d.bHandle, d.b);
  }
  for (const d of ex.pulleyRopes) {
    d.a = body(d.aHandle, d.a);
    d.b = body(d.bHandle, d.b);
  }
  for (const d of ex.pistons) {
    d.head = body(d.headHandle, d.head);
    d.joint = (world.getImpulseJoint(d.jointHandle) ?? d.joint) as PrismaticImpulseJoint;
  }
  for (const d of ex.springs) {
    d.joint = (world.getImpulseJoint(d.jointHandle) ?? d.joint) as PrismaticImpulseJoint;
  }
  // The ground body is created first and never removed, so slot 0 of the arena
  // is always it; going through the same accessor keeps that assumption in one
  // place rather than spread across the joint builders.
  ex.ground = world.getRigidBody(ex.ground.handle) ?? ex.ground;
}

/** Has DET-10 removed this body? A removed handle stops resolving (§9, §5.4). */
export function isRemoved(ex: ExpandedScene, record: BodyRecord): boolean {
  return ex.world.getRigidBody(record.handle) === null;
}
