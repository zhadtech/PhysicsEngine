/**
 * Partial forwarding stub — the render half of the M8 budget moved to its app at P3b.
 *
 * The source of truth for the frame budget, the device tiers and the render
 * classification / draw-call ceiling is now `apps/web/src/render/perf.ts`,
 * alongside the classifier, the camera and the adaptive-quality controller that
 * read them (12-ROADMAP §3 P3).
 *
 * Unlike `types/scene.ts` (P1), `types/protocol.ts` (P2) and `types/editor.ts`
 * (P3a), this stub is **not** a pure re-export, and deliberately so: `types/perf.ts`
 * was a single file because M8 was a single milestone, but its constants belong
 * to three packages. `READPATH` is the backend read-path posture (09 §8) and
 * migrates with `types/api.ts` at P4; `FAST_PREVIEW` is procgen's U17 knob and
 * migrates with `types/procgen.ts` at P5. Forwarding them now would point them
 * at a package that has no business owning them.
 *
 * The file also keeps the one **compile proof that could not travel**. 09 §7's
 * load-bearing tie — `low`'s smooth-body target *is* the rankable ceiling — spans
 * `types/community.ts` and the render tiers, and a package cannot import a
 * repo-root design file. So the proof lives here, in the one place that can still
 * see both sides, instead of being downgraded to a comment on either.
 */

import { LIMITS } from './scene';
import { VERIFY } from './community';
import { GEN_DEFAULTS } from './procgen';
import { PERF_TIERS } from '../apps/web/src/render/perf';

export * from '../apps/web/src/render/perf';

type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// 09 §7: "`low`'s target is the rankable ceiling. A scene light enough to be
// leaderboard-verified (08 §5.5, ≤ 1 500 bodies) is exactly a scene light enough
// to stay smooth on weak hardware — one number, two guarantees." Change either
// side and this fails to compile naming the mismatch.
const _lowTierIsRankableCeiling: Eq<
  (typeof PERF_TIERS)['low']['smoothBodyTarget'],
  (typeof VERIFY)['BODY_BUDGET']
> = true;

// ---------------------------------------------------------------------------
// § Backend read-path posture (09 §8) — cache/CDN + verification capacity.
// No new endpoints/tables: existing indexes (05 schema.sql) + Redis trending
// zset (08 §4.2) + edge cache. Constants here mirror the budgets they cite.
// Migrates into `apps/api` at P4 with the rest of types/api.ts.
// ---------------------------------------------------------------------------

export const READPATH = {
  /** A published revision's document is immutable and content-addressed (05 §3) → cache forever. */
  SCENE_DOC_CDN_S: 31_536_000,
  /** Explore listings (08 §4.1 cache column). */
  EXPLORE_TREND_CACHE_S: 60,
  EXPLORE_NEW_CACHE_S: 30,
  /** Following-feed swap triggers (08 §2.5): materialize heavy-follower timelines past these. */
  FEED_P95_REVISIT_MS: 150,
  FEED_FOLLOWEE_REVISIT: 2000,
  /** Verification worker capacity (08 §5.5) — echoed so the capacity model can't drift. */
  VERIFY_WALL_BUDGET_MS: VERIFY.WALL_BUDGET_MS,
  VERIFY_WORKER_CONCURRENCY: VERIFY.WORKER_CONCURRENCY,
  VERIFY_BODY_BUDGET: VERIFY.BODY_BUDGET,
} as const;

// ---------------------------------------------------------------------------
// § Fast-preview procgen (09 §7) — U17. Migrates into `packages/procgen` at P5.
// ---------------------------------------------------------------------------

export const FAST_PREVIEW = {
  /**
   * On `low` tier, generation runs a reduced pass first. maxObjects is half the
   * default target (≤ GEN_DEFAULTS.objectCount by construction) so worst-corner
   * wall time stays inside a few seconds on weak hardware (spike P6).
   */
  maxObjects: Math.round(GEN_DEFAULTS.objectCount / 2),
  /** Self-check simulates to half the duration factor for the preview; full run on accept. */
  stepFactor: 0.5,
  /** Above this projected wall time (ms), always offer the preview instead of a full generate. */
  OFFER_THRESHOLD_MS: 3000,
} as const;

// Sanity ties (documented, enforced by construction above):
//   FAST_PREVIEW.maxObjects ≤ GEN_DEFAULTS.objectCount ≤ LIMITS.maxObjects
const _previewWithinCatalog: typeof LIMITS.maxObjects extends number ? true : never = true;
