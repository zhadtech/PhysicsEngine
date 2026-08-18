/**
 * Run analytics — 03 §10.
 *
 * These numbers are not telemetry. `efficiencyScore` and `longestChain` rank
 * leaderboards (08 §5, D17), and a leaderboard is only honest if the server can
 * recompute the same number from `(document, engineVersion)` — so every
 * definition here is inside the determinism surface, exactly like a solver
 * constant. Changing one is an `engineVersion` bump, not a metrics tweak.
 *
 * The interesting part is **attribution**: what caused what. Each object's first
 * activation gets at most one cause, searched in the §10 priority order, and the
 * resulting edges form a forest whose longest path is "how long a chain reaction
 * this machine actually produced".
 *
 * Contract: docs/03-SIMULATION-CORE.md §10.
 */

import type { Id, ObjectType } from '@physics/scene-format';
import type { ActivationCause, AnalyticsReport } from '../protocol.js';
import { SIM } from '../protocol.js';
import { compareIds } from './canonical.js';

/**
 * §10: the activatable set is everything except pure structure. A platform that
 * never moves is not a machine part that failed to fire, so counting it would
 * punish every scene that stands on a floor.
 */
const PURE_STRUCTURE: ReadonlySet<ObjectType> = new Set<ObjectType>(['platform', 'ramp', 'curve', 'pulley']);

export function isActivatable(type: ObjectType): boolean {
  return !PURE_STRUCTURE.has(type);
}

/** A collision start, kept for `CHAIN_WINDOW_STEPS` (§10 attribution rule 1). */
export interface ContactRecord {
  step: number;
  a: Id;
  b: Id;
}

/** A trigger effect that landed on a target (§10 attribution rule 2). */
export interface TriggerEffectRecord {
  step: number;
  trigger: Id;
  target: Id;
}

/** Everything §11 must carry for analytics to survive a snapshot. */
export interface AnalyticsSnapshot {
  firstActivation: [Id, number][];
  causes: [Id, ActivationCause][];
  edges: [Id, Id][];
  maxSpeed: number;
  maxSpeedObj: Id | null;
  maxSpeedStep: number;
  goalTimes: [Id, number][];
  removedCount: number;
  lastActiveStep: number;
  lastSemanticStep: number;
  recentContacts: ContactRecord[];
  recentTriggerEffects: TriggerEffectRecord[];
}

export class Analytics {
  /** Insertion order is activation order, which is how ties resolve below. */
  #firstActivation = new Map<Id, number>();
  #causes = new Map<Id, ActivationCause>();
  #edges: [Id, Id][] = [];
  #maxSpeed = 0;
  #maxSpeedObj: Id | null = null;
  #maxSpeedStep = -1;
  #goalTimes = new Map<Id, number>();
  #removedCount = 0;
  #lastActiveStep = 0;
  #lastSemanticStep = 0;
  #recentContacts: ContactRecord[] = [];
  #recentTriggerEffects: TriggerEffectRecord[] = [];

  hasActivated(id: Id): boolean {
    return this.#firstActivation.has(id);
  }

  activationStep(id: Id): number | undefined {
    return this.#firstActivation.get(id);
  }

  get removedCount(): number {
    return this.#removedCount;
  }

  get lastSemanticStep(): number {
    return this.#lastSemanticStep;
  }

  get goalCount(): number {
    return this.#goalTimes.size;
  }

  /**
   * Record a first activation and the edge that explains it.
   *
   * `cause` absent means a root: something that started moving on its own at
   * step 0, or that nothing in the §10 search could account for.
   */
  activate(id: Id, step: number, cause?: ActivationCause): void {
    if (this.#firstActivation.has(id)) return;
    this.#firstActivation.set(id, step);
    if (cause !== undefined) {
      this.#causes.set(id, cause);
      this.#edges.push([cause.from, id]);
    }
  }

  /** A semantic event (§9.2's `idle` test and `durationS` both watch this). */
  noteSemanticEvent(step: number): void {
    this.#lastSemanticStep = step;
    if (step > this.#lastActiveStep) this.#lastActiveStep = step;
  }

  /** Anything moving at or above `V_ACT` counts as the machine still working. */
  noteMotion(step: number): void {
    if (step > this.#lastActiveStep) this.#lastActiveStep = step;
  }

  noteContact(step: number, a: Id, b: Id): void {
    this.#recentContacts.push({ step, a, b });
  }

  noteTriggerEffect(step: number, trigger: Id, target: Id): void {
    this.#recentTriggerEffects.push({ step, trigger, target });
  }

  noteRemoved(): void {
    this.#removedCount++;
  }

  noteGoal(goal: Id, step: number): void {
    if (!this.#goalTimes.has(goal)) this.#goalTimes.set(goal, step);
  }

  /**
   * §10: ties go to the earlier step, then the smaller id. Both halves matter —
   * two identical marbles released together would otherwise report whichever
   * the body registry happened to reach first.
   */
  noteSpeed(step: number, objId: Id, speed: number): void {
    if (speed < this.#maxSpeed) return;
    if (speed > this.#maxSpeed) {
      this.#maxSpeed = speed;
      this.#maxSpeedObj = objId;
      this.#maxSpeedStep = step;
      return;
    }
    if (this.#maxSpeedObj === null) {
      this.#maxSpeedObj = objId;
      this.#maxSpeedStep = step;
      return;
    }
    if (step < this.#maxSpeedStep) {
      this.#maxSpeedObj = objId;
      this.#maxSpeedStep = step;
      return;
    }
    if (step === this.#maxSpeedStep && compareIds(objId, this.#maxSpeedObj) < 0) {
      this.#maxSpeedObj = objId;
    }
  }

  /**
   * Drop window entries older than `CHAIN_WINDOW_STEPS`.
   *
   * Called once per step so the two tables stay O(window) rather than O(run) —
   * a 36 000-step hard-cap run with a busy domino field would otherwise keep
   * every contact it ever saw, and §11 would have to serialize all of them.
   */
  pruneWindows(step: number): void {
    const cutoff = step - SIM.CHAIN_WINDOW_STEPS;
    if (this.#recentContacts.length > 0 && (this.#recentContacts[0] as ContactRecord).step < cutoff) {
      this.#recentContacts = this.#recentContacts.filter((c) => c.step >= cutoff);
    }
    if (
      this.#recentTriggerEffects.length > 0 &&
      (this.#recentTriggerEffects[0] as TriggerEffectRecord).step < cutoff
    ) {
      this.#recentTriggerEffects = this.#recentTriggerEffects.filter((c) => c.step >= cutoff);
    }
  }

  /**
   * §10 attribution rule 1 — the most recent contact within the window with an
   * object that had already activated. Ties (same step) break to the smaller id.
   */
  contactCause(objId: Id, step: number): Id | null {
    const cutoff = step - SIM.CHAIN_WINDOW_STEPS;
    let best: { step: number; id: Id } | null = null;
    for (const contact of this.#recentContacts) {
      if (contact.step < cutoff || contact.step > step) continue;
      const other = contact.a === objId ? contact.b : contact.b === objId ? contact.a : null;
      if (other === null || other === objId) continue;
      const activated = this.#firstActivation.get(other);
      if (activated === undefined || activated > step) continue;
      if (best === null || contact.step > best.step || (contact.step === best.step && compareIds(other, best.id) < 0)) {
        best = { step: contact.step, id: other };
      }
    }
    return best === null ? null : best.id;
  }

  /** §10 attribution rule 2 — a trigger whose effect landed on this object. */
  triggerCause(objId: Id, step: number): Id | null {
    const cutoff = step - SIM.CHAIN_WINDOW_STEPS;
    let best: { step: number; id: Id } | null = null;
    for (const effect of this.#recentTriggerEffects) {
      if (effect.target !== objId || effect.step < cutoff || effect.step > step) continue;
      if (
        best === null ||
        effect.step > best.step ||
        (effect.step === best.step && compareIds(effect.trigger, best.id) < 0)
      ) {
        best = { step: effect.step, id: effect.trigger };
      }
    }
    return best === null ? null : best.id;
  }

  /**
   * Longest path in the attribution forest, in edges.
   *
   * Memoized depth-first from every node in id order. The forest can contain a
   * cycle only if two objects each caused the other's first activation, which
   * the "activated at step <= k" guard in rule 1 makes impossible — but the
   * visiting set is kept anyway, because a metric that hangs the worker on a
   * malformed graph is worse than one that under-reports.
   */
  longestChain(): number {
    const children = new Map<Id, Id[]>();
    for (const [from, to] of this.#edges) {
      const list = children.get(from);
      if (list === undefined) children.set(from, [to]);
      else list.push(to);
    }
    for (const list of children.values()) list.sort(compareIds);

    const depth = new Map<Id, number>();
    const visiting = new Set<Id>();
    const walk = (node: Id): number => {
      const cached = depth.get(node);
      if (cached !== undefined) return cached;
      if (visiting.has(node)) return 0;
      visiting.add(node);
      let best = 0;
      for (const child of children.get(node) ?? []) {
        const d = 1 + walk(child);
        if (d > best) best = d;
      }
      visiting.delete(node);
      depth.set(node, best);
      return best;
    };

    let longest = 0;
    const roots = [...children.keys()].sort(compareIds);
    for (const node of roots) {
      const d = walk(node);
      if (d > longest) longest = d;
    }
    return longest;
  }

  /** The §10 report. `activatable` is the id set, so the ratio is well defined. */
  report(stepIndex: number, activatable: readonly Id[], finalHash: string): AnalyticsReport {
    const activatableSet = new Set(activatable);
    const firstActivationSteps: Record<Id, number> = {};
    let objectsActivated = 0;
    for (const id of activatable) {
      const step = this.#firstActivation.get(id);
      if (step === undefined) continue;
      firstActivationSteps[id] = step;
      objectsActivated++;
    }
    // An activation recorded for something outside the set (a rope segment's
    // owning link, say) is not a machine part and must not inflate the ratio.
    for (const [id, step] of this.#firstActivation) {
      if (!activatableSet.has(id)) continue;
      firstActivationSteps[id] = step;
    }

    const goalTimes: Record<Id, number> = {};
    for (const [id, step] of [...this.#goalTimes].sort((x, y) => compareIds(x[0], y[0]))) {
      goalTimes[id] = step / 60;
    }

    const activatableCount = activatable.length;
    const longestChain = this.longestChain();
    const success = this.#goalTimes.size > 0;
    const a = activatableCount > 0 ? objectsActivated / activatableCount : 0;
    const chainDenominator = activatableCount - 1 > 3 ? activatableCount - 1 : 3;
    const chainTerm = longestChain / chainDenominator;
    const score = 0.45 * a + 0.35 * (chainTerm > 1 ? 1 : chainTerm) + 0.2 * (success ? 1 : 0);

    const report: AnalyticsReport = {
      simEndS: stepIndex / 60,
      durationS: this.#lastActiveStep / 60,
      objectsActivated,
      activatableCount,
      firstActivationSteps,
      chainReactions: this.#edges.length,
      longestChain,
      maxSpeedMS: this.#maxSpeed,
      success,
      goalTimes,
      removedCount: this.#removedCount,
      efficiencyScore: Math.round(100 * score),
      finalHash,
    };
    if (this.#maxSpeedObj !== null) report.maxSpeedObj = this.#maxSpeedObj;
    return report;
  }

  save(): AnalyticsSnapshot {
    return {
      firstActivation: [...this.#firstActivation],
      causes: [...this.#causes],
      edges: this.#edges.map(([from, to]): [Id, Id] => [from, to]),
      maxSpeed: this.#maxSpeed,
      maxSpeedObj: this.#maxSpeedObj,
      maxSpeedStep: this.#maxSpeedStep,
      goalTimes: [...this.#goalTimes],
      removedCount: this.#removedCount,
      lastActiveStep: this.#lastActiveStep,
      lastSemanticStep: this.#lastSemanticStep,
      recentContacts: this.#recentContacts.map((c) => ({ ...c })),
      recentTriggerEffects: this.#recentTriggerEffects.map((c) => ({ ...c })),
    };
  }

  restore(s: AnalyticsSnapshot): void {
    this.#firstActivation = new Map(s.firstActivation);
    this.#causes = new Map(s.causes);
    this.#edges = s.edges.map(([from, to]): [Id, Id] => [from, to]);
    this.#maxSpeed = s.maxSpeed;
    this.#maxSpeedObj = s.maxSpeedObj;
    this.#maxSpeedStep = s.maxSpeedStep;
    this.#goalTimes = new Map(s.goalTimes);
    this.#removedCount = s.removedCount;
    this.#lastActiveStep = s.lastActiveStep;
    this.#lastSemanticStep = s.lastSemanticStep;
    this.#recentContacts = s.recentContacts.map((c) => ({ ...c }));
    this.#recentTriggerEffects = s.recentTriggerEffects.map((c) => ({ ...c }));
  }
}
