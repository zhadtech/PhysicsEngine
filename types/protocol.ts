/**
 * Simulation worker protocol — TypeScript definitions.
 *
 * Normative source: 03-SIMULATION-CORE.md (§4 pipeline, §5 protocol/transport,
 * §9 lifecycle, §10 analytics). This file mirrors it for compile-time safety on
 * both sides of the worker boundary (UI shell ↔ engine worker) and for the Node
 * replay/CI harness. Lives in the `engine` package's public surface.
 *
 * Angle convention: the FILE format uses degrees (02 §2); everything past the
 * load boundary — including this protocol and the shared buffer — uses RADIANS.
 */

import type { Id, Scene } from './scene';

export const PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Engine constants (03 — single source; changing any is an engineVersion bump)
// ---------------------------------------------------------------------------

export const SIM = {
  /** Fixed timestep, seconds (DET-1). */
  DT: 1 / 60,
  /** Hard run cap, seconds (§9.2). */
  HARD_CAP_S: 600,
  /** Max sim steps per worker wake — overload becomes slow-motion (§5.5). */
  MAX_CATCHUP_STEPS: 5,
  /** Off-board removal sweep cadence, steps (DET-10). */
  REMOVAL_SWEEP_STEPS: 15,
  /** Bounds inflation for removal, meters each side (DET-10). */
  REMOVAL_MARGIN_M: 2,
  /** Expanded dynamic-body hard cap — E_LIMITS at load (§5.4). */
  MAX_DYNAMIC_BODIES: 8000,
  /** Gauss-Seidel passes for gearMesh + pulley ropes (§8). */
  CUSTOM_SOLVER_ITERATIONS: 8,
  /** Field wake-up factor: wake sleeping body iff |F| ≥ factor·m·max(g, 0.7) (§7). */
  FIELD_WAKE_FACTOR: 0.7,
  /** Magnet inverse-square reference/clamp distance, meters (§7.2). */
  MAGNET_REF_DIST: 0.05,
  /** Conveyor belt grip limit, m/s² (§7.3). */
  CONVEYOR_MAX_ACCEL: 10,
  /** Pulley-rope Baumgarte factor and slop, meters (§8.2). */
  ROPE_BIAS_BETA: 0.2,
  ROPE_SLOP: 0.001,
  /** Activation thresholds (§10): linear m/s, angular rad/s (10 °/s). */
  V_ACT: 0.05,
  W_ACT: (10 * Math.PI) / 180,
  /** Chain-attribution lookback, steps (§10). */
  CHAIN_WINDOW_STEPS: 15,
  /** Idle finish window, seconds (§9.2). */
  IDLE_WINDOW_S: 5,
  /** Max collision/SFX events per batch — semantic events are never dropped (§5.3). */
  MAX_SFX_EVENTS_PER_BATCH: 256,
} as const;

// ---------------------------------------------------------------------------
// Shared-buffer layout (§5.4) — primary transport when crossOriginIsolated
// ---------------------------------------------------------------------------

export const SAB = {
  /** "SIM1" */
  MAGIC: 0x53494d31,
  LAYOUT_VERSION: 1,
  /** Int32 header words. */
  HEADER_WORDS: 12,
  /** Triple buffer: writer targets (c+1)%3, readers hold c%3 and (c−1)%3. */
  SLOTS: 3,
  /** Per body: x, y, rot (radians), state. */
  FLOATS_PER_BODY: 4,
} as const;

/** Int32 header indices. */
export const enum SabHeader {
  Magic = 0,
  LayoutVersion = 1,
  BodyCount = 2,
  WriteCounter = 3,
  LatestStepIndex = 4,
  SimStatus = 5,
  Flags = 6,
  // 7 reserved
  SlotStepIndex0 = 8,
  SlotStepIndex1 = 9,
  SlotStepIndex2 = 10,
  // 11 reserved
}

/** Value of the per-body `state` float. */
export const enum BodyState {
  Asleep = 0,
  Awake = 1,
  Removed = 2,
}

/** SimStatus header word (§5.1 lifecycle). */
export const enum SimStatus {
  Idle = 0,
  Loading = 1,
  Ready = 2,
  Running = 3,
  Paused = 4,
  Finished = 5,
  Errored = 6,
}

export function sabByteLength(bodyCount: number): number {
  return SAB.HEADER_WORDS * 4 + SAB.SLOTS * bodyCount * SAB.FLOATS_PER_BODY * 4;
}

// ---------------------------------------------------------------------------
// Body registry (§5.3): buffer slot index → (object, piece)
// ---------------------------------------------------------------------------

/**
 * Dynamic render pieces a prefab can expand to (§6). Static geometry has no
 * slots — the renderer derives it from the scene document via the shared
 * expansion-geometry module.
 */
export type BodyPiece =
  | 'main'
  | 'bob' // pendulum (arm: "rope")
  | 'plate' // spring
  | 'head' // piston
  | `seg${number}`; // segmented rope links

export interface BodyRegistryEntry {
  objId: Id;
  piece: BodyPiece;
}

// ---------------------------------------------------------------------------
// Commands (UI → worker, §5.2) — every command is acked
// ---------------------------------------------------------------------------

export type PlaybackSpeed = 0.25 | 0.5 | 1 | 2 | 4;

interface CmdBase<T extends string> {
  /** u32, monotonic per session; worker acks each seq (DET-8 command log). */
  seq: number;
  cmd: T;
}

export interface LoadCommand extends CmdBase<'load'> {
  scene: Scene;
}
export type PlayCommand = CmdBase<'play'>;
export type PauseCommand = CmdBase<'pause'>;
export interface StepNCommand extends CmdBase<'stepN'> {
  /** 1–600; only valid while paused. */
  n: number;
}
export interface SetSpeedCommand extends CmdBase<'setSpeed'> {
  speed: PlaybackSpeed;
}
export type StopCommand = CmdBase<'stop'>;
export type ResetCommand = CmdBase<'reset'>;
export type ShutdownCommand = CmdBase<'shutdown'>;

export type SimCommand =
  | LoadCommand
  | PlayCommand
  | PauseCommand
  | StepNCommand
  | SetSpeedCommand
  | StopCommand
  | ResetCommand
  | ShutdownCommand;

// ---------------------------------------------------------------------------
// Events (worker → UI, batched per publish, §5.3)
// ---------------------------------------------------------------------------

interface EvBase<K extends string> {
  kind: K;
  /** Step at which the event was observed. */
  step: number;
}

/** Contact worth sound/particles; capped per batch, highest impulse first. */
export interface CollisionEvent extends EvBase<'collision'> {
  a: Id;
  b: Id;
  /** N·s. */
  impulse: number;
}

export type ActivationCause =
  | { via: 'contact'; from: Id }
  | { via: 'trigger'; from: Id }
  | { via: 'field'; from: Id }
  /** O is a trigger/goal; `from` = owner of the body that entered it (03 §10 rule 0). */
  | { via: 'sensor'; from: Id };

export interface ActivationEvent extends EvBase<'activation'> {
  obj: Id;
  /** Absent for step-0 roots (§10 attribution). */
  cause?: ActivationCause;
}

export interface TriggerFiredEvent extends EvBase<'triggerFired'> {
  trigger: Id;
  /** Object whose body entered. */
  by: Id;
}

export interface GoalReachedEvent extends EvBase<'goalReached'> {
  goal: Id;
  by: Id;
}

/** Fell off the table (DET-10) — renderer hides the piece. */
export interface RemovedEvent extends EvBase<'removed'> {
  obj: Id;
  piece: BodyPiece;
}

/** Actuator state change (trigger effects, 02 §5.4) — for UI status icons. */
export interface ActuatorEvent extends EvBase<'actuator'> {
  obj: Id;
  active: boolean;
}

export type SimEvent =
  | CollisionEvent
  | ActivationEvent
  | TriggerFiredEvent
  | GoalReachedEvent
  | RemovedEvent
  | ActuatorEvent;

// ---------------------------------------------------------------------------
// Analytics report (§10)
// ---------------------------------------------------------------------------

export type FinishReason = 'stopped' | 'hardCap' | 'quiescent' | 'idle';

export interface AnalyticsReport {
  /** stepIndex/60 at finish. */
  simEndS: number;
  /** Last step anything meaningful moved or fired, /60. */
  durationS: number;
  objectsActivated: number;
  activatableCount: number;
  /** objId → first activation step (UI timeline). */
  firstActivationSteps: Record<Id, number>;
  /** Edges in the attribution forest. */
  chainReactions: number;
  /** Longest path (edges) in the forest. */
  longestChain: number;
  maxSpeedMS: number;
  /** Absent when nothing ever moved. */
  maxSpeedObj?: Id;
  success: boolean;
  /** goalId → first satisfaction, seconds. */
  goalTimes: Record<Id, number>;
  removedCount: number;
  /** 0–100 (§10 formula; engineVersion-scoped). */
  efficiencyScore: number;
  /** FNV-1a 32 state hash at finish (§12), hex — for replay verification. */
  finalHash: string;
}

// ---------------------------------------------------------------------------
// Messages (worker → UI, §5.3)
// ---------------------------------------------------------------------------

export type TransportKind = 'sab' | 'postmessage';

export type SimErrorCode =
  | 'E_SCHEMA'
  | 'E_SEMANTIC'
  | 'E_LIMITS'
  | 'E_SCHEMA_NEWER'
  | 'E_INTERNAL';

/** Non-fatal expansion diagnostics (§9.1). */
export interface LoadWarning {
  code:
    | 'W_LEVER_ROT_OUTSIDE_LIMITS'
    | 'W_ROPE_VIA_SEGMENTS_CONFLICT'
    | 'W_AXLE_ANCHOR_MISMATCH'
    | 'W_ROPE_STARTS_VIOLATED';
  /** Object or link the warning is about. */
  id: Id;
  message: string;
}

export interface ReadyMsg {
  type: 'ready';
  protocolVersion: typeof PROTOCOL_VERSION;
  /** Semver of the engine package — determinism scope (ADR-0005 rule 4). */
  engineVersion: string;
  /** Exact pinned physics build, e.g. "@dimforge/rapier2d-deterministic-compat@0.19.3". */
  physicsBuild: string;
  transport: TransportKind;
}

export interface LoadedMsg {
  type: 'loaded';
  /** Dynamic bodies only; index into the registry = buffer slot. */
  bodyCount: number;
  registry: BodyRegistryEntry[];
  warnings: LoadWarning[];
  /** Present iff transport === "sab". */
  sab?: SharedArrayBuffer;
}

/** Fallback transport only: one frame, transferable (UI returns buffers to a pool). */
export interface FrameMsg {
  type: 'frame';
  stepIndex: number;
  /** bodyCount × FLOATS_PER_BODY floats, same per-body layout as the SAB slots. */
  transforms: Float32Array;
}

export interface EventsMsg {
  type: 'events';
  fromStep: number;
  toStep: number;
  events: SimEvent[];
}

export interface FinishedMsg {
  type: 'finished';
  reason: FinishReason;
  analytics: AnalyticsReport;
}

export interface ErrorMsg {
  type: 'error';
  code: SimErrorCode;
  message: string;
  detail?: string;
}

export interface AckMsg {
  type: 'ack';
  seq: number;
  ok: boolean;
  error?: string;
}

export type SimMessage =
  | ReadyMsg
  | LoadedMsg
  | FrameMsg
  | EventsMsg
  | FinishedMsg
  | ErrorMsg
  | AckMsg;
