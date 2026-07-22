/**
 * types/monetization.ts — multiplayer collaboration + monetization (M10).
 *
 * Normative source: 11-MULTIPLAYER-MONETIZATION.md. M10 is a roadmap milestone:
 * it introduces no API operation, DB table, error code, or engine constant (like
 * M8/M9). Real-time co-editing and billing are *future* surfaces — sketched, not
 * implemented. So this file, like types/infra.ts, adds no openapi.yaml / schema.sql
 * change; every constant that matters is tied by compile proof to the constant it
 * must not drift from.
 *
 * The load-bearing proof (D27): the FREE plan equals the shipped MVP entitlements,
 * and the format/engine caps are IDENTICAL on every plan. Monetization is therefore
 * strictly additive — you cannot build a paid tier by nerfing free, and you cannot
 * sell past the determinism/format invariants (object cap, body cap). Change the
 * free tier's scene quota, or bump a paid tier's body cap, and compilation fails.
 */

import { API, RATE_LIMITS } from './api';
import { LIMITS } from './scene';
import { SIM } from './protocol';
import { SKIN_NAMES } from './editor';

type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** Bumped when entitlements or the collaboration model change; not a price list —
 *  concrete prices are a business decision (U27), the *architecture* is pinned here. */
export const MONETIZATION_VERSION = '0.1.0';

// ===========================================================================
// § Multiplayer collaboration (11 §2–§5) — the design sketch's fixed points,
// each validated by the M10 spike (crdt-spike.mjs) or inherited from S8/S10.
// ===========================================================================

export const COLLAB = {
  /** The spike-validated convergent structure (spike A): an add-wins observed-
   *  remove map over objects/links + last-writer-wins registers over fields and
   *  world. 200 random delivery orders converged to byte-identical documents;
   *  re-delivery is idempotent. CRDT chosen over OT (no central transform server;
   *  P2P-friendly; merge is a pure set/register join). */
  MODEL: 'awor-map+lww-register',
  /** A merge is ALWAYS followed by the same validation gate every save runs
   *  (05 §5.3). The CRDT guarantees *structural* convergence; referential
   *  integrity (02 §8 E-rules — e.g. a link whose endpoint was concurrently
   *  deleted) is a *semantic* property the JSON Schema cannot see (spike C), and
   *  is restored by a deterministic, order-independent link-GC repair that both
   *  replicas compute identically. Collaboration adds no new correctness model. */
  MERGE_THEN_GATE: true,
  /** Play stays local + deterministic: co-editing mutates INPUTS only, and a run
   *  is a pure function of (document, engineVersion) — proven cross-process (S8
   *  E1) and Node≡Chromium (S10 I2). Shared *playback* (synchronized run state)
   *  is explicitly out of scope for the v1 sketch; each collaborator plays locally. */
  PLAY_IS_LOCAL_DETERMINISTIC: true,
  /** The realtime sync service is STATEFUL — a deliberate, scoped exception to
   *  01 §1's "no real-time multiplayer" / stateless-backend non-goal, isolated to
   *  its own service. The CRUD API (05) stays stateless; a document checkpoints to
   *  the existing scene_revisions store, so an explicit save is still a revision. */
  STATEFUL_SYNC_SERVICE: true,
  /** Presence/awareness (peer cursors, selections, viewport) is ephemeral: Redis
   *  with a short TTL, never persisted. Losing it costs a reconnect, never data. */
  PRESENCE_TTL_S: 30,
  /** Server-side drafts / cross-device continue-editing (U13) is the single-user
   *  degenerate case of this same machinery — one seat, zero peers — so it ships
   *  with collaboration rather than as separate sync infrastructure. */
  SUBSUMES_U13: true,
  /** Max concurrent editors in one session, hard ceiling regardless of plan seats
   *  (a session is a coordination unit, not a broadcast; presence fan-out cost). */
  MAX_SESSION_EDITORS: 16,
} as const;

// ===========================================================================
// § Plans & entitlements (11 §6, D27)
// ===========================================================================

export type PlanId = 'free' | 'plus' | 'pro';
export const PLAN_IDS = ['free', 'plus', 'pro'] as const;

export type VerifyPriority = 'standard' | 'priority';
/** Public-API reach via personal access tokens (05 §6.6, deferred to M11). */
export type ApiAccess = 'none' | 'read' | 'full';

export interface Entitlements {
  // — Account-scoped quotas: the sellable levers (raise with the plan) —
  /** Non-trashed scenes per account (05 §8 E_QUOTA). Free = the shipped cap. */
  maxActiveScenes: number;
  /** Model calls/day for AI generation (07 §7.3). Free = the shipped RATE_LIMITS. */
  aiCallsPerDay: number;
  /** Concurrent co-editing seats a user may host across their sessions.
   *  0 ⇒ solo / single-writer only (the MVP behavior, 05 §7). */
  collaboratorSeats: number;
  /** Additive cosmetic skin packs beyond the shipped set. 0 on free. */
  premiumSkinPacks: number;
  /** Verification queue priority (08 §5.5). Priority never changes the *result*
   *  (determinism), only the wait — so it is sellable without touching fairness. */
  verifyPriority: VerifyPriority;
  /** Personal-access-token reach (05 §6.6 → M11). */
  apiAccess: ApiAccess;
  /** Author community challenges (U23) — reuses the M7 moderation surface; gated
   *  to the top tier so spam/incentive risk sits behind a paying, known actor. */
  canAuthorChallenges: boolean;
  /** Profile supporter badge (pure cosmetic). */
  supporterBadge: boolean;

  // — Universal invariants: NOT for sale (identical on every plan) —
  /** Format cap on objects per document (02 §7). A scene-format invariant, not a
   *  business lever — identical on every plan == LIMITS.maxObjects (proven below). */
  maxObjectsPerScene: number;
  /** Engine dynamic-body hard cap (03 §5.4). A determinism/rankability invariant —
   *  you cannot buy past it; identical on every plan == SIM.MAX_DYNAMIC_BODIES. */
  hardBodyCap: number;
  /** Count of shipped base skins, free on every plan (never paywall what shipped)
   *  == SKIN_NAMES.length (proven below). */
  baseSkinCount: number;
}

/** Free AI/day sourced from the live rate bucket, so the free floor tracks it. */
const FREE_AI_CALLS_DAY = RATE_LIMITS.aiCallsDay?.limit ?? 20;

export const PLANS = {
  // free: exactly the MVP-shipped entitlements. This IS the product M0–M9 built.
  free: {
    maxActiveScenes: API.MAX_ACTIVE_SCENES,
    aiCallsPerDay: FREE_AI_CALLS_DAY,
    collaboratorSeats: 0,
    premiumSkinPacks: 0,
    verifyPriority: 'standard',
    apiAccess: 'none',
    canAuthorChallenges: false,
    supporterBadge: false,
    maxObjectsPerScene: LIMITS.maxObjects,
    hardBodyCap: SIM.MAX_DYNAMIC_BODIES,
    baseSkinCount: SKIN_NAMES.length,
  },
  // plus: bigger library + AI budget, cosmetics, a few collaboration seats.
  plus: {
    maxActiveScenes: 2000,
    aiCallsPerDay: 100,
    collaboratorSeats: 3,
    premiumSkinPacks: 3,
    verifyPriority: 'standard',
    apiAccess: 'read',
    canAuthorChallenges: false,
    supporterBadge: true,
    maxObjectsPerScene: LIMITS.maxObjects,
    hardBodyCap: SIM.MAX_DYNAMIC_BODIES,
    baseSkinCount: SKIN_NAMES.length,
  },
  // pro: the creator tier — larger seats, priority verify, full API, challenge authoring.
  pro: {
    maxActiveScenes: 10_000,
    aiCallsPerDay: 500,
    collaboratorSeats: 10,
    premiumSkinPacks: 99,
    verifyPriority: 'priority',
    apiAccess: 'full',
    canAuthorChallenges: true,
    supporterBadge: true,
    maxObjectsPerScene: LIMITS.maxObjects,
    hardBodyCap: SIM.MAX_DYNAMIC_BODIES,
    baseSkinCount: SKIN_NAMES.length,
  },
} as const satisfies Record<PlanId, Entitlements>;

// Ordering free ≤ plus ≤ pro holds by construction on every sellable lever
// (500 ≤ 2000 ≤ 10000 scenes; 20 ≤ 100 ≤ 500 AI; 0 ≤ 3 ≤ 10 seats; 0 ≤ 3 ≤ 99
// packs) — a paid tier never grants *less* than free. The universal invariants
// are equal on all three (proven below), so nothing sellable erodes them.

// --- exhaustiveness: PLAN_IDS ↔ PlanId ---
type PlanMissing = Exclude<PlanId, (typeof PLAN_IDS)[number]>;
type PlanExtra = Exclude<(typeof PLAN_IDS)[number], PlanId>;
const _plansComplete: [PlanMissing] extends [never] ? true : ['PLAN_IDS misses:', PlanMissing] = true;
const _plansSound: [PlanExtra] extends [never] ? true : ['PLAN_IDS lists non-plan:', PlanExtra] = true;
void _plansComplete; void _plansSound;

// --- the load-bearing ties ---
type PlanRow = (typeof PLANS)[PlanId];

/** Free plan quotas === the shipped MVP constants (never silently regress free). */
const _freeScenes: Eq<typeof PLANS.free.maxActiveScenes, typeof API.MAX_ACTIVE_SCENES> = true;
void _freeScenes;

/** Object cap is a scene-format invariant — identical on every plan. */
const _objCapUniversal: Eq<PlanRow['maxObjectsPerScene'], typeof LIMITS.maxObjects> = true;
void _objCapUniversal;

/** Body cap is a determinism invariant — identical on every plan; not for sale. */
const _bodyCapUniversal: Eq<PlanRow['hardBodyCap'], typeof SIM.MAX_DYNAMIC_BODIES> = true;
void _bodyCapUniversal;

/** Shipped skins are free on every plan — identical base-skin count everywhere. */
const _skinsUniversal: Eq<PlanRow['baseSkinCount'], typeof SKIN_NAMES['length']> = true;
void _skinsUniversal;

// ===========================================================================
// § Public API access (05 §6.6 → M11) — personal access tokens, the non-cookie
// credential. Sketched here so the apiAccess entitlement has a concrete meaning.
// ===========================================================================

export const PUBLIC_API = {
  /** The credential type (05 §6.6, deferred). Scoped, revocable, SHA-256-hashed
   *  like session tokens (05 §6.2); never a bearer of the __Host- cookie's power. */
  CREDENTIAL: 'personal-access-token',
  /** Token scopes; 'read' = the apiAccess:'read' entitlement, 'write' needs :'full'. */
  SCOPES: ['read', 'write'] as const,
  MAX_TOKENS_PER_USER: 10,
  /** Full surface (endpoints, rate multipliers, OAuth-app model) is an M11 spec. */
  SPEC_MILESTONE: 'M11',
} as const;
