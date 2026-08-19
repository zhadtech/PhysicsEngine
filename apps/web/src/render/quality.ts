/**
 * The adaptive-quality controller — 09 §7.2.
 *
 * "A render-only feedback loop: if p95 frame time exceeds `DEGRADE_FRAME_RATIO`
 * (1.25) × budget for `DEGRADE_WINDOW_FRAMES` (90 ≈ 1.5 s), drop one tier's
 * worth of fidelity (shadows → LOD → overlays); recover after a calm window. It
 * never throttles the worker."
 *
 * The last sentence is the one that matters and the one this file is structured
 * to make true: `step` returns a **render envelope** and nothing else. There is
 * no path from here to the worker, no speed to change and no step to skip,
 * because a controller that could reach the simulation would be a controller
 * that could break determinism (D20, DET-1) — and a leaderboard run must be the
 * same run on a phone and on a workstation, just drawn less prettily.
 *
 * Two silences 09 §7.2 leaves, filled here (09 §12):
 *
 * 1. **What "p95 … for N frames" measures.** Taken as: keep the last
 *    `DEGRADE_WINDOW_FRAMES` frame times and degrade when the 95th percentile of
 *    that window exceeds the threshold. The alternative reading ("90 consecutive
 *    frames each over budget") would never fire on the jittery-but-mostly-fine
 *    profile that adaptation exists for.
 * 2. **How calm a calm window is.** Recovery needs a full window whose p95 is
 *    under the *plain* budget — not merely under the 1.25× degrade threshold,
 *    which would oscillate one step up and down forever.
 *
 * Both readings, and the 1.25/90 constants themselves, are **U24** — unvalidated
 * without real-device frame telemetry, and deliberately isolated here so that
 * validating them changes one file.
 *
 * Contract: docs/09-PERFORMANCE.md §7.2, §7; docs/00-PROGRESS.md D20.
 */

import { FRAME, OVERLOAD, PERF_TIERS, RENDER, type DeviceTier, type TierId } from './perf.js';

/**
 * How much fidelity has been dropped below the device tier. The ladder is 09
 * §7.2's, in its order — each step is strictly cheaper than the one before.
 */
export type QualityLevel = 0 | 1 | 2 | 3;

export const QUALITY_LADDER = ['tier', 'no-shadows', 'lower-lod', 'no-overlays'] as const;

/** What the renderer is actually allowed to do this frame. */
export interface RenderEnvelope {
  tier: TierId;
  level: QualityLevel;
  shadows: boolean;
  shadowMapPx: number;
  fieldOverlays: boolean;
  maxInstanceDetailLod: 0 | 1 | 2;
  targetHz: 30 | 60;
  budgetMs: number;
}

/** Frame budget for a tier — 60 Hz tiers get `FRAME.BUDGET_MS`, `low` the floor. */
export function budgetMsFor(tier: DeviceTier): number {
  return tier.targetHz === 60 ? FRAME.BUDGET_MS : FRAME.FLOOR_BUDGET_MS;
}

/**
 * Apply `level` steps of degradation to a tier.
 *
 * Shadows go first because they are the biggest fill cost (09 §4); overlays go
 * last because they carry *information* — a fan cone is the only way an
 * invisible force is legible (04 §12.2) — so the picture gets uglier before it
 * gets less informative.
 */
export function envelopeFor(tierId: TierId, level: QualityLevel): RenderEnvelope {
  const tier: DeviceTier = PERF_TIERS[tierId];
  const shadows = tier.shadows && level < 1;
  const lod = (level >= 2 ? Math.max(0, tier.maxInstanceDetailLod - 1) : tier.maxInstanceDetailLod) as 0 | 1 | 2;
  const overlays = tier.fieldOverlays && level < 3;
  return {
    tier: tierId,
    level,
    shadows,
    // `mid` halves the map, `low` has none (09 §7); the halving rides on the
    // tier rather than on the ladder, because it is a device property.
    shadowMapPx: shadows ? (tierId === 'high' ? RENDER.SHADOW_MAP_PX : RENDER.SHADOW_MAP_PX / 2) : 0,
    fieldOverlays: overlays,
    maxInstanceDetailLod: lod,
    targetHz: tier.targetHz,
    budgetMs: budgetMsFor(tier),
  };
}

/** Nearest-rank p95 over a sample window. */
export function p95(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[Math.max(0, rank)] as number;
}

/**
 * The controller. Feed it one frame time per frame; read `envelope` to draw.
 *
 * It is a plain object with no timers and no rAF of its own, so the whole
 * hysteresis story is testable by calling `frame()` in a loop — which is the
 * only way the "never oscillates" property gets checked at all.
 */
export class QualityController {
  readonly tier: TierId;
  private level: QualityLevel = 0;
  private readonly window: number[] = [];
  /** Frames since the last level change — a change restarts the measurement. */
  private since = 0;

  constructor(tier: TierId) {
    this.tier = tier;
  }

  get envelope(): RenderEnvelope {
    return envelopeFor(this.tier, this.level);
  }

  get qualityLevel(): QualityLevel {
    return this.level;
  }

  /** p95 of the current window, for the 04 §10.3 debug overlay. */
  get p95Ms(): number {
    return p95(this.window);
  }

  /**
   * Record one frame. Returns `true` when the envelope changed, so the caller
   * can rebuild materials only when something actually moved.
   */
  frame(frameMs: number): boolean {
    this.window.push(frameMs);
    if (this.window.length > OVERLOAD.DEGRADE_WINDOW_FRAMES) this.window.shift();
    this.since++;
    // A decision needs a full window measured since the last change; otherwise
    // one degrade step would immediately trigger the next off the same samples.
    if (this.window.length < OVERLOAD.DEGRADE_WINDOW_FRAMES) return false;
    if (this.since < OVERLOAD.DEGRADE_WINDOW_FRAMES) return false;

    const budget = budgetMsFor(PERF_TIERS[this.tier]);
    const measured = p95(this.window);
    if (measured > budget * OVERLOAD.DEGRADE_FRAME_RATIO && this.level < 3) {
      this.level = (this.level + 1) as QualityLevel;
      this.since = 0;
      return true;
    }
    // Recovery is gated on the plain budget, not the degrade threshold: a window
    // sitting between the two is exactly where a symmetric rule would flap.
    if (measured < budget && this.level > 0) {
      this.level = (this.level - 1) as QualityLevel;
      this.since = 0;
      return true;
    }
    return false;
  }
}

/**
 * Initial tier guess (09 §7.2 "tier auto-detection (GPU/UA heuristics)").
 *
 * Deliberately coarse and deliberately conservative in one direction only: the
 * controller can degrade a wrong `high` within 1.5 s, but a scene authored under
 * a wrongly-detected `low` carries a *soft body-count warning* the author may
 * have designed around, so guessing low is the more annoying error. Inputs are
 * passed in rather than read from `navigator`, which is what lets this be tested
 * — and what keeps this module free of the DOM (P3c owns that).
 *
 * The thresholds are **U24**: unvalidated until real-device telemetry exists.
 */
export function detectTier(hints: {
  hardwareConcurrency?: number;
  deviceMemoryGb?: number;
  coarsePointer?: boolean;
  maxTextureSize?: number;
}): TierId {
  const cores = hints.hardwareConcurrency ?? 4;
  const memory = hints.deviceMemoryGb ?? 4;
  const texture = hints.maxTextureSize ?? 4096;
  if (texture < 4096 || cores <= 2 || memory <= 2) return 'low';
  if (hints.coarsePointer === true) return cores >= 8 && memory >= 6 ? 'mid' : 'low';
  if (cores >= 8 && memory >= 8) return 'high';
  return 'mid';
}
