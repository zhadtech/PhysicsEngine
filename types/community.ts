/**
 * Community, challenges, and leaderboards — TypeScript definitions.
 *
 * Normative source: 08-COMMUNITY.md. Mirrors it for compile-time safety in the
 * Fastify app (social routes, the verify worker, the ranking job) and the web
 * client (profile, explore, challenge, leaderboard screens).
 *
 * The load-bearing tie in this file: a run is a **pure function of the scene
 * document** (08 §5.1), so every rankable metric must be a numeric field of the
 * engine's own `AnalyticsReport` — `ChallengeMetricId` is compile-proved to be
 * exactly that, which is why the server can recompute (never merely trust) a
 * leaderboard value. Also tied to `types/scene.ts` (rule vocabulary over the
 * real object catalog and limits), `types/protocol.ts` (engine caps that bound
 * verification), and `types/api.ts` (envelope, cards, findings).
 */

import type { Id, ObjectType, Scene } from './scene';
import { LIMITS, OBJECT_TYPES } from './scene';
import type { AnalyticsReport } from './protocol';
import { SIM } from './protocol';
import type { ApiFinding, SceneCardDto, UserRefDto } from './api';

/**
 * Bumped whenever the verifier's behavior could change a metric for an
 * unchanged document (SimCore upgrade inside the same engineVersion, gate
 * changes, budget changes). Part of the verification cache key (08 §5.4) —
 * a bump invalidates cached results without touching stored documents.
 */
export const VERIFIER_VERSION = '1.0.0';

/** Bumped when the trending score formula or its weights change (08 §4.2). */
export const RANKING_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Social surface (08 §2)
// ---------------------------------------------------------------------------

export const SOCIAL = {
  /** Comment body length — mirrors the DDL CHECK on comments.body (verified). */
  COMMENT_MAX_CHARS: 1000,
  /** Comments per scene before the thread is closed to new posts (08 §2.3). */
  COMMENT_MAX_PER_SCENE: 500,
  /** Accounts younger than this do not contribute to ranking signals (08 §4.3). */
  RANK_MIN_ACCOUNT_AGE_H: 24,
  /** Follows per account (anti-spam ceiling, 08 §2.4). */
  MAX_FOLLOWING: 5000,
  /** Feed lookback — the feed is a query, not a materialized fan-out (08 §2.5). */
  FEED_WINDOW_DAYS: 30,
} as const;

export interface CommentDto {
  id: string;
  sceneId: string;
  author: UserRefDto;
  body: string;
  createdAt: string;
  /** True once moderated or author-deleted; body is replaced with '' (08 §7.3). */
  removed: boolean;
}

export interface CreateCommentRequest {
  /** ≤ SOCIAL.COMMENT_MAX_CHARS. */
  body: string;
}

/** Viewer-relative social state, attached to scene reads when signed in. */
export interface SceneSocialDto {
  likeCount: number;
  commentCount: number;
  remixCount: number;
  /** Absent for anonymous readers. */
  viewerLiked?: boolean;
}

export interface FollowStateDto {
  followerCount: number;
  followingCount: number;
  viewerFollows?: boolean;
}

// ---------------------------------------------------------------------------
// Explore ranking (08 §4)
// ---------------------------------------------------------------------------

/** Sort modes of GET /explore — the M4 enum plus M7's two (05 §5.5). */
export type ExploreSort = 'new' | 'trending' | 'top' | 'following';

export const EXPLORE_SORTS = ['new', 'trending', 'top', 'following'] as const;

type SortMissing = Exclude<ExploreSort, (typeof EXPLORE_SORTS)[number]>;
type SortExtra = Exclude<(typeof EXPLORE_SORTS)[number], ExploreSort>;
const _sortsComplete: [SortMissing] extends [never] ? true : ['EXPLORE_SORTS misses:', SortMissing] = true;
const _sortsSound: [SortExtra] extends [never] ? true : ['EXPLORE_SORTS has unknown:', SortExtra] = true;
void _sortsComplete;
void _sortsSound;

/**
 * Trending score (08 §4.2), pinned with RANKING_VERSION:
 *
 *   score = (likes + W_REMIX·remixes + W_COMMENT·comments) / (ageHours + OFFSET)^GRAVITY
 *
 * Only signals from ranking-eligible actors (08 §4.3) count. Measured in the
 * §9 spike: half-life ≈ 1.2 h at publish, ≈ 15 h at one day; a fresh 5-like
 * scene outranks a week-old 400-like scene, so the shelf churns.
 */
export const TRENDING = {
  GRAVITY: 1.5,
  OFFSET_H: 2,
  W_REMIX: 3,
  W_COMMENT: 1,
  /** Ranking job cadence, seconds — score drift over one interval is ~3% (08 §9 E5). */
  RECOMPUTE_S: 600,
  /** Scenes held in the trending zset; the tail is recomputed from scratch each run. */
  ZSET_SIZE: 1000,
  /** Candidate window for recompute: published within this many days. */
  WINDOW_DAYS: 14,
  /** `top` = all-time likes, but only among verified-ranked scenes (08 §4.4). */
  TOP_MIN_LIKES: 3,
} as const;

export function trendingScore(
  signals: { likes: number; remixes: number; comments: number },
  ageHours: number,
): number {
  const raw = signals.likes + TRENDING.W_REMIX * signals.remixes + TRENDING.W_COMMENT * signals.comments;
  return raw / Math.pow(Math.max(0, ageHours) + TRENDING.OFFSET_H, TRENDING.GRAVITY);
}

// ---------------------------------------------------------------------------
// Verification (08 §5) — U2/R2 resolved
// ---------------------------------------------------------------------------

/**
 * `pending`   queued, not yet run — entries display as "verifying"
 * `verified`  SimCore reproduced the run inside budget; metrics are authoritative
 * `unranked`  legal scene, over the verification budget (08 §5.5) — never ranked
 * `failed`    the document did not load/finish in the verifier (a bug or a
 *             deliberately pathological doc); reported to the owner, never ranked
 */
export type VerificationState = 'pending' | 'verified' | 'unranked' | 'failed';

export const VERIFICATION_STATES = ['pending', 'verified', 'unranked', 'failed'] as const;

type VStateMissing = Exclude<VerificationState, (typeof VERIFICATION_STATES)[number]>;
type VStateExtra = Exclude<(typeof VERIFICATION_STATES)[number], VerificationState>;
const _vStatesComplete: [VStateMissing] extends [never]
  ? true
  : ['VERIFICATION_STATES misses:', VStateMissing] = true;
const _vStatesSound: [VStateExtra] extends [never]
  ? true
  : ['VERIFICATION_STATES has unknown:', VStateExtra] = true;
void _vStatesComplete;
void _vStatesSound;

export const VERIFY = {
  /**
   * Step budget for one verification run. Equal to the engine's own hard cap
   * (03 §9.2) so any scene that can finish in a player can finish here —
   * verification is never stricter than the runtime (checked in verify-backend).
   */
  STEP_BUDGET: SIM.HARD_CAP_S * 60,
  /**
   * Dynamic-body ceiling accepted for ranking. Below the engine's E_LIMITS cap:
   * scenes above it still play and publish, they just verify as `unranked`
   * (08 §5.5) — the CPU cost of an 8 000-body 600 s run is minutes, not ms.
   */
  BODY_BUDGET: 1500,
  /** Wall-clock kill switch per run; exceeding it yields `unranked`, not `failed`. */
  WALL_BUDGET_MS: 20_000,
  /** Verification worker concurrency per pod (BullMQ), each pinned to one core. */
  WORKER_CONCURRENCY: 2,
  /** Re-verify cadence for entries in an open challenge (catches verifier bumps). */
  RECHECK_DAYS: 7,
  /**
   * Measured on the §9 spike (darwin-arm64, Node 24, the D7 build): headless
   * steps/s at N dynamic bodies. Used to *predict* cost at enqueue time so an
   * over-budget scene is marked `unranked` without burning the budget first.
   */
  COST_MODEL: [
    { bodies: 25, stepsPerS: 62_000 },
    { bodies: 100, stepsPerS: 41_000 },
    { bodies: 250, stepsPerS: 17_500 },
    { bodies: 500, stepsPerS: 1_200 },
    { bodies: 1000, stepsPerS: 550 },
    { bodies: 2500, stepsPerS: 170 },
    { bodies: 5000, stepsPerS: 68 },
  ],
} as const;

/** Predicted verification wall-time (ms) for a body count and step count (08 §5.5). */
export function predictVerifyMs(bodies: number, steps: number): number {
  const model = VERIFY.COST_MODEL;
  let rate = model[model.length - 1]!.stepsPerS;
  for (const row of model) {
    if (bodies <= row.bodies) {
      rate = row.stepsPerS;
      break;
    }
  }
  return (steps / rate) * 1000;
}

/**
 * The metrics a challenge may rank by. Compile-proved to be numeric fields of
 * the engine's `AnalyticsReport` (03 §10) — the reason the server can recompute
 * any leaderboard value from the document alone (08 §5.1).
 */
type NumericAnalyticsKey = {
  [K in keyof AnalyticsReport]-?: AnalyticsReport[K] extends number ? K : never;
}[keyof AnalyticsReport];

export type ChallengeMetricId = Extract<
  NumericAnalyticsKey,
  'durationS' | 'objectsActivated' | 'chainReactions' | 'longestChain' | 'maxSpeedMS' | 'efficiencyScore'
>;

/** Ranking direction per metric; `min` = smaller is better (e.g. fastest goal). */
export const CHALLENGE_METRICS: Record<ChallengeMetricId, { label: string; better: 'max' | 'min' }> = {
  durationS: { label: 'Run time', better: 'min' },
  objectsActivated: { label: 'Objects activated', better: 'max' },
  chainReactions: { label: 'Chain reactions', better: 'max' },
  longestChain: { label: 'Longest chain', better: 'max' },
  maxSpeedMS: { label: 'Top speed', better: 'max' },
  efficiencyScore: { label: 'Efficiency', better: 'max' },
};

/**
 * Every ranking metric must be a real numeric analytics field — if 03 §10 drops
 * or retypes one, this line names it. (The `Extract` above narrows; this proves
 * nothing was smuggled in by a later edit widening the alias.)
 */
type MetricNotInAnalytics = Exclude<ChallengeMetricId, NumericAnalyticsKey>;
const _metricsAreAnalytics: [MetricNotInAnalytics] extends [never]
  ? true
  : ['ChallengeMetricId is not an AnalyticsReport number:', MetricNotInAnalytics] = true;
void _metricsAreAnalytics;

/** The verified, server-computed result for one (document, engineVersion) pair. */
export interface VerificationDto {
  state: VerificationState;
  /** Engine build that produced these numbers; entries compare only within one (01 §6). */
  engineVersion: string;
  verifierVersion: string;
  /** Present when state = 'verified'. Server-computed, never client-supplied. */
  metrics?: AnalyticsReport;
  /** Simulated steps actually run. */
  steps?: number;
  wallMs?: number;
  /** Why the run is not ranked (state = 'unranked' | 'failed'). */
  reason?: string;
  verifiedAt?: string;
}

/**
 * Advisory client telemetry (08 §5.6). The player posts what its own run
 * produced; the server ranks nothing from it and only records whether the
 * client's `finalHash` matched the verifier's — the standing signal for U9
 * (cross-platform determinism). Divergence is an engine incident, never an
 * accusation against the user.
 */
export interface RunReportRequest {
  engineVersion: string;
  /** 03 §12 FNV-1a 32 hex at finish. */
  finalHash: string;
  analytics: AnalyticsReport;
  /** Coarse bucket only — 'chromium/mac-arm64' style; never a fingerprint. */
  platform: string;
}

export interface RunReportResponse {
  /** 'match' | 'mismatch' | 'unknown' (server verification not finished yet). */
  agreement: 'match' | 'mismatch' | 'unknown';
  verification: VerificationDto;
}

// ---------------------------------------------------------------------------
// Challenges (08 §6)
// ---------------------------------------------------------------------------

export const CHALLENGE = {
  SLUG_PATTERN: /^[a-z0-9][a-z0-9-]{2,39}$/,
  TITLE_MAX_CHARS: 80,
  BRIEF_MAX_CHARS: 2000,
  /** Rules per challenge (keeps the entry check bounded and explainable). */
  MAX_RULES: 12,
  /** Entries per user per challenge — one scene may be swapped, not stacked. */
  MAX_ENTRIES_PER_USER: 1,
  /** Leaderboard page size. */
  BOARD_PAGE: 50,
  /** Grace window after close in which pending verifications still finish. */
  CLOSE_GRACE_H: 6,
} as const;

export type ChallengeState = 'draft' | 'open' | 'judging' | 'closed';

export const CHALLENGE_STATES = ['draft', 'open', 'judging', 'closed'] as const;

type CStateMissing = Exclude<ChallengeState, (typeof CHALLENGE_STATES)[number]>;
type CStateExtra = Exclude<(typeof CHALLENGE_STATES)[number], ChallengeState>;
const _cStatesComplete: [CStateMissing] extends [never]
  ? true
  : ['CHALLENGE_STATES misses:', CStateMissing] = true;
const _cStatesSound: [CStateExtra] extends [never] ? true : ['CHALLENGE_STATES has unknown:', CStateExtra] = true;
void _cStatesComplete;
void _cStatesSound;

/**
 * Entry constraints (08 §6.2). Deliberately a tiny closed vocabulary evaluated
 * over the *document* and the *verified metrics* — never free-form code, and
 * never anything a client must be trusted to self-report. Each rule renders as
 * one line in the challenge brief and, on failure, as one `ApiFinding`.
 */
export type ChallengeRule =
  | { kind: 'maxObjects'; value: number }
  | { kind: 'minObjects'; value: number }
  | { kind: 'allowedTypes'; types: readonly ObjectType[] }
  | { kind: 'forbiddenTypes'; types: readonly ObjectType[] }
  | { kind: 'requiredTypes'; types: readonly ObjectType[] }
  | { kind: 'maxLinks'; value: number }
  | { kind: 'requireGoal' }
  | { kind: 'requireSuccess' }
  | { kind: 'maxDurationS'; value: number }
  | { kind: 'minDurationS'; value: number }
  | { kind: 'planeAngleRange'; minDeg: number; maxDeg: number }
  | { kind: 'startFromScene'; sceneId: string };

export type ChallengeRuleKind = ChallengeRule['kind'];

/**
 * Where each rule is decided. `doc` rules are checked synchronously at entry
 * (immediate 422 with findings); `verified` rules can only be decided once the
 * verifier has run, so an entry that passes the doc rules is accepted as
 * `pending` and may still be disqualified afterwards (08 §6.3).
 */
export const CHALLENGE_RULE_SOURCE: Record<ChallengeRuleKind, 'doc' | 'verified'> = {
  maxObjects: 'doc',
  minObjects: 'doc',
  allowedTypes: 'doc',
  forbiddenTypes: 'doc',
  requiredTypes: 'doc',
  maxLinks: 'doc',
  requireGoal: 'doc',
  requireSuccess: 'verified',
  maxDurationS: 'verified',
  minDurationS: 'verified',
  planeAngleRange: 'doc',
  startFromScene: 'doc',
};

type RuleKindMissing = Exclude<ChallengeRuleKind, keyof typeof CHALLENGE_RULE_SOURCE>;
type RuleKindExtra = Exclude<keyof typeof CHALLENGE_RULE_SOURCE, ChallengeRuleKind>;
const _ruleSourceComplete: [RuleKindMissing] extends [never]
  ? true
  : ['CHALLENGE_RULE_SOURCE misses:', RuleKindMissing] = true;
const _ruleSourceSound: [RuleKindExtra] extends [never]
  ? true
  : ['CHALLENGE_RULE_SOURCE has unknown rule:', RuleKindExtra] = true;
void _ruleSourceComplete;
void _ruleSourceSound;

/** Object-count rules can never exceed the format's own cap (02 §7). */
const _objectRuleCeiling: number = LIMITS.maxObjects;
void _objectRuleCeiling;

/** Type-vocabulary rules quantify over the real catalog, so a typo cannot compile. */
export const CHALLENGE_TYPE_VOCABULARY: readonly ObjectType[] = OBJECT_TYPES;

export interface ChallengeDto {
  id: string;
  slug: string;
  title: string;
  /** Markdown-free plain text (08 §7.1 — no user-authored markup in v1). */
  brief: string;
  state: ChallengeState;
  rules: readonly ChallengeRule[];
  metric: ChallengeMetricId;
  /** Denormalized from CHALLENGE_METRICS for clients that render the board alone. */
  better: 'max' | 'min';
  /** Entries are only comparable within one engine build (01 §6, 08 §6.4). */
  engineVersion: string;
  opensAt: string;
  closesAt: string;
  entryCount: number;
  /** Optional starting document for "remix this" challenges (rule startFromScene). */
  startSceneId?: string;
}

export interface ChallengeEntryDto {
  sceneId: string;
  /** The exact revision entered — later edits do not silently change a ranking. */
  rev: number;
  author: UserRefDto;
  card: SceneCardDto;
  state: VerificationState;
  /** Present when verified and all rules pass. */
  score?: number;
  rank?: number;
  /** Rule failures found after verification (08 §6.3) — same shape as the gate. */
  disqualified?: readonly ApiFinding[];
  enteredAt: string;
}

export interface EnterChallengeRequest {
  sceneId: string;
  /** Must equal the scene's published revision at entry time (optimistic pin). */
  rev: number;
}

export interface LeaderboardPage {
  challenge: ChallengeDto;
  items: readonly ChallengeEntryDto[];
  nextCursor?: string;
  /** The signed-in user's own entry, wherever it ranks. */
  viewerEntry?: ChallengeEntryDto;
}

// ---------------------------------------------------------------------------
// Moderation (08 §7) — closes 07 §7.1's deferred note
// ---------------------------------------------------------------------------

export type ReportTargetType = 'scene' | 'comment' | 'user';

export type ReportReason =
  | 'spam'
  | 'harassment'
  | 'sexual'
  | 'violence'
  | 'illegal'
  | 'impersonation'
  | 'other';

export const REPORT_REASONS = [
  'spam',
  'harassment',
  'sexual',
  'violence',
  'illegal',
  'impersonation',
  'other',
] as const;

type ReasonMissing = Exclude<ReportReason, (typeof REPORT_REASONS)[number]>;
type ReasonExtra = Exclude<(typeof REPORT_REASONS)[number], ReportReason>;
const _reasonsComplete: [ReasonMissing] extends [never] ? true : ['REPORT_REASONS misses:', ReasonMissing] = true;
const _reasonsSound: [ReasonExtra] extends [never] ? true : ['REPORT_REASONS has unknown:', ReasonExtra] = true;
void _reasonsComplete;
void _reasonsSound;

/**
 * `visible`   default
 * `limited`   delisted from explore/search/feeds; direct link still resolves (08 §7.3)
 * `removed`   hidden from everyone but the owner, who sees the reason and can appeal
 */
export type ModerationState = 'visible' | 'limited' | 'removed';

export const MODERATION_STATES = ['visible', 'limited', 'removed'] as const;

type MStateMissing = Exclude<ModerationState, (typeof MODERATION_STATES)[number]>;
type MStateExtra = Exclude<(typeof MODERATION_STATES)[number], ModerationState>;
const _mStatesComplete: [MStateMissing] extends [never]
  ? true
  : ['MODERATION_STATES misses:', MStateMissing] = true;
const _mStatesSound: [MStateExtra] extends [never] ? true : ['MODERATION_STATES has unknown:', MStateExtra] = true;
void _mStatesComplete;
void _mStatesSound;

export const MODERATION = {
  /** Reports per user per day (abuse of the abuse channel, 08 §7.2). */
  MAX_REPORTS_PER_DAY: 20,
  /** Distinct reporters that auto-limit a scene pending review (08 §7.2). */
  AUTO_LIMIT_REPORTS: 5,
  /** Days a `removed` item is retained for appeal before the purge job runs. */
  APPEAL_WINDOW_DAYS: 30,
} as const;

export interface CreateReportRequest {
  targetType: ReportTargetType;
  /** Scene id, comment id, or handle, per targetType. */
  targetId: string;
  reason: ReportReason;
  /** Optional free text, ≤ 500 chars — shown only to moderators. */
  note?: string;
}

// ---------------------------------------------------------------------------
// Remix lineage (08 §3)
// ---------------------------------------------------------------------------

export const LINEAGE = {
  /** Ancestors walked upward from a scene (cycle-free by construction). */
  MAX_ANCESTORS: 20,
  /** Direct children returned per page. */
  CHILDREN_PAGE: 24,
} as const;

export interface LineageNodeDto {
  sceneId: string;
  title: string;
  author: UserRefDto;
  /** Absent for the root; otherwise the parent's scene id. */
  remixedFrom?: string;
  publishedAt?: string;
  /** True when the scene is no longer readable (purged, private, or removed). */
  unavailable: boolean;
}

export interface RemixTreeResponse {
  /** Root → … → the requested scene (≤ LINEAGE.MAX_ANCESTORS, nearest last). */
  ancestors: readonly LineageNodeDto[];
  scene: LineageNodeDto;
  children: readonly LineageNodeDto[];
  nextCursor?: string;
  /**
   * Direct remixes of this scene, from the maintained `scenes.remix_count`.
   * Deeper descendant totals are deliberately not maintained (08 §3).
   */
  childCount: number;
}

// ---------------------------------------------------------------------------
// Type-level notes kept honest
// ---------------------------------------------------------------------------

/** Documents are the only leaderboard input; this alias documents that in code. */
export type RankableInput = { doc: Scene; engineVersion: string };

/** Ids referenced by findings are document ids (02 §2.1), not database ids. */
export type FindingIds = readonly Id[];
