/**
 * Snapshot and reset — 03 §11.
 *
 * The rule §11 states is absolute: **every stateful thing outside Rapier lives
 * in `ExtraState`.** Runtime state kept anywhere else is not a bug that shows up
 * as a wrong number; it is a bug that shows up as "reset produced a different
 * run than load did", six hundred steps later, on one platform. So this file is
 * the checklist, and the shape below is what `step.ts` is held to.
 *
 * The same bundle format is what server-side replay verification (D17, 08 §5)
 * and any future rewind point would operate on — all three are the same
 * question, `(scene, engineVersion, commandLog, SnapshotBundle?)`.
 *
 * Contract: docs/03-SIMULATION-CORE.md §11.
 */

import type { Id } from '@physics/scene-format';
import type { FinishReason, SimCommand } from '../protocol.js';
import type { AnalyticsSnapshot } from './analytics.js';
import type { Pcg32State } from './rng.js';

/** One entry of the DET-8 command log: a run is `(scene, engineVersion, this)`. */
export interface LoggedCommand {
  /** Step boundary the command took effect at. */
  step: number;
  command: SimCommand;
}

/**
 * A trigger effect queued by step `k` for application at the start of `k + 1`
 * (DET-9's two-phase rule). Queued in the order §9.3 fixes: by source trigger
 * id, then by position in that trigger's `targets` array — the one place a
 * scene author controls effect order.
 */
export interface PendingEffect {
  trigger: Id;
  target: Id;
}

/**
 * The §9.2 `idle` window's reference frame.
 *
 * §9.2 asks for "no dynamic body ... moved > 1e-4 m" for five seconds straight.
 * Measured against a *reference pose* captured when the window opened, not
 * against the previous step: a body creeping a micrometre per step would satisfy
 * a per-step test forever while visibly sliding across the board. Recorded at
 * P2b (03 §15).
 */
export interface IdleAnchor {
  /** Step the current quiet window opened at. */
  step: number;
  /** `x, y` per registry slot at that step. */
  positions: number[];
}

/** Everything outside the Rapier world that a run depends on (§11). */
export interface ExtraState {
  stepIndex: number;
  rng: Pcg32State;
  /** Currently-active fields and belts (02 §5.4 activation effects). */
  activeFans: Id[];
  activeMagnets: Id[];
  activeConveyors: Id[];
  /** Live motor speeds, rad/s — a toggled gear holds 0 here, not its file value. */
  gearSpeeds: [Id, number][];
  axleSpeeds: [Id, number][];
  /** `triggered` pistons that have latched extended, and springs that fired. */
  pistonLatched: Id[];
  springReleased: Id[];
  /** Triggers that have fired at least once (`once: true` reads this). */
  triggersFired: Id[];
  /** Effects observed at step k-1, due at the start of step k (DET-9). */
  pending: PendingEffect[];
  analytics: AnalyticsSnapshot;
  commandLog: LoggedCommand[];
  idle: IdleAnchor;
  /** Set once the run has finished; `reset` is the only way back (§9.2). */
  finished: FinishReason | null;
}

/**
 * `{ rapier, extra }` — the pair §11 defines.
 *
 * Rapier's half is opaque bytes from `world.takeSnapshot()`; ours is plain data.
 * Neither is meaningful without the other, which is why they travel together.
 */
export interface SnapshotBundle {
  rapier: Uint8Array;
  extra: ExtraState;
}
