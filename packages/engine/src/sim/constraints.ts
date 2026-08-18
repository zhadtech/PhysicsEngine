/**
 * Custom velocity constraints — 03 §4 phase P4, §8.
 *
 * Three families share one Gauss-Seidel loop, run before `world.step` so
 * Rapier's own solver always has the final word:
 *
 * 1. **Capped motors** (gear, axle, piston). These are here rather than on the
 *    Rapier joint because **rapier.js 0.19.3 exposes no maximum-force setter** —
 *    `configureMotorVelocity/Position/Motor` are the whole motor surface, at the
 *    binding *and* at the raw WASM layer, while the Rust `JointMotor` behind it
 *    does have `max_force`. That is U10 resolving in the negative, and 03 §14
 *    named this exact fallback: "model motors in our P4 layer (same solver as
 *    §8)". Without it `gear.maxTorque` and `piston.force` would be decorative,
 *    and a default gear would lift any load in the catalog.
 * 2. **`gearMesh`** (§8.1) — an ideal ratio coupling, no slip limit in v1.
 * 3. **Rope over pulleys** (§8.2) — a unilateral constraint: ropes pull, never
 *    push.
 *
 * Every number here is f64 built from the exactly-specified operations (DET-5),
 * and the traversal order is fixed (DET-7): object motors in id order, then link
 * constraints in id order, repeated `CUSTOM_SOLVER_ITERATIONS` times with no
 * warm starting.
 *
 * Contract: docs/03-SIMULATION-CORE.md §4 phase P4, §8, §14 (U10).
 */

import type { RigidBody } from '@dimforge/rapier2d-deterministic-compat';
import type { Id } from '@physics/scene-format';
import { SIM } from '../protocol.js';
import { compareIds } from './canonical.js';
import { dcos, dsin } from './dmath.js';
import type { ExpandedScene } from './expand.js';

/**
 * An angular velocity motor with a torque cap: `omega_b - omega_a = target`,
 * with the accumulated impulse clamped to `maxTorque * dt`.
 */
interface AngularMotor {
  kind: 'angular';
  id: Id;
  a: RigidBody | null;
  b: RigidBody;
  maxTorque: number;
}

/** A linear velocity motor along a prismatic axis, with a force cap. */
interface LinearMotor {
  kind: 'linear';
  id: Id;
  body: RigidBody;
  axis: readonly [number, number];
  maxForce: number;
}

type Motor = AngularMotor | LinearMotor;

/**
 * Per-step solver scratch: one accumulated impulse per constraint.
 *
 * Deliberately *not* part of `ExtraState` (§11). §8 specifies no warm starting,
 * so these are zeroed at the top of every P4 and carry nothing across a step
 * boundary — which is what lets a snapshot taken between two steps be complete
 * without them.
 */
export interface SolverScratch {
  motors: Float64Array;
  ropes: Float64Array;
}

export function createScratch(ex: ExpandedScene): SolverScratch {
  return {
    motors: new Float64Array(ex.gears.length + ex.axles.length + ex.pistons.length),
    ropes: new Float64Array(ex.pulleyRopes.length),
  };
}

/** Angular inertia is reported as its inverse; a fixed body reports 0. */
function invInertiaOf(body: RigidBody | null): number {
  return body === null ? 0 : body.invPrincipalInertia();
}

function invMassOf(body: RigidBody): number {
  return body.effectiveInvMass().x;
}

/**
 * Solve one capped motor for one pass.
 *
 * The clamp is on the *accumulated* impulse rather than on each pass's
 * increment, which is what makes the cap mean "this motor cannot deliver more
 * than `maxTorque` this step" instead of "…more than 8x `maxTorque`".
 */
function solveMotor(motor: Motor, target: number, scratch: Float64Array, index: number): void {
  if (motor.kind === 'angular') {
    const invA = invInertiaOf(motor.a);
    const invB = invInertiaOf(motor.b);
    const k = invA + invB;
    if (k <= 0) return;
    const omegaA = motor.a === null ? 0 : motor.a.angvel();
    const relative = motor.b.angvel() - omegaA;
    const lambda = (target - relative) / k;
    const cap = motor.maxTorque * SIM.DT;
    const previous = scratch[index] ?? 0;
    let accumulated = previous + lambda;
    if (accumulated > cap) accumulated = cap;
    else if (accumulated < -cap) accumulated = -cap;
    const delta = accumulated - previous;
    scratch[index] = accumulated;
    if (delta === 0) return;
    motor.b.applyTorqueImpulse(delta, true);
    if (motor.a !== null) motor.a.applyTorqueImpulse(-delta, true);
    return;
  }

  const invMass = invMassOf(motor.body);
  if (invMass <= 0) return;
  const v = motor.body.linvel();
  const along = v.x * motor.axis[0] + v.y * motor.axis[1];
  const lambda = (target - along) / invMass;
  const cap = motor.maxForce * SIM.DT;
  const previous = scratch[index] ?? 0;
  let accumulated = previous + lambda;
  if (accumulated > cap) accumulated = cap;
  else if (accumulated < -cap) accumulated = -cap;
  const delta = accumulated - previous;
  scratch[index] = accumulated;
  if (delta === 0) return;
  motor.body.applyImpulse({ x: delta * motor.axis[0], y: delta * motor.axis[1] }, true);
}

/**
 * §8.1 — `omega_b - ratio * omega_a = 0`, solved to convergence over the 8
 * passes. Ideal coupling: a mesh transmits whatever torque it takes, so chains
 * of meshes (A-B, B-C) settle rather than fight each other.
 */
function solveGearMesh(a: RigidBody, b: RigidBody, ratio: number): void {
  const invA = invInertiaOf(a);
  const invB = invInertiaOf(b);
  const k = invB + ratio * ratio * invA;
  if (k <= 0) return;
  const lambda = -(b.angvel() - ratio * a.angvel()) / k;
  if (lambda === 0) return;
  b.applyTorqueImpulse(lambda, true);
  a.applyTorqueImpulse(-ratio * lambda, true);
}

/**
 * A rope attachment resolved into world space, plus the lever arm it acts on.
 *
 * Computed **once per step**, at the top of P4, not once per pass: the eight
 * Gauss-Seidel passes change velocities only — positions are integrated by
 * `world.step`, which has not run yet — so the geometry below is constant for
 * the whole phase. That is what keeps the transcendental count at two per rope
 * per step rather than thirty-two.
 *
 * This is the one place per-step code calls `dmath`. DET-5's ban is on the
 * *platform's* transcendentals, which differ in the last bit between JS engines;
 * `dsin`/`dcos` are built from the exactly-specified operations and are proven
 * bit-identical under V8 and JavaScriptCore by the committed golden digest. A
 * rope endpoint rides on a rotating body, so unlike a fan axis or a belt tangent
 * it genuinely cannot be precomputed at load (03 §15).
 */
interface RopeAnchor {
  /** World attachment point. */
  px: number;
  py: number;
  /** Attachment point relative to the body's centre of mass. */
  rx: number;
  ry: number;
}

function ropeAnchor(body: RigidBody, local: readonly [number, number]): RopeAnchor {
  const t = body.translation();
  const rot = body.rotation();
  const cos = dcos(rot);
  const sin = dsin(rot);
  const lx = local[0] * cos - local[1] * sin;
  const ly = local[0] * sin + local[1] * cos;
  const px = t.x + lx;
  const py = t.y + ly;
  // The lever arm is measured from the centre of mass, which is where an
  // impulse's angular effect is reckoned — not from the body origin, which for
  // a compound prefab like a rigid pendulum is a different point entirely.
  const com = body.worldCom();
  return { px, py, rx: px - com.x, ry: py - com.y };
}

/**
 * §8.2 — the two end spans of a rope routed over pulleys share one length
 * budget. Interior spans are constant (pulleys are static), so the whole rope
 * reduces to `C = |p_a - w_first| + |p_b - w_last| - B <= 0`.
 *
 * Sign note: §8.2 pairs `lambda = -(Cdot + bias) / (K_a + K_b)` with impulses
 * `dLambda * u`, where `u` points *from* the pulley *to* the attachment — so a
 * rope being stretched (`Cdot > 0`) produces a negative lambda, i.e. a pull.
 * The accumulator is therefore clamped to `min(0, ...)`, not the `max(0, ...)`
 * the spec printed: with `max` the multiplier could only ever be positive, and
 * every rope in the corpus would push its load away from the pulley instead of
 * lifting it. Corrected at P2b (03 §15).
 */
function solveRope(
  a: RigidBody,
  anchorA: RopeAnchor,
  b: RigidBody,
  anchorB: RopeAnchor,
  first: readonly [number, number],
  last: readonly [number, number],
  budget: number,
  gravity: GravityStep,
  scratch: Float64Array,
  index: number,
): void {
  const ax = anchorA.px - first[0];
  const ay = anchorA.py - first[1];
  const bx = anchorB.px - last[0];
  const by = anchorB.py - last[1];
  const spanA = Math.sqrt(ax * ax + ay * ay);
  const spanB = Math.sqrt(bx * bx + by * by);

  // A span shorter than a micrometre has no meaningful direction; §8.2 zeroes
  // that side's Jacobian for the step rather than normalizing noise.
  const uax = spanA > 1e-6 ? ax / spanA : 0;
  const uay = spanA > 1e-6 ? ay / spanA : 0;
  const ubx = spanB > 1e-6 ? bx / spanB : 0;
  const uby = spanB > 1e-6 ? by / spanB : 0;

  const crossA = anchorA.rx * uay - anchorA.ry * uax;
  const crossB = anchorB.rx * uby - anchorB.ry * ubx;
  const ka = invMassOf(a) + crossA * crossA * invInertiaOf(a);
  const kb = invMassOf(b) + crossB * crossB * invInertiaOf(b);
  const k = ka + kb;
  if (k <= 0) return;

  const va = a.linvel();
  const wa = a.angvel();
  const vb = b.linvel();
  const wb = b.angvel();
  // Gravity feedforward. P4 runs *before* `world.step`, which then adds
  // `g * dt` to every dynamic body — so a constraint that zeroes the velocity it
  // can see still lets the rope stretch by `g * dt^2` every step, and Baumgarte
  // only claws back `beta` of the accumulated error. Measured at P2b: a crate
  // hanging over a pulley settled 14-28 mm past its length, against the 2 mm
  // §12 asks for. Anticipating the increment the engine is about to apply costs
  // two multiplies and brings the steady-state error inside that budget. Static
  // endpoints have no inverse mass and so contribute nothing (03 §15).
  const gaX = invMassOf(a) > 0 ? gravity.dvx : 0;
  const gaY = invMassOf(a) > 0 ? gravity.dvy : 0;
  const gbX = invMassOf(b) > 0 ? gravity.dvx : 0;
  const gbY = invMassOf(b) > 0 ? gravity.dvy : 0;
  const cdot =
    (va.x + gaX - wa * anchorA.ry) * uax +
    (va.y + gaY + wa * anchorA.rx) * uay +
    (vb.x + gbX - wb * anchorB.ry) * ubx +
    (vb.y + gbY + wb * anchorB.rx) * uby;

  const c = spanA + spanB - budget;
  // Activation gate: a *slack* rope does nothing at all.
  //
  // §8.2 gives the unilateral behaviour as a clamp on the accumulated multiplier
  // and nothing else, but a clamp alone cannot express "only when taut": with
  // the multiplier free to go negative (the pulling direction), a rope hanging
  // in a loose loop still resists its own end being lowered, and a load on a
  // deliberately slack rope gets winched up to the pulley — measured at P2b, a
  // crate rose 0.55 m on a rope that should have let it fall. The constraint
  // `C <= 0` is only *violated*, and therefore only enforced, from `-ROPE_SLOP`
  // upward; engaging across the slop band rather than exactly at zero catches
  // the rope a step before it would snap taut (03 §15).
  if (c < -SIM.ROPE_SLOP) {
    scratch[index] = 0;
    return;
  }
  const violation = c - SIM.ROPE_SLOP;
  const bias = violation > 0 ? (SIM.ROPE_BIAS_BETA / SIM.DT) * violation : 0;
  const lambda = -(cdot + bias) / k;

  const previous = scratch[index] ?? 0;
  let accumulated = previous + lambda;
  if (accumulated > 0) accumulated = 0;
  const delta = accumulated - previous;
  scratch[index] = accumulated;
  if (delta === 0) return;

  a.applyImpulseAtPoint({ x: delta * uax, y: delta * uay }, { x: anchorA.px, y: anchorA.py }, true);
  b.applyImpulseAtPoint({ x: delta * ubx, y: delta * uby }, { x: anchorB.px, y: anchorB.py }, true);
}

/** Per-step motor targets, computed in phase P1 and consumed here. */
export interface GravityStep {
  /** `gravityVec * dt` — the velocity increment `world.step` is about to add. */
  dvx: number;
  dvy: number;
}

export interface MotorTargets {
  /** gear/axle id to target angular velocity, rad/s. */
  angular: ReadonlyMap<Id, number>;
  /** piston id to target linear velocity along its axis, m/s. */
  linear: ReadonlyMap<Id, number>;
}

/**
 * Phase P4 — `CUSTOM_SOLVER_ITERATIONS` Gauss-Seidel passes.
 *
 * Object motors run before link constraints within each pass, each family in id
 * order. 03 §4 originally said only "links by id"; motors joined this phase at
 * P2b (U10), and an order they are *not* in would be an unspecified one, so the
 * rule is stated rather than left to the array layout (03 §15).
 */
export function solveCustomConstraints(
  ex: ExpandedScene,
  targets: MotorTargets,
  scratch: SolverScratch,
): void {
  const gravity: GravityStep = {
    dvx: ex.scene.world.gravityVec[0] * SIM.DT,
    dvy: ex.scene.world.gravityVec[1] * SIM.DT,
  };
  scratch.motors.fill(0);
  scratch.ropes.fill(0);

  const motors: { motor: Motor; target: number }[] = [];
  for (const gear of ex.gears) {
    const target = targets.angular.get(gear.id);
    if (target === undefined) continue;
    motors.push({ motor: { kind: 'angular', id: gear.id, a: null, b: gear.body, maxTorque: gear.maxTorque }, target });
  }
  for (const piston of ex.pistons) {
    const target = targets.linear.get(piston.id);
    if (target === undefined) continue;
    motors.push({
      motor: {
        kind: 'linear',
        id: piston.id,
        body: piston.head,
        axis: [piston.axis[0], piston.axis[1]],
        maxForce: piston.force,
      },
      target,
    });
  }
  motors.sort((x, y) => compareIds(x.motor.id, y.motor.id));

  const linkMotors: { motor: Motor; target: number }[] = [];
  for (const axle of ex.axles) {
    const target = targets.angular.get(axle.id);
    if (target === undefined) continue;
    linkMotors.push({
      motor: { kind: 'angular', id: axle.id, a: axle.a, b: axle.b, maxTorque: axle.maxTorque },
      target,
    });
  }
  linkMotors.sort((x, y) => compareIds(x.motor.id, y.motor.id));

  const all = [...motors, ...linkMotors];
  // Rope geometry is fixed for the phase (see `ropeAnchor`), so resolve it once.
  const anchors = ex.pulleyRopes.map((rope) => ({
    a: ropeAnchor(rope.a, [rope.aLocal[0], rope.aLocal[1]]),
    b: ropeAnchor(rope.b, [rope.bLocal[0], rope.bLocal[1]]),
  }));

  for (let pass = 0; pass < SIM.CUSTOM_SOLVER_ITERATIONS; pass++) {
    for (let i = 0; i < all.length; i++) {
      const entry = all[i];
      if (entry === undefined) continue;
      solveMotor(entry.motor, entry.target, scratch.motors, i);
    }
    for (const mesh of ex.gearMeshes) solveGearMesh(mesh.a, mesh.b, mesh.ratio);
    for (let i = 0; i < ex.pulleyRopes.length; i++) {
      const rope = ex.pulleyRopes[i];
      const anchor = anchors[i];
      if (rope === undefined || anchor === undefined) continue;
      solveRope(
        rope.a,
        anchor.a,
        rope.b,
        anchor.b,
        [rope.first[0], rope.first[1]],
        [rope.last[0], rope.last[1]],
        rope.budget,
        gravity,
        scratch.ropes,
        i,
      );
    }
  }
}
