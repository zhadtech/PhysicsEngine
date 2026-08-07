/**
 * types/infra.ts — infrastructure & deployment constants (M9).
 *
 * Normative source: 10-INFRASTRUCTURE.md. This file is the machine-checked half:
 * environments, the U9 cross-platform CI matrix, the schema-migration runner
 * contract, cross-origin-isolation headers (U5), observability budgets, and the
 * secrets inventory — each tied by compile proof (or by value identity) to the
 * constant it must not drift from (the scene schemaVersion, the API health route,
 * the M7 verification budget, the M8 tiers/perf version).
 *
 * M9 changes no committed surface (scene format, engine constants, openapi.yaml,
 * schema.sql) — like M8 it is a strategy/ops layer over the existing design.
 * Account deletion/erasure (U15) and moderator ops (U22) ride the soft-delete
 * columns already in schema.sql (`users.deleted_at`, etc.), so no DDL is added.
 */

import { SCHEMA_VERSION } from './scene';
import { ROUTES } from './api';
import { VERIFY, VERIFIER_VERSION, RANKING_VERSION } from './community';
import { PERF_VERSION, type TierId } from './perf';
import { AI_PROMPT_VERSION } from './ai';

/** Bumped whenever an infra constant changes; deploy manifests are diffed against it. */
export const INFRA_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// § Environments (10 §4)
// ---------------------------------------------------------------------------

export type EnvId = 'dev' | 'staging' | 'prod';
export const ENV_IDS = ['dev', 'staging', 'prod'] as const;

export interface EnvSpec {
  /** Human origin of the web app; APIs live under `/v1` (api.ts API_BASE_PATH). */
  webOrigin: string;
  /** Cross-origin isolation is mandatory everywhere SAB transport is wanted (§3). */
  crossOriginIsolated: boolean;
  /** Real provider keys + real email delivery only past staging (D24). */
  aiLive: boolean;
  /** Seed/anonymized data vs. real user data (erasure jobs run only in prod, §8). */
  realUserData: boolean;
}

export const ENVIRONMENTS = {
  dev: { webOrigin: 'http://localhost:5173', crossOriginIsolated: true, aiLive: false, realUserData: false },
  staging: { webOrigin: 'https://staging.example.app', crossOriginIsolated: true, aiLive: true, realUserData: false },
  prod: { webOrigin: 'https://example.app', crossOriginIsolated: true, aiLive: true, realUserData: true },
} as const satisfies Record<EnvId, EnvSpec>;

type EnvMissing = Exclude<EnvId, (typeof ENV_IDS)[number]>;
type EnvExtra = Exclude<(typeof ENV_IDS)[number], EnvId>;
const _envComplete: [EnvMissing] extends [never] ? true : ['ENV_IDS misses:', EnvMissing] = true;
const _envSound: [EnvExtra] extends [never] ? true : ['ENV_IDS lists non-env:', EnvExtra] = true;
void _envComplete;
void _envSound;

// ---------------------------------------------------------------------------
// § CI/CD matrix (10 §6) — the U9 resolution. Same golden hashes must match
// across ISAs (Node) and across the browser triple (Playwright).
// ---------------------------------------------------------------------------

/** The pinned deterministic physics build (D7; protocol.ts §engineVersion note). */
export const ENGINE_BUILD = '@dimforge/rapier2d-deterministic-compat@0.19.3';

/** Node LTS lines the API + headless SimCore are tested on. */
export const CI_NODE_VERSIONS = ['20', '22'] as const;

/** Playwright browser engines — the "browser triple" the 09 §9 render harness rides. */
export type BrowserEngine = 'chromium' | 'firefox' | 'webkit';
export const BROWSER_TRIPLE = ['chromium', 'firefox', 'webkit'] as const;

type BrowserMissing = Exclude<BrowserEngine, (typeof BROWSER_TRIPLE)[number]>;
type BrowserExtra = Exclude<(typeof BROWSER_TRIPLE)[number], BrowserEngine>;
const _browserComplete: [BrowserMissing] extends [never] ? true : ['BROWSER_TRIPLE misses:', BrowserMissing] = true;
const _browserSound: [BrowserExtra] extends [never] ? true : ['BROWSER_TRIPLE lists non-browser:', BrowserExtra] =
  true;
void _browserComplete;
void _browserSound;

/**
 * GitHub-hosted runners the cross-platform determinism job fans out over.
 * U9 requires **both** ISAs (x86-64 linux + arm64 macos) to produce the same
 * golden hash — drop either and the proofs below fail compilation naming U9.
 */
export type CiRunner = 'ubuntu-latest' | 'macos-14' | 'windows-latest';
export const DETERMINISM_RUNNERS = ['ubuntu-latest', 'macos-14'] as const satisfies readonly CiRunner[];

type _U9Linux = 'ubuntu-latest' extends (typeof DETERMINISM_RUNNERS)[number]
  ? true
  : ['U9: linux-x64 determinism runner missing'];
type _U9MacArm = 'macos-14' extends (typeof DETERMINISM_RUNNERS)[number]
  ? true
  : ['U9: macos-arm64 determinism runner missing'];
const _u9linux: _U9Linux = true;
const _u9macArm: _U9MacArm = true;
void _u9linux;
void _u9macArm;

export const CI = {
  /** Workflow file that owns the cross-platform golden-hash gate (verify-infra checks it exists). */
  DETERMINISM_WORKFLOW: '.github/workflows/determinism-matrix.yml',
  /** Everyday gate: tsc + ajv (verify.mjs) + verify-backend.mjs + unit tests. */
  MAIN_WORKFLOW: '.github/workflows/ci.yml',
  DEPLOY_WORKFLOW: '.github/workflows/deploy.yml',
  /**
   * Golden hashes are keyed by these versions; a mismatch that isn't explained by
   * one of them changing is an engine incident, not an expected diff (§6, §7).
   */
  GOLDEN_KEY_VERSIONS: {
    engineBuild: ENGINE_BUILD,
    verifier: VERIFIER_VERSION,
    ranking: RANKING_VERSION,
    prompt: AI_PROMPT_VERSION,
    perf: PERF_VERSION,
  },
} as const;

// ---------------------------------------------------------------------------
// § Cross-origin isolation & embeds (10 §3) — U5
// ---------------------------------------------------------------------------

/**
 * SharedArrayBuffer transport (01 §3.1, SAB) needs the document to be
 * `crossOriginIsolated`, which the browser grants only under this header pair.
 * The player degrades to the transferable-ArrayBuffer fallback when it isn't set
 * (e.g. a third-party embed that can't opt in) — the run is identical, just a
 * postMessage copy per frame instead of a shared view (09 §5, P2: µs either way).
 */
export const ISOLATION = {
  COOP: 'same-origin',
  /** `credentialless` (not `require-corp`) so cross-origin CDN assets load without per-asset CORP. */
  COEP: 'credentialless',
  /** The first-party app sets both; SAB is used iff the runtime reports isolation. */
  COOP_HEADER: 'Cross-Origin-Opener-Policy',
  COEP_HEADER: 'Cross-Origin-Embedder-Policy',
  /** Share/embed pages that can't be isolated advertise this so the client skips the SAB probe. */
  EMBED_QUERY_FLAG: 'embed',
} as const;

/** Pure predicate: would this response's headers make the document cross-origin isolated? */
export function grantsIsolation(headers: {
  'cross-origin-opener-policy'?: string;
  'cross-origin-embedder-policy'?: string;
}): boolean {
  const coop = headers['cross-origin-opener-policy'];
  const coep = headers['cross-origin-embedder-policy'];
  return coop === ISOLATION.COOP && (coep === 'require-corp' || coep === 'credentialless');
}

// ---------------------------------------------------------------------------
// § Schema-migration runner (10 §5)
// ---------------------------------------------------------------------------

/**
 * A single-step forward migration of a scene document, and the registry of them.
 *
 * The runner chains these from a document's `schemaVersion` up to
 * `MIGRATION.currentSchemaVersion`, then re-validates against the schema.
 * Contract enforced by the runner: `to === from + 1` (gap-free), migrations are
 * ordered and total up to current, and the output re-validates (fail ⇒ E_MIGRATION).
 *
 * P1 moved both into `packages/scene-format` — where §5.2 always said the
 * registry belongs, and where the runner is now implemented rather than
 * described (`src/migrate.ts`, exercised by the package's unit suite against the
 * same E1–E4 fixtures `verify-infra.mjs` §E proved against a reference). They
 * are re-exported here so this file's surface is unchanged.
 */
export type { SchemaMigration } from '../packages/scene-format/src/migrate';
export { SCENE_MIGRATIONS, runMigrations, MigrationError } from '../packages/scene-format/src/migrate';

export const MIGRATION = {
  /** Documents are migrated up to here at load and by the offline backfill job (§5). */
  currentSchemaVersion: SCHEMA_VERSION,
  /** Forward-only: there is no down-migration; old app versions reject newer docs by version (§5). */
  direction: 'forward-only',
  /** SQL DDL is applied by a separate transactional runner (Flyway-style, §5) — distinct axis. */
  ddlRunner: 'transactional-forward-only',
} as const;

/** currentSchemaVersion is the scene format's own version, not a copy — no drift possible. */
const _migTie: typeof MIGRATION.currentSchemaVersion extends typeof SCHEMA_VERSION ? true : never = true;
void _migTie;

// ---------------------------------------------------------------------------
// § Observability (10 §7) — U9 divergence dashboard, verification queue, trending
// ---------------------------------------------------------------------------

export const OBSERVABILITY = {
  /** The standing U9 signal (08 §5.6): client-vs-server hash disagreement over time. */
  DIVERGENCE_INDEX: 'idx_run_reports_divergence',
  DIVERGENCE_TABLE: 'run_reports',
  /** Verification backlog is read off this table (08 §5); alarm when depth climbs (§7). */
  VERIFY_QUEUE_TABLE: 'scene_verifications',
  /** Verification capacity budgets echoed so the queue-depth alarm can't drift (08 §5.5). */
  VERIFY_WALL_BUDGET_MS: VERIFY.WALL_BUDGET_MS,
  VERIFY_WORKER_CONCURRENCY: VERIFY.WORKER_CONCURRENCY,
  VERIFY_BODY_BUDGET: VERIFY.BODY_BUDGET,
  /**
   * Trending shadow-tuning (U19/U21): the ranking job also writes scores under a
   * candidate RANKING_VERSION to a shadow zset; the two orderings are diffed
   * offline before a param change is promoted (§7). Never affects live order.
   */
  TRENDING_SHADOW_SUFFIX: ':shadow',
  RANKING_VERSION,
} as const;

/** Service-level objectives the alerting is wired to (§7). Informative targets, not caps. */
export const SLO = {
  /** Read-path (gallery/scene GET) availability. */
  READ_AVAILABILITY: 0.999,
  /** Write-path (save/publish) availability — argon2/OAuth make it heavier. */
  WRITE_AVAILABILITY: 0.995,
  /** p95 latency budgets, ms. Scene doc GET is cache-fronted (09 §8). */
  P95_SCENE_GET_MS: 200,
  P95_EXPLORE_MS: 300,
  /** Verification is a background queue: freshness, not latency, is the SLO. */
  VERIFY_FRESHNESS_MIN: 15,
} as const;

// ---------------------------------------------------------------------------
// § CI perf gate (10 §6) — extends 09 §9 into a per-tier regression gate
// ---------------------------------------------------------------------------

export const PERF_GATE = {
  /** Baselines are committed per this version (09 §9); a deliberate change updates them in the same commit. */
  baselineVersion: PERF_VERSION,
  /** Frame p95 may exceed the tier budget by at most this before the build regresses (09 §9). */
  frameP95RegressRatio: 1.1,
  /** steps/s regression threshold shared with 03 §12 / 06 §11. */
  throughputRegressRatio: 1.15,
} as const;

/** The perf gate runs on every tier — exhaustive over TierId, so a new tier can't be skipped. */
export const CI_PERF_TIERS = { high: true, mid: true, low: true } as const satisfies Record<TierId, true>;

// ---------------------------------------------------------------------------
// § Health / readiness (10 §2)
// ---------------------------------------------------------------------------

export const HEALTH = {
  /** The one unauthenticated infra route — value taken from api.ts ROUTES, never re-typed. */
  path: ROUTES['healthCheck']!.path,
  /** Liveness = process up; readiness additionally checks PG + Redis reachability (§2). */
  readinessDeps: ['postgres', 'redis'],
  /** Load balancer drains a pod after this many failed readiness probes (§2). */
  unhealthyThreshold: 3,
} as const;

// ---------------------------------------------------------------------------
// § Secrets inventory (10 §4) — NAMES ONLY. No secret value ever lives in the repo.
// Grouped by the decision that makes each server-only.
// ---------------------------------------------------------------------------

export type SecretScope = 'server-only' | 'build';
export interface SecretSpec {
  scope: SecretScope;
  rotationDays: number;
  /** The decision that requires this be server-side. */
  by: string;
}

export const SECRETS = {
  // AI provider keys never reach the client (D15 — server-side proxy only).
  AI_PROVIDER_KEY: { scope: 'server-only', rotationDays: 90, by: 'D15' },
  // Session signing + OAuth client secrets (D12).
  SESSION_SECRET: { scope: 'server-only', rotationDays: 30, by: 'D12' },
  OAUTH_GOOGLE_SECRET: { scope: 'server-only', rotationDays: 180, by: 'D12' },
  OAUTH_GITHUB_SECRET: { scope: 'server-only', rotationDays: 180, by: 'D12' },
  // Datastores + object storage / email (U14 vendor drivers).
  DATABASE_URL: { scope: 'server-only', rotationDays: 90, by: 'D22' },
  REDIS_URL: { scope: 'server-only', rotationDays: 90, by: 'D22' },
  OBJECT_STORAGE_KEY: { scope: 'server-only', rotationDays: 90, by: 'D22' },
  EMAIL_API_KEY: { scope: 'server-only', rotationDays: 90, by: 'D22' },
} as const satisfies Record<string, SecretSpec>;

// ---------------------------------------------------------------------------
// § Deploy (10 §6)
// ---------------------------------------------------------------------------

export const DEPLOY = {
  /** Stateless API pods (01 §4): rolling by default; DB migrations gate the rollout (§5, §6). */
  strategy: 'rolling',
  /** A release is blocked until the CI determinism + perf gates are green (§6). */
  gatedByCi: [CI.DETERMINISM_WORKFLOW, CI.MAIN_WORKFLOW],
  /** Migrations run once, before the new image takes traffic, inside a transaction (§5). */
  migrateBeforeTraffic: true,
  /** Immutable published scene docs are content-addressed → safe to cache at the edge forever (09 §8). */
  cdnImmutableDocs: true,
} as const;
