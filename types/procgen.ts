/**
 * Procedural generation — TypeScript definitions.
 *
 * Normative source: 06-PROCGEN.md. This file mirrors it for compile-time safety
 * in the `procgen` package (generator, checker, Generate dialog) and the CI
 * harness. Compile-tied to `types/scene.ts` (catalog), `types/protocol.ts`
 * (engine constants + AnalyticsReport), and `types/editor.ts` (skin names).
 *
 * Determinism: generation is a pure function of (procgenVersion, resolved
 * GenParams). Same version + params ⇒ byte-identical scene JSON (06 §3).
 */

import { LIMITS } from './scene';
import type { Id, ObjectType } from './scene';
import { SIM } from './protocol';
import type { AnalyticsReport } from './protocol';
import type { SkinName } from './editor';

/**
 * Semver of the generator. Scope of reproducibility promises (06 §3, PG-5):
 * any change to templates, weights, constants, or sampling order bumps it.
 */
export const PROCGEN_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Type-level assertion helpers (project pattern: proofs that name the culprit)
// ---------------------------------------------------------------------------

type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// ---------------------------------------------------------------------------
// Parameters (06 §2) — the brief's nine knobs
// ---------------------------------------------------------------------------

/** All fields the Generate dialog collects. `allowedTypes` omitted = all. */
export interface GenParams {
  /** uint32. Copied into `world.seed` of the emitted scene (provenance). */
  seed: number;
  /** Target run length, seconds. Becomes `meta.durationHint` + gate G3. */
  durationS: number;
  /** Target total object count (gate G6, ±20%). Includes structure. */
  objectCount: number;
  /** Catalog types the generator may use. Default: all 18. */
  allowedTypes?: readonly ObjectType[];
  /** 0–1. Unlocks stage tiers, tightens hand-off margins, adds wiring (06 §9.1). */
  difficulty: number;
  /** Degrees. Copied to `world.planeAngle`; layout happens in the gravity frame (06 §7.1). */
  planeAngle: number;
  theme: ThemeName;
  /** 0–1. Widens sampling distributions — never adds nondeterminism (06 §9.2, PG-4). */
  chaos: number;
  /** Desired number of major cascades (attribution trees with ≥ 3 edges), gate G4. */
  chains: number;
}

export type ResolvedGenParams = Required<GenParams>;

export const GEN_DEFAULTS: Omit<ResolvedGenParams, 'seed' | 'allowedTypes'> = {
  durationS: 30,
  objectCount: 60,
  difficulty: 0.5,
  planeAngle: 0,
  theme: 'workshop',
  chaos: 0.3,
  chains: 1,
} as const;

/**
 * Dialog + validation ranges. Value-tied to the format/engine limits:
 * duration ≤ half the engine hard cap (the checker simulates up to 2× target,
 * 06 §8.4), count ≤ the document object limit.
 */
export const GEN_RANGES = {
  durationS: [3, SIM.HARD_CAP_S / 2],
  objectCount: [8, LIMITS.maxObjects],
  difficulty: [0, 1],
  planeAngle: [-45, 45],
  chaos: [0, 1],
  chains: [1, 3],
} as const;

/** Types the layout cannot do without — excluding them is E_PROCGEN_PARAMS (06 §2). */
export const REQUIRED_TYPES = ['platform'] as const satisfies readonly ObjectType[];

/**
 * Catalog types the v1 stage library deliberately does not use: gear motor
 * dynamics are unverified (U10) and gears cannot start OFF and be toggled ON
 * (02 §5.4 toggle is `motorSpeed ↔ 0` from a file value that starts applied).
 * Revisit when U10 resolves.
 */
export const PROCGEN_EXCLUDED_TYPES = ['gear'] as const satisfies readonly ObjectType[];

// ---------------------------------------------------------------------------
// Batons and stages (06 §5–6) — the composition grammar
// ---------------------------------------------------------------------------

/**
 * What carries the chain from one stage to the next (06 §5.1):
 * roll — body arrives rolling along a surface; fall — body arrives ballistic;
 * tip — toppling body strikes at height; push — lateral shove at floor level;
 * signal — trigger activation (a wire, not a body).
 */
export type BatonKind = 'roll' | 'fall' | 'tip' | 'push' | 'signal';

export type StageKind =
  | 'rampRoll'
  | 'curveChannel'
  | 'dominoRun'
  | 'dominoFork'
  | 'marbleDrop'
  | 'weightDrop'
  | 'leverLaunch'
  | 'springKicker'
  | 'pendulumStrike'
  | 'conveyorCarry'
  | 'pulleyGate'
  | 'pistonPunch'
  | 'fanCarry'
  | 'magnetSnap'
  | 'triggerWire'
  | 'timedPistonStart'
  | 'crashTopple'
  | 'goalCatch';

/** Difficulty tier t is in the pool iff difficulty ≥ TIER_UNLOCK[t] (06 §9.1). */
export const TIER_UNLOCK = [0, 0.25, 0.5, 0.75] as const;

export interface StageDescriptor {
  /** Difficulty tier (index into TIER_UNLOCK). */
  tier: 0 | 1 | 2 | 3;
  /** Catalog types this stage's expansion may place (coverage proof below). */
  uses: readonly ObjectType[];
  /** Baton kinds this stage can receive. Empty = root-only (canStart must be true). */
  accepts: readonly BatonKind[];
  /** Baton kind it hands to the next stage; null = terminal stage. */
  emits: BatonKind | null;
  /** May serve as a lane's self-starting root stage (06 §6.2). */
  canStart: boolean;
  /** 2 = splits the lane (dominoFork). Absent = 1. */
  fanout?: 2;
  /** Object-count envelope [min, max] one instance places (excl. shared shelves). */
  objects: readonly [number, number];
  /** Duration envelope [min, max] seconds at catalog-range sizing. */
  durationS: readonly [number, number];
  /** Marginal seconds per added object when stretching (0 = stretch via props). */
  stretchSPerObject: number;
}

/**
 * The v1 stage library (06 §6 — normative footprints, ports, sentinels there).
 * Duration envelopes for dominoRun/rampRoll/curveChannel derive from the
 * calibrated models in PROCGEN below (spike, 06 §12).
 */
export const STAGE_LIBRARY = {
  rampRoll: {
    tier: 0,
    uses: ['ramp', 'marble'],
    accepts: ['roll', 'fall'],
    emits: 'roll',
    canStart: true,
    objects: [1, 2],
    durationS: [0.4, 1.2],
    stretchSPerObject: 0,
  },
  curveChannel: {
    tier: 0,
    uses: ['curve'],
    accepts: ['roll', 'fall'],
    emits: 'roll',
    canStart: false,
    objects: [1, 3],
    durationS: [0.3, 1.8],
    stretchSPerObject: 0.5,
  },
  dominoRun: {
    tier: 0,
    uses: ['domino'],
    accepts: ['tip', 'push', 'roll', 'fall'],
    emits: 'tip',
    canStart: true,
    objects: [5, 80],
    durationS: [0.4, 7],
    stretchSPerObject: 0.085,
  },
  dominoFork: {
    tier: 2,
    uses: ['domino'],
    accepts: ['tip'],
    emits: 'tip',
    canStart: false,
    fanout: 2,
    objects: [7, 15],
    durationS: [0.5, 1.2],
    stretchSPerObject: 0.085,
  },
  marbleDrop: {
    tier: 0,
    uses: ['platform', 'marble'],
    accepts: ['tip', 'push'],
    emits: 'fall',
    canStart: false,
    objects: [1, 2],
    durationS: [0.2, 0.8],
    stretchSPerObject: 0,
  },
  weightDrop: {
    tier: 1,
    uses: ['platform', 'crate'],
    accepts: ['tip', 'push'],
    emits: 'fall',
    canStart: false,
    objects: [1, 2],
    durationS: [0.2, 0.8],
    stretchSPerObject: 0,
  },
  leverLaunch: {
    tier: 1,
    uses: ['lever', 'marble', 'crate'],
    accepts: ['fall'],
    emits: 'fall',
    canStart: false,
    objects: [2, 3],
    durationS: [0.3, 0.9],
    stretchSPerObject: 0,
  },
  springKicker: {
    tier: 1,
    uses: ['spring', 'marble'],
    accepts: ['fall', 'roll', 'signal'],
    emits: 'fall',
    canStart: false,
    objects: [1, 2],
    durationS: [0.2, 0.7],
    stretchSPerObject: 0,
  },
  pendulumStrike: {
    tier: 1,
    uses: ['pendulum'],
    accepts: ['push', 'tip', 'fall'],
    emits: 'push',
    canStart: true,
    objects: [1, 1],
    durationS: [0.25, 1.2],
    stretchSPerObject: 0,
  },
  conveyorCarry: {
    tier: 1,
    uses: ['conveyor'],
    accepts: ['fall', 'roll', 'signal'],
    emits: 'fall',
    canStart: false,
    objects: [1, 2],
    durationS: [0.5, 20],
    stretchSPerObject: 0,
  },
  pulleyGate: {
    tier: 2,
    uses: ['pulley', 'crate', 'plank', 'marble', 'ramp'],
    accepts: ['fall'],
    emits: 'roll',
    canStart: false,
    objects: [4, 6],
    durationS: [0.4, 1.5],
    stretchSPerObject: 0,
  },
  pistonPunch: {
    tier: 2,
    uses: ['piston', 'crate', 'marble'],
    accepts: ['signal'],
    emits: 'push',
    canStart: false,
    objects: [2, 3],
    durationS: [0.2, 0.8],
    stretchSPerObject: 0,
  },
  fanCarry: {
    tier: 3,
    uses: ['fan', 'marble'],
    accepts: ['signal', 'roll'],
    emits: 'roll',
    canStart: false,
    objects: [1, 2],
    durationS: [0.5, 6],
    stretchSPerObject: 0,
  },
  magnetSnap: {
    tier: 3,
    uses: ['magnet', 'crate'],
    accepts: ['signal'],
    emits: 'push',
    canStart: false,
    objects: [2, 3],
    durationS: [0.2, 0.8],
    stretchSPerObject: 0,
  },
  triggerWire: {
    tier: 2,
    uses: ['trigger'],
    accepts: ['roll', 'fall', 'tip', 'push'],
    emits: 'signal',
    canStart: false,
    objects: [1, 1],
    durationS: [0, 0.1],
    stretchSPerObject: 0,
  },
  timedPistonStart: {
    tier: 2,
    uses: ['piston', 'crate', 'marble'],
    accepts: [],
    emits: 'push',
    canStart: true,
    objects: [2, 3],
    durationS: [0.3, 0.8],
    stretchSPerObject: 0,
  },
  crashTopple: {
    tier: 1,
    uses: ['crate', 'plank'],
    accepts: ['push', 'tip', 'fall', 'roll'],
    emits: null,
    canStart: false,
    objects: [3, 12],
    durationS: [0.5, 2],
    stretchSPerObject: 0.15,
  },
  goalCatch: {
    tier: 0,
    uses: ['goal', 'platform'],
    accepts: ['roll', 'fall', 'tip', 'push'],
    emits: null,
    canStart: false,
    objects: [1, 2],
    durationS: [0.1, 0.5],
    stretchSPerObject: 0,
  },
} as const satisfies Record<StageKind, StageDescriptor>;

/** Stages that may root a lane, derived from the library (proof below). */
export type StarterKind = {
  [K in StageKind]: (typeof STAGE_LIBRARY)[K]['canStart'] extends true ? K : never;
}[StageKind];
export const STARTER_KINDS = [
  'rampRoll',
  'dominoRun',
  'pendulumStrike',
  'timedPistonStart',
] as const;
type StarterMissing = Exclude<StarterKind, (typeof STARTER_KINDS)[number]>;
type StarterExtra = Exclude<(typeof STARTER_KINDS)[number], StarterKind>;
const _startersComplete: [StarterMissing] extends [never]
  ? true
  : ['STARTER_KINDS misses:', StarterMissing] = true;
const _startersSound: [StarterExtra] extends [never]
  ? true
  : ['STARTER_KINDS lists non-starter:', StarterExtra] = true;

/** Terminal stages (emit nothing). */
export type TerminalKind = {
  [K in StageKind]: (typeof STAGE_LIBRARY)[K]['emits'] extends null ? K : never;
}[StageKind];
const _terminalsExact: Eq<TerminalKind, 'crashTopple' | 'goalCatch'> = true;

/**
 * Coverage proof: every catalog type is either used by some stage or explicitly
 * excluded. Removing a type from the library without listing it in
 * PROCGEN_EXCLUDED_TYPES fails compilation naming the missing type.
 */
type UsedType = (typeof STAGE_LIBRARY)[StageKind]['uses'][number];
type UncoveredType = Exclude<ObjectType, UsedType | (typeof PROCGEN_EXCLUDED_TYPES)[number]>;
const _typeCoverage: [UncoveredType] extends [never]
  ? true
  : ['stage library misses catalog type:', UncoveredType] = true;

// ---------------------------------------------------------------------------
// Themes (06 §9.3) — visual + selection weights only, never physics
// ---------------------------------------------------------------------------

export type ThemeName = 'workshop' | 'candyland' | 'factory' | 'dominoHall' | 'spaceLab';

export interface ThemeSpec {
  /** Skin pool; the skin stream picks per object. Must be known editor skins. */
  skins: readonly SkinName[];
  /** Multiplicative stage-selection weights; kinds not listed weigh 1. */
  weights: Partial<Record<StageKind, number>>;
  /** Word pools for deterministic generated titles (06 §10.2). */
  titleAdjs: readonly string[];
  titleNouns: readonly string[];
}

export const THEMES = {
  workshop: {
    skins: ['wood', 'steel', 'brass'],
    weights: {},
    titleAdjs: ['Tidy', 'Rickety', 'Patient', 'Busy'],
    titleNouns: ['Workshop', 'Contraption', 'Cascade', 'Relay'],
  },
  candyland: {
    skins: ['candy', 'glass', 'neon'],
    weights: { curveChannel: 2, springKicker: 1.6, marbleDrop: 1.4, crashTopple: 0.6 },
    titleAdjs: ['Sugary', 'Bouncy', 'Swirly', 'Glossy'],
    titleNouns: ['Gumball Run', 'Sprinkle Chute', 'Taffy Twist', 'Candy Cascade'],
  },
  factory: {
    skins: ['steel', 'rubber', 'stone'],
    weights: { conveyorCarry: 2.2, pistonPunch: 1.8, weightDrop: 1.4, triggerWire: 1.3, curveChannel: 0.6 },
    titleAdjs: ['Automated', 'Heavy', 'Punctual', 'Relentless'],
    titleNouns: ['Assembly Line', 'Dispatch', 'Press Floor', 'Freight Run'],
  },
  dominoHall: {
    skins: ['wood', 'stone', 'candy'],
    weights: { dominoRun: 2.5, dominoFork: 1.8, marbleDrop: 1.2, conveyorCarry: 0.5, fanCarry: 0.5 },
    titleAdjs: ['Grand', 'Endless', 'Tumbling', 'Echoing'],
    titleNouns: ['Domino Hall', 'Topple Gallery', 'Falling Court', 'Click Parade'],
  },
  spaceLab: {
    skins: ['neon', 'glass', 'steel'],
    weights: { fanCarry: 2, magnetSnap: 2, springKicker: 1.3, dominoRun: 0.7 },
    titleAdjs: ['Orbital', 'Quiet', 'Low-G', 'Humming'],
    titleNouns: ['Lab Loop', 'Field Test', 'Drift Chamber', 'Relay Array'],
  },
} as const satisfies Record<ThemeName, ThemeSpec>;

// ---------------------------------------------------------------------------
// Plan IR (06 §6.4) — what the planner hands to layout and the checker
// ---------------------------------------------------------------------------

export interface PlannedStage {
  kind: StageKind;
  /** Lane-local index (stage 0 is the lane's root). */
  idx: number;
  /** Baton received from the previous stage; null for roots. */
  inBaton: BatonKind | null;
  estDurationS: number;
  /** Filled by layout: ids of the objects this stage placed. */
  objectIds: readonly Id[];
  /** The object whose activation proves the stage ran (gate G4b, 06 §8.3). */
  sentinel: Id;
}

export interface Lane {
  stages: readonly PlannedStage[];
  /** 0 for lane 0; later lanes may start delayed (timedPistonStart), 06 §6.3. */
  startDelayS: number;
  /** Exactly one lane carries the goalCatch terminal. */
  carriesGoal: boolean;
}

export interface GenPlan {
  lanes: readonly Lane[];
  /** Ids expected to be attribution roots (starters + step-0-active fields). */
  expectedRoots: readonly Id[];
  estDurationS: number;
  estObjects: number;
}

// ---------------------------------------------------------------------------
// Self-check gates & report (06 §8)
// ---------------------------------------------------------------------------

export type GateId =
  | 'G1_valid'
  | 'G2_success'
  | 'G3_duration'
  | 'G4_chains'
  | 'G5_activation'
  | 'G6_count';

export interface GateResult {
  pass: boolean;
  /** Human-readable finding, builder-panel style. */
  detail: string;
  /** Signed miss distance in the gate's unit (s, count, fraction) when scalar. */
  delta?: number;
}

export type ProcgenErrorCode = 'E_PROCGEN_PARAMS' | 'E_PROCGEN_INTERNAL';

export interface GenReport {
  procgenVersion: string;
  engineVersion: string;
  /** Params after defaulting/clamping — the reproducibility key with the version pair. */
  params: ResolvedGenParams;
  /** satisfied = all gates pass; closest = budget exhausted, best candidate returned. */
  outcome: 'satisfied' | 'closest' | 'error';
  gates: Record<GateId, GateResult>;
  candidatesTried: number;
  repairsUsed: number;
  /** Total simulated steps across all check runs (budget accounting, 06 §8.4). */
  simStepsTotal: number;
  /** Analytics of the returned candidate's check run. */
  analytics?: AnalyticsReport;
  /** Attribution trees with ≥ MAJOR_CHAIN_MIN_EDGES edges, rebuilt from events. */
  majorChains?: number;
  objectsTotal: number;
  linksTotal: number;
  error?: { code: ProcgenErrorCode; message: string };
}

// ---------------------------------------------------------------------------
// Constants (06 — search budgets, tolerances, calibrated models)
// ---------------------------------------------------------------------------

export const PROCGEN = {
  /** Candidate seeds tried before returning the closest miss (06 §8.4). */
  CANDIDATES_MAX: 6,
  /** Targeted repair rounds per candidate (06 §8.5). */
  REPAIR_ROUNDS_MAX: 2,
  /** Plan-time template re-samples: per hand-off slot, and total per candidate (06 §7.4). */
  BACKTRACK_PER_SLOT: 8,
  PLAN_ATTEMPTS_MAX: 40,
  /** A check run simulates at most this × target duration (ties GEN_RANGES to HARD_CAP_S). */
  SIM_FACTOR_CAP: 2,

  /** Gate G3: |duration − target| ≤ max(abs, frac·target). */
  DURATION_TOL_S: 2,
  DURATION_TOL_FRAC: 0.15,
  /** Gate G6: |objects − target| ≤ frac·target. */
  COUNT_TOL_FRAC: 0.2,
  /** Gate G5: activated / activatable ≥ this. */
  ACTIVATION_MIN_FRAC: 0.85,
  /** Gate G4: a tree counts as a major cascade at ≥ this many edges. */
  MAJOR_CHAIN_MIN_EDGES: 3,

  /** Lane start delays: cap (piston period ≤ 60 s ⇒ delay = period/2 ≤ 30). */
  MAX_STARTER_DELAY_S: 30,
  /** Anti-idle overlap: any activity gap must stay ≤ IDLE_WINDOW_S − this (06 §6.3). */
  IDLE_OVERLAP_MARGIN_S: 1,

  /** Base hand-off catch margin, meters; difficulty/chaos scale it (06 §7.3, §9). */
  HANDOFF_MARGIN_BASE_M: 0.05,
  /** Chaos jitter never exceeds this fraction of the local margin (PG-4). */
  CHAOS_JITTER_MAX_FRAC: 0.5,

  // --- calibrated estimate models (spike 2026-07-20, rapier2d-deterministic-compat
  // 0.19.3, darwin-arm64, mini-expansion — recalibrate on SimCore at first
  // implementation: U16). The self-check loop, not these numbers, is the truth.
  /** Ramp exit speed: v = K · sqrt(4·g·Δy/3) (rolling disc − losses). */
  K_RAMP_EXIT: 0.92,
  /** Domino front speed = K(s/h) · sqrt(g·h); measured at h 0.05–0.12. */
  DOMINO_FRONT_K: { 0.5: 0.849, 0.6: 0.83, 0.75: 0.797, 0.9: 0.717 },
  /** Above this domino height the front-speed model breaks (measured at 0.20). */
  DOMINO_RUN_MAX_H_M: 0.15,
  /** Starter kick: ω °/s; v_com = (−ω·h/2, |ω|·w/2) rad-consistent (06 §6.2). */
  DOMINO_KICK_DEGS: 350,
  /** Flat runout keeps rolling speed (measured 100%/m) — flats add time, never brake. */
  RUNOUT_SPEED_RETENTION: 1.0,
} as const;

/**
 * PCG32 (PCG-XSH-RR 64/32, reference constants) with seed 42, stream 54 —
 * first six outputs. The first three match the published pcg32-demo prefix;
 * CI must reproduce all six (06 §11). Generator seeding/stream scheme: 06 §3.
 */
export const PCG32_TEST_VECTOR = [
  0xa15c02b7, 0x7b47f409, 0xba1d3330, 0x83d2f293, 0xbfa4784b, 0xcbed606e,
] as const;
