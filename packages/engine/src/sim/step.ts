/**
 * SimCore — the fixed-step pipeline (03 §4) and the run lifecycle (§9).
 *
 * This is the object the whole determinism programme is about: a scene document
 * goes in, and a sequence of state hashes comes out that must be bit-identical
 * on every machine the matrix runs on. It is environment-free by construction
 * (03 §1 rule 1) — no clock, no `Math.random`, no timers — so the browser
 * worker (P2c), the Node golden runner and the future server-side replay
 * verifier all drive the *same* object and must agree.
 *
 * The pipeline's phase order is normative and is written out below exactly as
 * §4's table lists it. The two rules that make it reproducible rather than
 * merely repeatable are worth naming, because most of the code here exists to
 * serve them:
 *
 * - **DET-3/DET-7**: every collection the engine hands us — contact pairs, event
 *   queues — is materialized into an array and sorted by *our* keys (registry
 *   slot, object id) before any effect is applied. Rapier's own iteration order
 *   is a broad-phase implementation detail and is not part of the contract.
 * - **DET-9**: events observed after stepping `k` never mutate anything during
 *   `k`. They queue effects that the *next* step applies in phase P0.
 *
 * Contract: docs/03-SIMULATION-CORE.md §4, §9, §12.
 */

import type { EventQueue } from '@dimforge/rapier2d-deterministic-compat';
import type { Id, Scene } from '@physics/scene-format';
import { validateScene } from '@physics/scene-format';
import type {
  ActivationCause,
  AnalyticsReport,
  BodyRegistryEntry,
  FinishReason,
  LoadWarning,
  SimCommand,
  SimEvent,
} from '../protocol.js';
import { BodyState, SAB, SIM } from '../protocol.js';
import { Analytics, isActivatable } from './analytics.js';
import type { CanonicalScene } from './canonical.js';
import { canonicalize, compareIds } from './canonical.js';
import type { MotorTargets, SolverScratch } from './constraints.js';
import { createScratch, solveCustomConstraints } from './constraints.js';
import type { BodyRecord, ExpandedScene } from './expand.js';
import { expand, isRemoved, rebind, SimLoadError } from './expand.js';
import { applyConveyors, applyFields, fanContains, magnetContains } from './forces.js';
import { stateHash } from './hash.js';
import { initPhysics, physicsBuild as describeBuild, type Rapier } from './rapier.js';
import { Pcg32 } from './rng.js';
import type { ExtraState, LoggedCommand, PendingEffect, SnapshotBundle } from './snapshot.js';

/** §9.2's idle threshold: below this, a body counts as not having moved. */
const IDLE_MOVE_EPSILON = 1e-4;

/** §6's piston deadband: closer than this to the target and the motor idles. */
const PISTON_DEADBAND = 1e-3;

export interface LoadResult {
  bodyCount: number;
  registry: BodyRegistryEntry[];
  warnings: LoadWarning[];
}

/** A collision or sensor entry, after materialization and sorting (DET-3). */
interface PairEvent {
  a: BodyRecord;
  b: BodyRecord;
  started: boolean;
}

export class SimCore {
  readonly #rapier: Rapier;
  #ex: ExpandedScene | null = null;
  #events: EventQueue | null = null;
  #scratch: SolverScratch | null = null;
  #initial: SnapshotBundle | null = null;

  #stepIndex = 0;
  #rng = new Pcg32();
  #activeFans = new Set<Id>();
  #activeMagnets = new Set<Id>();
  #activeConveyors = new Set<Id>();
  #gearSpeeds = new Map<Id, number>();
  #axleSpeeds = new Map<Id, number>();
  #pistonLatched = new Set<Id>();
  #springReleased = new Set<Id>();
  #triggersFired = new Set<Id>();
  #pending: PendingEffect[] = [];
  #analytics = new Analytics();
  #commandLog: LoggedCommand[] = [];
  #idleStep = 0;
  #idlePositions: number[] = [];
  #finished: FinishReason | null = null;

  /** Object id to its expanded bodies, for the activation scan (§10). */
  #bodiesOf = new Map<Id, BodyRecord[]>();
  /** The activatable set (§10), in id order. */
  #activatable: Id[] = [];
  /** Events published since the last drain (§5.3). */
  #outbox: SimEvent[] = [];

  private constructor(rapier: Rapier) {
    this.#rapier = rapier;
  }

  /** @internal — the public entry point is `createSimCore()`. */
  static fromRapier(rapier: Rapier): SimCore {
    return new SimCore(rapier);
  }

  get stepIndex(): number {
    return this.#stepIndex;
  }

  get finished(): FinishReason | null {
    return this.#finished;
  }

  get warnings(): readonly LoadWarning[] {
    return this.#ex?.warnings ?? [];
  }

  get bodyCount(): number {
    return this.#ex?.slots.length ?? 0;
  }

  // -------------------------------------------------------------------------
  // §9.1 Load
  // -------------------------------------------------------------------------

  /**
   * Validate, expand, take the step-0 snapshot, and publish the initial frame.
   *
   * The validation gate is the *shared* one from `@physics/scene-format` (05
   * §5.3), not a second opinion: a document the server accepted and the engine
   * rejects — or the reverse — is the failure mode a single gate exists to
   * prevent.
   */
  load(scene: Scene): LoadResult {
    const gate = validateScene(scene);
    if (!gate.ok) {
      const first = gate.findings[0];
      throw new SimLoadError(gate.code, first?.message ?? `scene rejected (${gate.code})`, first?.path);
    }
    return this.loadCanonical(canonicalize(gate.doc));
  }

  /** Load an already-validated, already-canonical scene (the golden-runner path). */
  loadCanonical(canonical: CanonicalScene): LoadResult {
    const ex = expand(this.#rapier, canonical);
    this.#ex = ex;
    this.#events = new this.#rapier.EventQueue(true);
    this.#scratch = createScratch(ex);

    this.#stepIndex = 0;
    this.#rng = new Pcg32(canonical.world.seed, 0);
    this.#activeFans = new Set(ex.fans.filter((f) => f.startsActive).map((f) => f.id));
    this.#activeMagnets = new Set(ex.magnets.filter((m) => m.startsActive).map((m) => m.id));
    this.#activeConveyors = new Set(ex.conveyors.filter((c) => c.startsActive).map((c) => c.id));
    this.#gearSpeeds = new Map(ex.gears.map((g) => [g.id, g.fileSpeed]));
    this.#axleSpeeds = new Map(ex.axles.map((a) => [a.id, a.fileSpeed]));
    this.#pistonLatched = new Set();
    this.#springReleased = new Set();
    this.#triggersFired = new Set();
    this.#pending = [];
    this.#analytics = new Analytics();
    this.#commandLog = [];
    this.#finished = null;
    this.#outbox = [];

    this.#bodiesOf = new Map();
    for (const record of ex.bodies) {
      const list = this.#bodiesOf.get(record.objId);
      if (list === undefined) this.#bodiesOf.set(record.objId, [record]);
      else list.push(record);
    }
    this.#activatable = canonical.objects.filter((o) => isActivatable(o.type)).map((o) => o.id);

    this.#seedStepZeroActivations();
    this.#resetIdleAnchor(0);

    // The bundle is taken *after* the step-0 activations so a reset restores the
    // run to the state `load` published, not to a subtly earlier one.
    this.#initial = { rapier: ex.world.takeSnapshot(), extra: this.#saveExtra() };

    return { bodyCount: ex.slots.length, registry: this.registry(), warnings: [...ex.warnings] };
  }

  /**
   * §10: objects moving at step 0 are roots of the attribution forest, and so
   * are fields that start switched on — a scene whose only actor is an
   * always-on fan still has something to hang a chain off.
   */
  #seedStepZeroActivations(): void {
    const ex = this.#ex;
    if (ex === null) return;
    for (const id of this.#activatable) {
      for (const record of this.#bodiesOf.get(id) ?? []) {
        const v = record.body.linvel();
        const speed = Math.sqrt(v.x * v.x + v.y * v.y);
        if (speed >= SIM.V_ACT || Math.abs(record.body.angvel()) >= SIM.W_ACT) {
          this.#activate(id, 0);
          break;
        }
      }
    }
    for (const fan of ex.fans) if (this.#activeFans.has(fan.id)) this.#activate(fan.id, 0);
    for (const magnet of ex.magnets) if (this.#activeMagnets.has(magnet.id)) this.#activate(magnet.id, 0);
    for (const conveyor of ex.conveyors) if (this.#activeConveyors.has(conveyor.id)) this.#activate(conveyor.id, 0);
    for (const gear of ex.gears) if ((this.#gearSpeeds.get(gear.id) ?? 0) !== 0) this.#activate(gear.id, 0);
  }

  registry(): BodyRegistryEntry[] {
    return (this.#ex?.slots ?? []).map((record) => ({ objId: record.objId, piece: record.piece }));
  }

  // -------------------------------------------------------------------------
  // §4 The pipeline
  // -------------------------------------------------------------------------

  /** Advance `n` whole steps, stopping early if a finish condition trips. */
  advance(n: number): number {
    let done = 0;
    for (let i = 0; i < n; i++) {
      if (this.#finished !== null) break;
      this.#step();
      done++;
    }
    return done;
  }

  #step(): void {
    const ex = this.#ex;
    const queue = this.#events;
    const scratch = this.#scratch;
    if (ex === null || queue === null || scratch === null) throw new SimLoadError('E_INTERNAL', 'no scene loaded');

    const k = this.#stepIndex;

    // P0 — apply effects queued by step k-1 (DET-9).
    this.#applyPendingEffects(k);

    // P1 — schedules: motor targets are pure functions of stepIndex + latches.
    const targets = this.#motorTargets(k);

    // P2 — reset external forces, then fans, then magnets.
    applyFields(ex, this.#activeFans, this.#activeMagnets);

    // P3 — conveyor surface impulses.
    applyConveyors(ex, this.#activeConveyors);

    // P4 — capped motors, gearMesh, pulley ropes: 8 Gauss-Seidel passes.
    solveCustomConstraints(ex, targets, scratch);

    // P5 — the physics step itself.
    ex.world.step(queue);
    this.#stepIndex = k + 1;

    // P6 — drain events, run trigger/goal logic, update analytics, sweep.
    this.#drainEvents(k, queue);
    this.#scanActivations(k);
    this.#analytics.pruneWindows(this.#stepIndex);
    if (this.#stepIndex % SIM.REMOVAL_SWEEP_STEPS === 0) this.#removalSweep(this.#stepIndex);

    // P7 — publish and evaluate finish conditions.
    this.#sampleSpeeds(this.#stepIndex);
    this.#evaluateFinish();
  }

  /**
   * P0 — activation effects, in the order §9.3 fixes: by source trigger id, then
   * by the target's position in that trigger's `targets` array.
   */
  #applyPendingEffects(step: number): void {
    if (this.#pending.length === 0) return;
    const pending = this.#pending;
    this.#pending = [];
    const ex = this.#ex;
    if (ex === null) return;

    for (const effect of pending) {
      // Recorded *before* the effect is applied, so §10's rule 2 can already see
      // it when the target — or anything the target then moves — activates in
      // this same step.
      this.#analytics.noteTriggerEffect(step, effect.trigger, effect.target);
      this.#applyActivation(effect, step);
    }
  }

  /** 02 §5.4's activation table. Targets with no effect are ignored (rule 9). */
  #applyActivation(effect: PendingEffect, step: number): void {
    const ex = this.#ex;
    if (ex === null) return;
    const target = effect.target;
    // §10 rule 2: an actuator that a trigger switched on was *caused* by that
    // trigger. Passing it explicitly rather than leaving the activation to find
    // its own cause is what keeps a signal hand-off inside one chain — the fan
    // in "marble → trigger → fan" is not a second root.
    const cause: ActivationCause = { via: 'trigger', from: effect.trigger };

    for (const fan of ex.fans) {
      if (fan.id !== target) continue;
      this.#toggle(this.#activeFans, target, step, cause);
      return;
    }
    for (const magnet of ex.magnets) {
      if (magnet.id !== target) continue;
      this.#toggle(this.#activeMagnets, target, step, cause);
      return;
    }
    for (const conveyor of ex.conveyors) {
      if (conveyor.id !== target) continue;
      this.#toggle(this.#activeConveyors, target, step, cause);
      return;
    }
    for (const gear of ex.gears) {
      if (gear.id !== target) continue;
      // Toggle between 0 and the *file* value (§9.3). A gear authored at
      // motorSpeed 0 has nothing to toggle to — 02's W9 already warns about it.
      const live = this.#gearSpeeds.get(target) ?? 0;
      const next = live === 0 ? gear.fileSpeed : 0;
      this.#gearSpeeds.set(target, next);
      if (next !== 0) {
        this.#emit({ kind: 'actuator', step, obj: target, active: true });
        this.#activate(target, step, cause);
      } else {
        this.#emit({ kind: 'actuator', step, obj: target, active: false });
      }
      this.#analytics.noteSemanticEvent(step);
      return;
    }
    for (const piston of ex.pistons) {
      if (piston.id !== target) continue;
      if (piston.mode !== 'triggered' || this.#pistonLatched.has(target)) return;
      this.#pistonLatched.add(target);
      this.#emit({ kind: 'actuator', step, obj: target, active: true });
      this.#analytics.noteSemanticEvent(step);
      this.#activate(target, step, cause);
      return;
    }
    for (const spring of ex.springs) {
      if (spring.id !== target) continue;
      if (spring.mode !== 'triggered' || this.#springReleased.has(target)) return;
      this.#springReleased.add(target);
      // Unlock the latched prismatic: the position motor is already aimed at
      // `travel`, so reopening the limits is what fires the spring (§6).
      spring.joint.setLimits(0, spring.travel);
      this.#emit({ kind: 'actuator', step, obj: target, active: true });
      this.#analytics.noteSemanticEvent(step);
      this.#activate(target, step, cause);
      return;
    }
  }

  #toggle(set: Set<Id>, id: Id, step: number, cause: ActivationCause): void {
    const active = !set.has(id);
    if (active) set.add(id);
    else set.delete(id);
    this.#emit({ kind: 'actuator', step, obj: id, active });
    this.#analytics.noteSemanticEvent(step);
    if (active) this.#activate(id, step, cause);
  }

  /**
   * P1 — the schedules. A piston's target position is a pure function of
   * `stepIndex` (cycle mode) or of its latch (triggered mode), and the motor
   * velocity follows from the sign of the error, with a deadband so a seated
   * piston does not buzz against its own limit.
   */
  #motorTargets(step: number): MotorTargets {
    const ex = this.#ex;
    const angular = new Map<Id, number>();
    const linear = new Map<Id, number>();
    if (ex === null) return { angular, linear };

    for (const gear of ex.gears) {
      const speed = this.#gearSpeeds.get(gear.id) ?? 0;
      if (speed !== 0) angular.set(gear.id, speed);
    }
    for (const axle of ex.axles) {
      const speed = this.#axleSpeeds.get(axle.id) ?? 0;
      if (speed !== 0) angular.set(axle.id, speed);
    }
    const [gx, gy] = ex.scene.world.gravityVec;
    for (const piston of ex.pistons) {
      const t = piston.head.translation();
      const x = (t.x - piston.seated[0]) * piston.axis[0] + (t.y - piston.seated[1]) * piston.axis[1];
      let targetPos: number;
      if (piston.mode === 'cycle') {
        const period = piston.period > 0 ? piston.period : 1;
        const time = step / 60 + piston.phase * period;
        const phase = time - Math.floor(time / period) * period;
        targetPos = phase < period / 2 ? piston.stroke : 0;
      } else {
        targetPos = this.#pistonLatched.has(piston.id) ? piston.stroke : 0;
      }
      const error = targetPos - x;
      const magnitude = error < 0 ? -error : error;
      const wanted = magnitude < PISTON_DEADBAND ? 0 : error > 0 ? piston.speed : -piston.speed;
      // Aim for the velocity the head should have *after* `world.step` adds
      // gravity, because P4 runs before it. Without this a vertical piston moves
      // at `speed - g*dt/2` (measured: 0.098 m/s where the file said 0.2) while a
      // horizontal one is exact — i.e. a user-facing speed that depended on
      // which way the piston pointed. Still capped by `force`, so a piston that
      // cannot lift its load sags instead of cheating (03 §15).
      const gravityAlong = gx * piston.axis[0] + gy * piston.axis[1];
      linear.set(piston.id, wanted - gravityAlong * SIM.DT);
    }
    return { angular, linear };
  }

  /**
   * P6 — drain the event queue, materialized and sorted by our keys (DET-3).
   *
   * Rapier reports sensor intersections through the same collision-event stream,
   * so the split into "a body hit a body" and "a body entered a sensor" happens
   * here, from the owning records rather than from anything the engine says.
   */
  #drainEvents(step: number, queue: EventQueue): void {
    const ex = this.#ex;
    if (ex === null) return;

    const pairs: PairEvent[] = [];
    queue.drainCollisionEvents((h1, h2, started) => {
      const a = ex.colliderOwner.get(h1);
      const b = ex.colliderOwner.get(h2);
      if (a === undefined || b === undefined) return;
      // Normalize the pair so the ordering below cannot depend on which side
      // Rapier happened to report first.
      const flip = compareIds(a.objId, b.objId) > 0 || (a.objId === b.objId && a.slot > b.slot);
      pairs.push(flip ? { a: b, b: a, started } : { a, b, started });
    });
    queue.drainContactForceEvents(() => {
      // Contact forces are not part of any normative output: §5.3's collision
      // impulse is read from the manifold below, where it is an impulse in N*s
      // rather than a force. Drained so the queue does not grow unbounded.
    });
    if (pairs.length === 0) return;

    pairs.sort((x, y) => {
      const byA = compareIds(x.a.objId, y.a.objId);
      if (byA !== 0) return byA;
      const byB = compareIds(x.b.objId, y.b.objId);
      if (byB !== 0) return byB;
      if (x.a.slot !== y.a.slot) return x.a.slot - y.a.slot;
      return x.b.slot - y.b.slot;
    });

    const collisions: { a: Id; b: Id; impulse: number }[] = [];
    for (const pair of pairs) {
      if (!pair.started) continue;
      const aSensor = pair.a.type === 'trigger' || pair.a.type === 'goal';
      const bSensor = pair.b.type === 'trigger' || pair.b.type === 'goal';
      if (aSensor && bSensor) continue;
      if (aSensor) {
        this.#sensorEntry(pair.a, pair.b, step);
        continue;
      }
      if (bSensor) {
        this.#sensorEntry(pair.b, pair.a, step);
        continue;
      }
      this.#analytics.noteContact(step, pair.a.objId, pair.b.objId);
      this.#analytics.noteSemanticEvent(step);
      collisions.push({ a: pair.a.objId, b: pair.b.objId, impulse: this.#pairImpulse(pair) });
    }

    // §5.3: semantic events are never dropped, but collision/SFX events are
    // capped per batch, highest impulse first — 5 000 dominoes falling would
    // otherwise post more events per frame than a renderer can do anything with.
    if (collisions.length > SIM.MAX_SFX_EVENTS_PER_BATCH) {
      collisions.sort((x, y) => y.impulse - x.impulse);
      collisions.length = SIM.MAX_SFX_EVENTS_PER_BATCH;
    }
    for (const c of collisions) this.#emit({ kind: 'collision', step, a: c.a, b: c.b, impulse: c.impulse });
  }

  /** Total normal impulse over a contact pair's manifolds, in N*s (§5.3). */
  #pairImpulse(pair: PairEvent): number {
    const ex = this.#ex;
    if (ex === null) return 0;
    const ca = ex.world.getCollider(pair.a.colliderHandles[0] ?? -1);
    const cb = ex.world.getCollider(pair.b.colliderHandles[0] ?? -1);
    if (ca === null || cb === null) return 0;
    let total = 0;
    ex.world.contactPair(ca, cb, (manifold) => {
      for (let i = 0; i < manifold.numContacts(); i++) total += manifold.contactImpulse(i);
    });
    return total;
  }

  /**
   * §9.3 — a body entered a trigger or a goal.
   *
   * The entering body's *owner* is the cause, which is attribution rule 0: a
   * sensor emits an intersection, never a collision start, so without this the
   * trigger would be a root and every wired hand-off would cut the forest (D14).
   */
  #sensorEntry(sensor: BodyRecord, entrant: BodyRecord, step: number): void {
    const ex = this.#ex;
    if (ex === null) return;
    if (entrant.slot < 0) return;

    if (sensor.type === 'trigger') {
      const desc = ex.triggers.find((t) => t.id === sensor.objId);
      if (desc === undefined) return;
      if (desc.once && this.#triggersFired.has(desc.id)) return;
      this.#triggersFired.add(desc.id);
      this.#emit({ kind: 'triggerFired', step, trigger: desc.id, by: entrant.objId });
      this.#analytics.noteSemanticEvent(step);
      this.#activate(desc.id, step, { via: 'sensor', from: entrant.objId });
      // DET-9: the effects land at the start of the next step, in `targets` order.
      for (const target of desc.targets) this.#pending.push({ trigger: desc.id, target });
      return;
    }

    const goal = ex.goals.find((g) => g.id === sensor.objId);
    if (goal === undefined) return;
    if (goal.accepts !== 'any' && !goal.accepts.includes(entrant.objId)) return;
    if (this.#analytics.activationStep(goal.id) !== undefined && this.#goalSatisfied(goal.id)) return;
    this.#analytics.noteGoal(goal.id, step);
    this.#emit({ kind: 'goalReached', step, goal: goal.id, by: entrant.objId });
    this.#analytics.noteSemanticEvent(step);
    this.#activate(goal.id, step, { via: 'sensor', from: entrant.objId });
  }

  #goalSatisfied(id: Id): boolean {
    const ex = this.#ex;
    if (ex === null) return false;
    return this.#analytics.goalCount > 0 && this.#analytics.activationStep(id) !== undefined;
  }

  /**
   * P6 — the activation scan, and with it §10's attribution search.
   *
   * Run after the step so a body's velocity is the one the step produced.
   */
  #scanActivations(step: number): void {
    const ex = this.#ex;
    if (ex === null) return;
    for (const id of this.#activatable) {
      if (this.#analytics.hasActivated(id)) continue;
      for (const record of this.#bodiesOf.get(id) ?? []) {
        if (record.slot < 0 || isRemoved(ex, record)) continue;
        const v = record.body.linvel();
        const speed = Math.sqrt(v.x * v.x + v.y * v.y);
        const spin = Math.abs(record.body.angvel());
        if (speed < SIM.V_ACT && spin < SIM.W_ACT) continue;
        this.#activate(id, step, this.#findCause(id, record, step));
        break;
      }
    }
  }

  /** §10's priority search. Rule 0 is handled at the sensor entry itself. */
  #findCause(objId: Id, record: BodyRecord, step: number): ActivationCause | undefined {
    const ex = this.#ex;
    if (ex === null) return undefined;

    const contact = this.#analytics.contactCause(objId, step);
    if (contact !== null) return { via: 'contact', from: contact };

    const trigger = this.#analytics.triggerCause(objId, step);
    if (trigger !== null) return { via: 'trigger', from: trigger };

    const com = record.body.worldCom();
    for (const fan of ex.fans) {
      if (!this.#activeFans.has(fan.id)) continue;
      if (fanContains(fan, [com.x, com.y])) return { via: 'field', from: fan.id };
    }
    for (const magnet of ex.magnets) {
      if (!this.#activeMagnets.has(magnet.id)) continue;
      if (!record.magnetic) continue;
      if (magnetContains(magnet, [com.x, com.y])) return { via: 'field', from: magnet.id };
    }
    return undefined;
  }

  #activate(id: Id, step: number, cause?: ActivationCause): void {
    if (this.#analytics.hasActivated(id)) return;
    this.#analytics.activate(id, step, cause);
    const event: SimEvent = cause === undefined ? { kind: 'activation', step, obj: id } : { kind: 'activation', step, obj: id, cause };
    this.#emit(event);
  }

  /**
   * DET-10 — remove bodies that have left the board.
   *
   * Phrased as "which colliders still intersect the inflated play area", because
   * that is the query the broad phase can answer directly; anything the query
   * does not return has an AABB fully outside, which is the rule's own wording.
   */
  #removalSweep(step: number): void {
    const ex = this.#ex;
    if (ex === null) return;
    const [w, h] = ex.scene.world.bounds;
    const halfW = w / 2 + SIM.REMOVAL_MARGIN_M;
    const halfH = h / 2 + SIM.REMOVAL_MARGIN_M;

    const inside = new Set<number>();
    ex.world.collidersWithAabbIntersectingAabb({ x: 0, y: 0 }, { x: halfW, y: halfH }, (collider) => {
      inside.add(collider.handle);
      return true;
    });

    for (const record of ex.slots) {
      if (isRemoved(ex, record)) continue;
      let onBoard = false;
      for (const handle of record.colliderHandles) {
        if (inside.has(handle)) {
          onBoard = true;
          break;
        }
      }
      if (onBoard) continue;
      ex.world.removeRigidBody(record.body);
      this.#analytics.noteRemoved();
      this.#analytics.noteSemanticEvent(step);
      this.#emit({ kind: 'removed', step, obj: record.objId, piece: record.piece });
    }
  }

  /** P7 — `maxSpeedMS` is sampled here, while the frame is written (§10). */
  #sampleSpeeds(step: number): void {
    const ex = this.#ex;
    if (ex === null) return;
    let moving = false;
    for (const record of ex.slots) {
      if (isRemoved(ex, record)) continue;
      const v = record.body.linvel();
      const speed = Math.sqrt(v.x * v.x + v.y * v.y);
      this.#analytics.noteSpeed(step, record.objId, speed);
      if (speed >= SIM.V_ACT) moving = true;
    }
    if (moving) this.#analytics.noteMotion(step);
    this.#updateIdleWindow(step);
  }

  /** Object ids whose own bodies are allowed to move without breaking `idle`. */
  #liveActuatorIds(): Set<Id> {
    const ex = this.#ex;
    const live = new Set<Id>();
    if (ex === null) return live;
    for (const id of this.#activeFans) live.add(id);
    for (const id of this.#activeMagnets) live.add(id);
    for (const id of this.#activeConveyors) live.add(id);
    for (const [id, speed] of this.#gearSpeeds) if (speed !== 0) live.add(id);
    for (const [id, speed] of this.#axleSpeeds) if (speed !== 0) live.add(id);
    for (const piston of ex.pistons) if (piston.mode === 'cycle') live.add(piston.id);
    return live;
  }

  #hasLiveActuator(): boolean {
    return this.#liveActuatorIds().size > 0;
  }

  #resetIdleAnchor(step: number): void {
    const ex = this.#ex;
    if (ex === null) return;
    const positions = new Array<number>(ex.slots.length * 2).fill(0);
    for (let i = 0; i < ex.slots.length; i++) {
      const record = ex.slots[i] as BodyRecord;
      if (isRemoved(ex, record)) continue;
      const t = record.body.translation();
      positions[i * 2] = t.x;
      positions[i * 2 + 1] = t.y;
    }
    this.#idleStep = step;
    this.#idlePositions = positions;
  }

  /**
   * §9.2's `idle` window. Measured against the pose captured when the window
   * opened, not against the previous step — see `IdleAnchor` in `snapshot.ts`.
   */
  #updateIdleWindow(step: number): void {
    const ex = this.#ex;
    if (ex === null) return;
    if (this.#analytics.lastSemanticStep >= this.#idleStep) {
      this.#resetIdleAnchor(step);
      return;
    }
    const live = this.#liveActuatorIds();
    for (let i = 0; i < ex.slots.length; i++) {
      const record = ex.slots[i] as BodyRecord;
      if (isRemoved(ex, record) || live.has(record.objId)) continue;
      const t = record.body.translation();
      const dx = t.x - (this.#idlePositions[i * 2] ?? 0);
      const dy = t.y - (this.#idlePositions[i * 2 + 1] ?? 0);
      if (Math.sqrt(dx * dx + dy * dy) > IDLE_MOVE_EPSILON) {
        this.#resetIdleAnchor(step);
        return;
      }
    }
  }

  /** §9.2 — first match wins. */
  #evaluateFinish(): void {
    const ex = this.#ex;
    if (ex === null || this.#finished !== null) return;

    if (this.#stepIndex >= SIM.HARD_CAP_S * 60) {
      this.#finished = 'hardCap';
      return;
    }

    let allStill = true;
    for (const record of ex.slots) {
      if (isRemoved(ex, record)) continue;
      if (!record.body.isSleeping()) {
        allStill = false;
        break;
      }
    }
    const liveActuator = this.#hasLiveActuator();
    if (allStill && !liveActuator) {
      this.#finished = 'quiescent';
      return;
    }

    if (this.#stepIndex - this.#idleStep >= SIM.IDLE_WINDOW_S * 60) this.#finished = 'idle';
  }

  // -------------------------------------------------------------------------
  // §5.2 Commands
  // -------------------------------------------------------------------------

  /** DET-8: every command is recorded at the step boundary it took effect on. */
  record(command: SimCommand): void {
    this.#commandLog.push({ step: this.#stepIndex, command });
  }

  /** The `stop` command (§9.2). */
  stop(): void {
    if (this.#finished === null) this.#finished = 'stopped';
  }

  // -------------------------------------------------------------------------
  // §11 Snapshot and reset
  // -------------------------------------------------------------------------

  snapshot(): SnapshotBundle {
    const ex = this.#ex;
    if (ex === null) throw new SimLoadError('E_INTERNAL', 'no scene loaded');
    return { rapier: ex.world.takeSnapshot(), extra: this.#saveExtra() };
  }

  /** Restore a bundle. The world is replaced, so every handle is re-bound. */
  restore(bundle: SnapshotBundle): void {
    const ex = this.#ex;
    if (ex === null) throw new SimLoadError('E_INTERNAL', 'no scene loaded');
    const world = this.#rapier.World.restoreSnapshot(bundle.rapier);
    rebind(ex, world);
    this.#events = new this.#rapier.EventQueue(true);
    this.#restoreExtra(bundle.extra);
  }

  /** §5.2 `reset`: back to the step-0 bundle taken at load. */
  reset(): void {
    if (this.#initial === null) throw new SimLoadError('E_INTERNAL', 'no scene loaded');
    this.restore(this.#initial);
  }

  /**
   * §5.2 `shutdown`: free the world and the event queue.
   *
   * Rapier's allocations live in the WASM heap, which the JS garbage collector
   * cannot see — a worker that loads scene after scene without this leaks a
   * whole physics world each time. Idempotent, and the core is left in the
   * unloaded state rather than in a half-freed one, so a later `load` works and
   * anything else fails the same way it would before the first load.
   */
  dispose(): void {
    const ex = this.#ex;
    this.#ex = null;
    this.#initial = null;
    this.#scratch = null;
    this.#events?.free();
    this.#events = null;
    ex?.world.free();
  }

  /**
   * The exact physics build that loaded, for `ready` (§5.3).
   *
   * A method rather than an exposed namespace: 03 §1 rule 2 keeps Rapier types
   * inside this package, and `worker.ts` needs the string, not the module.
   */
  physicsBuild(): string {
    return describeBuild(this.#rapier);
  }

  #saveExtra(): ExtraState {
    return {
      stepIndex: this.#stepIndex,
      rng: this.#rng.save(),
      activeFans: [...this.#activeFans],
      activeMagnets: [...this.#activeMagnets],
      activeConveyors: [...this.#activeConveyors],
      gearSpeeds: [...this.#gearSpeeds],
      axleSpeeds: [...this.#axleSpeeds],
      pistonLatched: [...this.#pistonLatched],
      springReleased: [...this.#springReleased],
      triggersFired: [...this.#triggersFired],
      pending: this.#pending.map((p) => ({ ...p })),
      analytics: this.#analytics.save(),
      commandLog: this.#commandLog.map((c) => ({ ...c })),
      idle: { step: this.#idleStep, positions: [...this.#idlePositions] },
      finished: this.#finished,
    };
  }

  #restoreExtra(extra: ExtraState): void {
    const ex = this.#ex;
    this.#stepIndex = extra.stepIndex;
    this.#rng = Pcg32.from(extra.rng);
    this.#activeFans = new Set(extra.activeFans);
    this.#activeMagnets = new Set(extra.activeMagnets);
    this.#activeConveyors = new Set(extra.activeConveyors);
    this.#gearSpeeds = new Map(extra.gearSpeeds);
    this.#axleSpeeds = new Map(extra.axleSpeeds);
    this.#pistonLatched = new Set(extra.pistonLatched);
    this.#springReleased = new Set(extra.springReleased);
    this.#triggersFired = new Set(extra.triggersFired);
    this.#pending = extra.pending.map((p) => ({ ...p }));
    this.#analytics = new Analytics();
    this.#analytics.restore(extra.analytics);
    this.#commandLog = extra.commandLog.map((c) => ({ ...c }));
    this.#idleStep = extra.idle.step;
    this.#idlePositions = [...extra.idle.positions];
    this.#finished = extra.finished;
    this.#outbox = [];

    // A latched spring's limits live in the Rapier snapshot, but a spring that
    // was released *after* the snapshot was taken must be re-latched — the
    // restored joint carries whatever limits the snapshot had, and `springs`
    // is a descriptor table that survives the world swap.
    if (ex === null) return;
    for (const spring of ex.springs) {
      if (spring.mode !== 'triggered') continue;
      spring.joint.setLimits(0, this.#springReleased.has(spring.id) ? spring.travel : 0);
    }
  }

  // -------------------------------------------------------------------------
  // §5.3 / §5.4 Output
  // -------------------------------------------------------------------------

  #emit(event: SimEvent): void {
    this.#outbox.push(event);
  }

  /** Take the events published since the last call (§5.3). */
  drain(): SimEvent[] {
    const events = this.#outbox;
    this.#outbox = [];
    return events;
  }

  /**
   * Write one frame in the §5.4 per-body layout: `x, y, rot, state`.
   *
   * A removed body writes `(0, 0, 0, Removed)` rather than the pose it had when
   * it left. The renderer hides it either way, and the state hash reads these
   * same four numbers — so freezing a pose would put a value in the hash that
   * exists nowhere else in the run and must then be snapshotted to survive a
   * reset (03 §15).
   */
  writeFrame(target: Float32Array): void {
    const ex = this.#ex;
    if (ex === null) return;
    for (let i = 0; i < ex.slots.length; i++) {
      const record = ex.slots[i] as BodyRecord;
      const base = i * SAB.FLOATS_PER_BODY;
      if (isRemoved(ex, record)) {
        target[base] = 0;
        target[base + 1] = 0;
        target[base + 2] = 0;
        target[base + 3] = BodyState.Removed;
        continue;
      }
      const t = record.body.translation();
      target[base] = t.x;
      target[base + 1] = t.y;
      target[base + 2] = record.body.rotation();
      target[base + 3] = record.body.isSleeping() ? BodyState.Asleep : BodyState.Awake;
    }
  }

  /** The §12 state hash over the current state. */
  hash(): string {
    const ex = this.#ex;
    if (ex === null) return stateHash(this.#stepIndex, []);
    const bodies = ex.slots.map((record) => {
      if (isRemoved(ex, record)) return { x: 0, y: 0, rot: 0, state: BodyState.Removed as number };
      const t = record.body.translation();
      return {
        x: t.x,
        y: t.y,
        rot: record.body.rotation(),
        state: (record.body.isSleeping() ? BodyState.Asleep : BodyState.Awake) as number,
      };
    });
    return stateHash(this.#stepIndex, bodies);
  }

  /** The §10 report. Valid at any point; §9.2 sends it with `finished`. */
  report(): AnalyticsReport {
    return this.#analytics.report(this.#stepIndex, this.#activatable, this.hash());
  }
}

/**
 * The package's one construction path: load the pinned WASM build, then hand
 * back a core ready for `load`.
 *
 * 03 §1 rule 2 keeps Rapier inside this package, so nothing a caller touches is
 * a Rapier object — the surface is the protocol in `protocol.ts` plus the
 * methods above.
 */
export async function createSimCore(): Promise<SimCore> {
  return SimCore.fromRapier(await initPhysics());
}
