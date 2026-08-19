/**
 * The render half of 09-PERFORMANCE.md, migrated out of `types/perf.ts` at P3b.
 *
 * Why only *half*. `types/perf.ts` was one file because M8 was one milestone,
 * but its constants belong to three different packages: the frame budget, the
 * device tiers and the draw-call ceiling are the renderer's (here), `READPATH`
 * is the backend's (P4) and `FAST_PREVIEW` is procgen's (P5). A package cannot
 * import a repo-root design file — `rootDir` is the package root and emit would
 * refuse it — so the alternative to moving this half was re-declaring it, and
 * two copies of a draw-call ceiling is how a ceiling stops being one. The other
 * two constants stay in `types/perf.ts` until their own phases move them, which
 * is why that file is a *partial* stub rather than the pure re-export
 * `types/editor.ts` became.
 *
 * The two compile ties that crossed the package boundary are kept, not dropped:
 *   - `SIM.MAX_DYNAMIC_BODIES` still ties `high`/`mid` here, through the real
 *     import (`@physics/engine/protocol`).
 *   - `VERIFY.BODY_BUDGET` ties `low` — 09 §7's "one number, two guarantees" —
 *     and `types/community.ts` is not reachable from this package, so the proof
 *     moved to the one file that can still see both sides (`types/perf.ts`)
 *     rather than being downgraded to a comment.
 *
 * The one load-bearing rule this file encodes, unchanged from M8: **performance
 * adaptation touches rendering only, never simulation.** Determinism (03) and
 * leaderboards (08, D17) depend on every machine computing the identical run, so
 * a tier may drop shadows, LOD and overlays but never change what SimCore steps.
 *
 * Contract: docs/09-PERFORMANCE.md §2, §4, §7.
 */

import type { ObjectType } from '@physics/scene-format';
import { SIM } from '@physics/engine/protocol';
import { SKIN_NAMES } from '../editor/model.js';

type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** Bumped whenever a budget/tier constant changes — perf regressions are diffed against it. */
export const PERF_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// § Frame budget (09 §2)
// ---------------------------------------------------------------------------

export const FRAME = {
  DISPLAY_HZ: 60,
  /** One display frame — and one worker sim step at 1× (they share the same clock). */
  BUDGET_MS: 1000 / 60,
  /** Degrade target under sustained pressure; below this the run is visibly janky. */
  FLOOR_HZ: 30,
  FLOOR_BUDGET_MS: 1000 / 30,
} as const;

/**
 * The sim worker and the render main thread each own a full BUDGET_MS and run in
 * parallel (01 §3.1). Transport between them is ~µs at the body cap (09 §5, P2),
 * so the worker's whole budget is `world.step`, and the split below governs only
 * the render thread. Fractions of BUDGET_MS; they sum to 1 by construction.
 */
export const RENDER_SPLIT = {
  /** Read the SAB interpolation pair + lerp all instance matrices (§4). */
  interpolate: 0.08,
  /** WebGL2 submit — the instanced draw calls dominate here (§4). */
  draw: 0.55,
  /** React/DOM: panels, HUD, timeline, event feed. */
  ui: 0.25,
  /** GC, input handling, jitter absorption. */
  headroom: 0.12,
} as const;

// ---------------------------------------------------------------------------
// § Device tiers (09 §7) — U12/U17. Vary render fidelity + authoring guidance,
// never the hard sim cap (which is universal for determinism).
// ---------------------------------------------------------------------------

export type TierId = 'high' | 'mid' | 'low';
export const TIER_IDS = ['high', 'mid', 'low'] as const;

export interface DeviceTier {
  /**
   * Soft authoring guidance for a comfortably smooth 1× run — NOT a hard cap.
   * The hard cap is SIM.MAX_DYNAMIC_BODIES on every tier (determinism). Because a
   * chain-reaction machine is mostly *asleep* at any instant (09 §3), a scene may
   * hold far more objects than this and still run smoothly; the number bounds the
   * simultaneously-active set, which is what actually costs (spike P1).
   */
  smoothBodyTarget: number;
  targetHz: 30 | 60;
  /** Contact shadows / soft shadows on the workshop light. */
  shadows: boolean;
  /** Fan cones and magnet radii rendered as translucent guides in test mode (04 §12.2). */
  fieldOverlays: boolean;
  /** 0 = box/billboard imposters only, 2 = full beveled meshes. */
  maxInstanceDetailLod: 0 | 1 | 2;
  /** Procedural generation uses the reduced fast-preview pass (U17). */
  procgenFastPreview: boolean;
}

/**
 * `low`'s target is the rankable ceiling — `VERIFY.BODY_BUDGET` (08 §5.5). The
 * literal is written here because `types/community.ts` is outside this package;
 * `types/perf.ts` carries the compile proof that the two numbers are the same
 * one, and `verify-web` part H re-checks it against the design file's text.
 */
const RANKABLE_BODY_BUDGET = 1500;

export const PERF_TIERS = {
  // high: the full engine cap; every render feature on.
  high: {
    smoothBodyTarget: SIM.MAX_DYNAMIC_BODIES,
    targetHz: 60,
    shadows: true,
    fieldOverlays: true,
    maxInstanceDetailLod: 2,
    procgenFastPreview: false,
  },
  // mid: half the cap authored smoothly; shadows off (the biggest fill cost).
  mid: {
    smoothBodyTarget: SIM.MAX_DYNAMIC_BODIES / 2,
    targetHz: 60,
    shadows: false,
    fieldOverlays: true,
    maxInstanceDetailLod: 1,
    procgenFastPreview: false,
  },
  // low: target = the rankable ceiling. A scene light enough to be leaderboard-
  // verified (08 §5.5) is exactly a scene light enough to stay smooth on weak
  // hardware — one number, two guarantees.
  low: {
    smoothBodyTarget: RANKABLE_BODY_BUDGET,
    targetHz: 30,
    shadows: false,
    fieldOverlays: false,
    maxInstanceDetailLod: 0,
    procgenFastPreview: true,
  },
} as const satisfies Record<TierId, DeviceTier>;

// Ordering high ≥ mid ≥ low holds by construction (8000 ≥ 4000 ≥ 1500), and
// every target ≤ the hard cap because high === the cap and the others divide it.

type TierMissing = Exclude<TierId, (typeof TIER_IDS)[number]>;
type TierExtra = Exclude<(typeof TIER_IDS)[number], TierId>;
const _tierComplete: [TierMissing] extends [never] ? true : ['TIER_IDS misses:', TierMissing] = true;
const _tierSound: [TierExtra] extends [never] ? true : ['TIER_IDS lists non-tier:', TierExtra] = true;

// ---------------------------------------------------------------------------
// § Rendering strategy (09 §4) — InstancedMesh per (type, skin)
// ---------------------------------------------------------------------------

/**
 * How each catalog type reaches the screen:
 *  - `instanced`: a unit convex mesh (box / sphere / disc) drawn once per
 *    (type, skin) via InstancedMesh, per-instance transform carrying position,
 *    rotation, and non-uniform scale. Object count inside a group is free.
 *  - `generated`: bespoke per-object geometry whose vertices differ per instance
 *    (ramp polygon, curve tessellation) — cannot share one instanced mesh; also
 *    covers per-link rope sag and belt ribbons (04 §12.1–12.2). Few per scene.
 *  - `overlay`: fields and sensors (fan/magnet/trigger/goal) + the pulley wheel —
 *    translucent guides, never part of the solid batch.
 */
export type RenderClass = 'instanced' | 'generated' | 'overlay';

export const RENDER_CLASS = {
  platform: 'instanced', // static box, per-instance scale
  ramp: 'generated',
  curve: 'generated',
  domino: 'instanced',
  marble: 'instanced',
  crate: 'instanced',
  plank: 'instanced',
  gear: 'instanced',
  lever: 'instanced',
  spring: 'instanced',
  pendulum: 'instanced',
  piston: 'instanced',
  conveyor: 'instanced',
  pulley: 'overlay',
  fan: 'overlay',
  magnet: 'overlay',
  trigger: 'overlay',
  goal: 'overlay',
} as const satisfies Record<ObjectType, RenderClass>;

/** The instanced types, as a tuple so its length is a compile-time literal. */
export const INSTANCED_TYPES = [
  'platform',
  'domino',
  'marble',
  'crate',
  'plank',
  'gear',
  'lever',
  'spring',
  'pendulum',
  'piston',
  'conveyor',
] as const;

// Proof that INSTANCED_TYPES is exactly the set RENDER_CLASS marks 'instanced'.
// Reclassify a type (or add a catalog type) without updating this tuple and
// compilation fails naming the offender.
type InstancedFromMap = {
  [K in ObjectType]: (typeof RENDER_CLASS)[K] extends 'instanced' ? K : never;
}[ObjectType];
type InstancedMissing = Exclude<InstancedFromMap, (typeof INSTANCED_TYPES)[number]>;
type InstancedExtra = Exclude<(typeof INSTANCED_TYPES)[number], InstancedFromMap>;
const _instancedComplete: [InstancedMissing] extends [never]
  ? true
  : ['INSTANCED_TYPES misses:', InstancedMissing] = true;
const _instancedSound: [InstancedExtra] extends [never]
  ? true
  : ['INSTANCED_TYPES lists non-instanced:', InstancedExtra] = true;

/**
 * Hard ceiling on instanced draw calls: (instanced types) × (skins). At most one
 * InstancedMesh per pair, and object count inside a pair is free — so a 5 000-
 * domino scene is a single draw call, and the busiest possible scene is bounded
 * by this constant, not by object count (spike P4). Generated geometry and
 * overlays add a handful more, still object-count-linear only in ramps/curves/links.
 */
export const MAX_INSTANCE_GROUPS = INSTANCED_TYPES.length * SKIN_NAMES.length;
const _groupCount: Eq<typeof MAX_INSTANCE_GROUPS, number> = true; // 11 × 8 = 88 at runtime

export const RENDER = {
  /** Below this many awake instances in a group, skip the InstancedMesh and draw individually (setup cost). */
  INSTANCE_MIN: 8,
  /** Dim + desaturate sleeping bodies so the eye reads "settled" (04 §12.2 sleep dimming). */
  SLEEP_DIM_FACTOR: 0.6,
  /**
   * The desaturation half of the same effect. 09 §4 gives the brightness factor
   * and 04 §10.3 gives the saturation ("`Asleep` desaturates ~15%"); they are two
   * channels of one treatment, not two numbers for one, so both are named here
   * rather than one silently standing in for the other (P3b, 09 §12).
   */
  SLEEP_DESATURATE: 0.15,
  /** Frustum-cull instances outside the workshop camera; distance-LOD past this (meters from camera target). */
  LOD_NEAR_M: 6,
  LOD_FAR_M: 18,
  /** Shadow map resolution on `high`; halved on `mid`, off on `low`. */
  SHADOW_MAP_PX: 2048,
  /**
   * How thick a 2D shape is drawn in the third dimension.
   *
   * D1's 2.5D split — physics in 2D, rendered with 3D visuals — means every box
   * and disc needs a depth that no spec supplies, because nothing physical
   * depends on it. 1 cm reads as a solid object at desk scale (a domino is ~4 ×
   * 8 cm) without turning a plank into a beam. Spheres ignore it: their depth is
   * their diameter. Filled at P3b (09 §12); the art pass may replace it (U11).
   */
  EXTRUDE_DEPTH_M: 0.01,
} as const;

// ---------------------------------------------------------------------------
// § Transport & overload (09 §5) — honest slow-motion, and the adaptive loop
// ---------------------------------------------------------------------------

export const OVERLOAD = {
  /** Steps per worker wake cap — overload becomes slow-motion, never a spiral (03 §5.5). */
  MAX_CATCHUP_STEPS: SIM.MAX_CATCHUP_STEPS,
  /** Adaptive-quality: drop one render tier if p95 frame exceeds this × budget… */
  DEGRADE_FRAME_RATIO: 1.25,
  /** …for this many consecutive frames (~1.5 s at 60 Hz). Recover after a calm window. */
  DEGRADE_WINDOW_FRAMES: 90,
} as const;

// ---------------------------------------------------------------------------
// § Measured baselines (spike, 2026-07-20) — informative, re-measure per U20.
// darwin-arm64 / Node 24 / D7 build. steps/s keyed by awake+contacting simple bodies.
// ---------------------------------------------------------------------------

export const PERF_MEASURED = {
  /** Active pile (worst case): every body in a live contact island. */
  activePileSps: { 250: 2600, 500: 1500, 1000: 610, 2000: 230, 4000: 79 } as Record<number, number>,
  /** Sleeping islands are this many times cheaper than the same count awake. */
  sleepingGain: 6,
  /** Active *simple* bodies that hold ≤ 16.67 ms/step (real time) at 1×. */
  realtimeActiveBodies: 4500,
  /** A 2 000-object machine with a handful awake steps ~130× under the frame budget. */
  dormantMachineHeadroom: 130,
  /** Procgen self-check throughput at generator scale (~30 mixed bodies). */
  procgenSelfcheckSps: 100_000,
} as const;
