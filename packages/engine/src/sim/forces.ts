/**
 * Field and surface forces — 03 §7.
 *
 * These run every step, which puts them under DET-5's hard rule: only the
 * exactly-specified float operations (`+ - * / sqrt`, comparisons) may appear
 * here. Every angle this layer needs was already turned into a unit vector at
 * load by `geometry.ts` — a fan's axis, a conveyor's tangent — so nothing below
 * has a transcendental left to call, which is the whole point of precomputing
 * them rather than storing angles.
 *
 * Ordering is DET-7: emitters in id order (the descriptor arrays come out of
 * expansion already sorted, because objects are), targets by registry index.
 *
 * Contract: docs/03-SIMULATION-CORE.md §4 phases P2-P3, §7.
 */

import type { Vec2 } from '@physics/scene-format';
import { SIM } from '../protocol.js';
import type { BodyRecord, ConveyorDesc, ExpandedScene, FanDesc, MagnetDesc } from './expand.js';
import { isRemoved } from './expand.js';

/**
 * The wake rule shared by both fields (§7): a field applies to awake bodies, and
 * wakes a sleeping one only when the force it would feel is a plausible fraction
 * of its own weight. Without it a wide cone keeps a whole board awake — and an
 * always-awake board never reaches the `quiescent` finish condition (§9.2), so
 * this threshold is load-bearing for run *termination*, not only for CPU.
 */
function wakeThreshold(mass: number, gravity: number): number {
  return SIM.FIELD_WAKE_FACTOR * mass * (gravity > 0.7 ? gravity : 0.7);
}

/** Should this body feel a field of magnitude `force` this step? */
function shouldApply(record: BodyRecord, force: number, gravity: number): boolean {
  if (!record.body.isSleeping()) return true;
  if (force < wakeThreshold(record.body.mass(), gravity)) return false;
  record.body.wakeUp();
  return true;
}

/** §7.1 — a cone of moving air: linear falloff, force along the fan's axis. */
function applyFan(ex: ExpandedScene, fan: FanDesc, gravity: number): void {
  if (fan.range <= 0) return;
  for (const record of ex.slots) {
    if (isRemoved(ex, record)) continue;
    const com = record.body.worldCom();
    const rx = com.x - fan.pos[0];
    const ry = com.y - fan.pos[1];
    const dist = Math.sqrt(rx * rx + ry * ry);
    if (dist > fan.range) continue;
    // The cone test without a normalize: `dot(r, d) >= cosHalf * |r|` is the
    // same predicate as `cos(angle) >= cosHalf` but costs no division, and a
    // body sitting on the fan (|r| ~ 0) has no direction to test, so it counts
    // as inside rather than as a zero-vector edge case.
    if (dist >= 1e-4 && rx * fan.axis[0] + ry * fan.axis[1] < fan.cosHalf * dist) continue;
    const magnitude = fan.strength * (1 - dist / fan.range);
    const force = magnitude < 0 ? -magnitude : magnitude;
    if (!shouldApply(record, force, gravity)) continue;
    record.body.addForce({ x: magnitude * fan.axis[0], y: magnitude * fan.axis[1] }, false);
  }
}

/**
 * §7.2 — inverse-square attraction on `magnetic` bodies, clamped inside the 5 cm
 * reference distance. The clamp is what makes `strength` a number an author can
 * reason about: it is the force in newtons at 5 cm, not an unbounded constant
 * that would be ~1 200 N at contact.
 */
function applyMagnet(ex: ExpandedScene, magnet: MagnetDesc, gravity: number): void {
  for (const record of ex.slots) {
    if (!record.magnetic) continue;
    if (isRemoved(ex, record)) continue;
    const com = record.body.worldCom();
    const rx = magnet.pos[0] - com.x;
    const ry = magnet.pos[1] - com.y;
    const dist = Math.sqrt(rx * rx + ry * ry);
    if (dist > magnet.range || dist < 1e-9) continue;
    const clamped = dist < SIM.MAGNET_REF_DIST ? SIM.MAGNET_REF_DIST : dist;
    const falloff = SIM.MAGNET_REF_DIST / clamped;
    const magnitude = magnet.strength * falloff * falloff;
    const force = magnitude < 0 ? -magnitude : magnitude;
    if (!shouldApply(record, force, gravity)) continue;
    record.body.addForce({ x: (magnitude * rx) / dist, y: (magnitude * ry) / dist }, false);
  }
}

/**
 * §7.2's field test for the analytics attribution rule 3 — "an active fan or
 * magnet whose region contained O's body at step k" (§10). Shared with the
 * force loops above so a body can never be pushed by a field that the chain
 * accounting does not credit.
 */
export function fanContains(fan: FanDesc, com: Vec2): boolean {
  const rx = com[0] - fan.pos[0];
  const ry = com[1] - fan.pos[1];
  const dist = Math.sqrt(rx * rx + ry * ry);
  if (dist > fan.range) return false;
  return dist < 1e-4 || rx * fan.axis[0] + ry * fan.axis[1] >= fan.cosHalf * dist;
}

export function magnetContains(magnet: MagnetDesc, com: Vec2): boolean {
  const rx = magnet.pos[0] - com[0];
  const ry = magnet.pos[1] - com[1];
  return Math.sqrt(rx * rx + ry * ry) <= magnet.range;
}

/**
 * Phase P2 — reset accumulated forces, then all fans, then all magnets.
 *
 * The reset is separate from the application because Rapier accumulates
 * `addForce` across steps until cleared: skipping it would make a fan that
 * switched off keep blowing forever, which is the sort of bug that only shows
 * up 400 steps into a golden run.
 */
export function applyFields(ex: ExpandedScene, activeFans: ReadonlySet<string>, activeMagnets: ReadonlySet<string>): void {
  for (const record of ex.slots) {
    if (isRemoved(ex, record)) continue;
    record.body.resetForces(false);
  }
  const gravity = ex.scene.world.gravity;
  for (const fan of ex.fans) if (activeFans.has(fan.id)) applyFan(ex, fan, gravity);
  for (const magnet of ex.magnets) if (activeMagnets.has(magnet.id)) applyMagnet(ex, magnet, gravity);
}

/**
 * Phase P3 — conveyor surface impulses (§7.3).
 *
 * A belt is not a force field: it drags what is *touching* it, at the contact
 * points, with a grip limit. Doing it at the contact points rather than at the
 * centre of mass is what makes a marble roll and a crate slide — applying the
 * same impulse at the COM would slide both.
 */
export function applyConveyors(ex: ExpandedScene, activeConveyors: ReadonlySet<string>): void {
  for (const conveyor of ex.conveyors) {
    const active = activeConveyors.has(conveyor.id);
    // A running belt's contact friction is handed over to §7.3 entirely.
    //
    // Rapier's contact solver drives the relative tangential velocity to *zero*,
    // because it has no idea the surface is moving — and rapier.js 0.19.3
    // exposes no way to tell it: `solverContactTangentVelocity` is a getter, and
    // `ActiveHooks` carries only the two pair filters, not contact modification.
    // So with Coulomb friction left on, the belt impulse and the solver's
    // friction cancel: measured at P2b, a default crate travelled 4 cm in five
    // seconds on a 0.3 m/s belt, the two effects within 1 % of a dead heat.
    //
    // Zeroing works because friction combines by Min (03 §6): the belt's 0 wins
    // outright, so the crate cannot contribute its own coefficient back.
    // In 2D the contact tangent *is* the belt tangent, so nothing is lost —
    // §7.3's impulse then supplies the whole tangential behaviour,
    // accelerating toward belt speed and decelerating past it, bounded by the
    // same grip limit. Derived from the active set every step rather than stored,
    // so it cannot drift out of sync with a restored snapshot (03 §15).
    conveyor.collider.setFriction(active ? 0 : conveyor.restFriction);
    if (!active) continue;
    applyConveyor(ex, conveyor);
  }
}

interface ContactTarget {
  record: BodyRecord;
  colliderHandle: number;
}

function applyConveyor(ex: ExpandedScene, conveyor: ConveyorDesc): void {
  // DET-3: an engine-provided collection is materialized and sorted by *our*
  // keys before any effect is applied. Rapier's pair iteration order is an
  // implementation detail of its broad phase; the registry index is ours.
  const targets: ContactTarget[] = [];
  ex.world.contactPairsWith(conveyor.collider, (other) => {
    const record = ex.colliderOwner.get(other.handle);
    if (record === undefined || record.slot < 0) return;
    // Sleeping bodies are *not* skipped. A belt is a surface force, not a field:
    // §7's "applies to awake bodies" wake rule governs fans and magnets, which
    // act at a distance. A crate resting on a running belt falls asleep within a
    // second, and skipping it here meant the belt carried a box 8 mm in five
    // seconds instead of 1.5 m. Waking is safe for run termination because an
    // active conveyor already blocks `quiescent` on its own (§9.2).
    targets.push({ record, colliderHandle: other.handle });
  });
  if (targets.length === 0) return;
  targets.sort((a, b) => a.record.slot - b.record.slot);

  const tx = conveyor.tangent[0];
  const ty = conveyor.tangent[1];
  for (const target of targets) {
    const other = ex.world.getCollider(target.colliderHandle);
    if (other === null) continue;
    const points: Vec2[] = [];
    ex.world.contactPair(conveyor.collider, other, (manifold) => {
      for (let i = 0; i < manifold.numSolverContacts(); i++) {
        const p = manifold.solverContactPoint(i);
        if (p !== null) points.push([p.x, p.y]);
      }
    });
    if (points.length === 0) continue;

    const body = target.record.body;
    const com = body.worldCom();
    const invMass = body.effectiveInvMass().x;
    const invInertia = body.invPrincipalInertia();
    // The grip limit is a per-pair acceleration budget, split across however
    // many points the manifold produced — so a two-point box contact and a
    // one-point ball contact accelerate at the same rate, which they must, or
    // belt speed would depend on collider shape.
    const budget = (SIM.CONVEYOR_MAX_ACCEL * SIM.DT) / points.length;

    for (const q of points) {
      const rx = q[0] - com.x;
      const ry = q[1] - com.y;
      // Re-read per point: each impulse below changes the body's velocity, and
      // §7.3's `v_body(q_i)` is the velocity the point actually has when its
      // impulse is computed — not the one it had before its neighbour's.
      const linvel = body.linvel();
      const angvel = body.angvel();
      // Velocity of the material point: v + omega x r (2D scalar cross).
      const vx = linvel.x - angvel * ry;
      const vy = linvel.y + angvel * rx;
      const vRel = vx * tx + vy * ty;
      let dv = conveyor.speed - vRel;
      if (dv > budget) dv = budget;
      else if (dv < -budget) dv = -budget;
      // 1/m_eff along t at q: the standard 2D point Jacobian.
      const cross = rx * ty - ry * tx;
      const invEff = invMass + cross * cross * invInertia;
      if (invEff <= 0) continue;
      const j = dv / invEff;
      // A stopped belt under a resting body computes a zero impulse; applying it
      // with `wakeUp` would keep the whole board awake for no motion at all.
      if (j === 0) continue;
      body.applyImpulseAtPoint({ x: j * tx, y: j * ty }, { x: q[0], y: q[1] }, true);
    }
  }
}
