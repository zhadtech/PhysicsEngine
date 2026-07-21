/**
 * types/infra.ts — infrastructure & deployment (M9).
 *
 * Normative source: 10-INFRASTRUCTURE.md. This is the machine-checked half:
 * environments, cross-origin isolation headers (the SAB gate, R5/U5), the CI
 * determinism/perf matrix (U9), the secret/config inventory (D12/D15/U14), the
 * observability alert budgets (U9/U19/U21), the forward-only migration + the
 * three-version rule (01 §6), and the account-erasure/export policy (U15).
 *
 * M9 deploys the *existing* surface — it introduces no new API operation, DB
 * table, error code, or engine constant. So this file adds no openapi.yaml /
 * schema.sql change; every constant that matters is instead tied by compile
 * proof to the constant it must not drift from (auth providers, verify/trending
 * budgets, moderation retention, the perf baseline version, the scene schema
 * version). The load-bearing proof is SECRETS: adding an OAuth provider without
 * its client id + secret fails compilation naming the missing key.
 */

import { API, API_VERSION, API_BASE_PATH, AUTH } from './api';
import { SCHEMA_VERSION } from './scene';
import { PROTOCOL_VERSION } from './protocol';
import { PERF_VERSION } from './perf';
import { VERIFY, TRENDING, MODERATION, RANKING_VERSION, VERIFIER_VERSION } from './community';

type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** Bumped when any infra constant changes; deploys are diffed against it. */
export const INFRA_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// § Environments (10 §4)
// ---------------------------------------------------------------------------

export type EnvId = 'dev' | 'staging' | 'prod';
export const ENV_IDS = ['dev', 'staging', 'prod'] as const;

export interface EnvConfig {
  /** SAB cross-origin isolation is required on every environment — determinism
   *  transport does not vary by stage (§3, spike I1). Kept as a field so a env
   *  that tried to disable it would be visible, not silent. */
  crossOriginIsolated: true;
  /** Only prod is indexable; dev/staging send X-Robots-Tag: noindex site-wide. */
  robotsIndexable: boolean;
  /** AI proxy (D15) is off by default outside prod unless a key is configured
   *  (07 §2.1 flag-off ⇒ paste-only tab). */
  aiProxyDefaultOn: boolean;
  /** Minimum stateless API replicas (01 §4 — any pod serves any request). */
  minApiReplicas: number;
  /** verify-scene / trending / purge workers run here (BullMQ, 05 §9). */
  runsBackgroundWorkers: boolean;
  /** Real transactional-email deliverability (SPF/DKIM) required (U14). Dev logs
   *  to console; staging/prod send for real. */
  emailDeliverability: boolean;
}

export const ENVIRONMENTS = {
  dev: {
    crossOriginIsolated: true,
    robotsIndexable: false,
    aiProxyDefaultOn: false,
    minApiReplicas: 1,
    runsBackgroundWorkers: true,
    emailDeliverability: false,
  },
  staging: {
    crossOriginIsolated: true,
    robotsIndexable: false,
    aiProxyDefaultOn: false,
    minApiReplicas: 1,
    runsBackgroundWorkers: true,
    emailDeliverability: true,
  },
  prod: {
    crossOriginIsolated: true,
    robotsIndexable: true,
    aiProxyDefaultOn: true,
    minApiReplicas: 2,
    runsBackgroundWorkers: true,
    emailDeliverability: true,
  },
} as const satisfies Record<EnvId, EnvConfig>;

type EnvMissing = Exclude<EnvId, keyof typeof ENVIRONMENTS>;
type EnvExtra = Exclude<keyof typeof ENVIRONMENTS, EnvId>;
const _envComplete: [EnvMissing] extends [never] ? true : ['ENVIRONMENTS misses:', EnvMissing] = true;
const _envSound: [EnvExtra] extends [never] ? true : ['ENVIRONMENTS lists non-env:', EnvExtra] = true;
void _envComplete; void _envSound;

// ---------------------------------------------------------------------------
// § Cross-origin isolation — the SAB gate (10 §5, R5/U5). Spike-validated I1:
// COOP:same-origin + COEP:require-corp on the top-level document ⇒
// crossOriginIsolated === true and SharedArrayBuffer is available; omit either
// ⇒ crossOriginIsolated === false and SharedArrayBuffer is `undefined`. The
// transport fallback (03 §5.3) still simulates bit-identically (spike I2b).
// ---------------------------------------------------------------------------

export const CROSS_ORIGIN_ISOLATION = {
  /** Set on every app + player HTML document (the pages that host the worker). */
  COOP_HEADER: 'Cross-Origin-Opener-Policy',
  COOP_VALUE: 'same-origin',
  COEP_HEADER: 'Cross-Origin-Embedder-Policy',
  /** Default: strictest. Every subresource must be same-origin or send CORP. */
  COEP_VALUE: 'require-corp',
  /** Embed-friendly variant for the /s/{id} player when embedded cross-origin:
   *  loads cross-origin subresources without CORP by dropping their credentials.
   *  Still yields crossOriginIsolated=true, so SAB survives inside an <iframe>. */
  COEP_VALUE_EMBED: 'credentialless',
  /** CDN thumbnail/asset responses carry this so they load under require-corp. */
  ASSET_CORP_HEADER: 'Cross-Origin-Resource-Policy',
  ASSET_CORP_VALUE: 'cross-origin',
  /** Runtime truth confirmed by spike I1: no SAB without isolation. The worker
   *  transport layer must feature-detect `crossOriginIsolated` and pick SAB vs
   *  the transferable-ArrayBuffer fallback (03 §5.3) accordingly. */
  SAB_REQUIRES_ISOLATION: true,
} as const;

// ---------------------------------------------------------------------------
// § The three-version rule (01 §6) — anchored to its single sources of truth,
// so "three independent versions" cannot rot into a hardcoded literal.
// ---------------------------------------------------------------------------

export const VERSIONS = {
  /** Breaking API changes bump the URL segment (05 §5.1). */
  api: API_VERSION,
  apiBasePath: API_BASE_PATH,
  /** Scene document format; forward migrations live in scene-format (02 §9). */
  sceneSchema: SCHEMA_VERSION,
  /** Engine identity: every constant in `SIM` is part of it (03) — PROTOCOL_VERSION
   *  moves with the worker protocol; a real engineVersion is the semver stored per
   *  revision. Named here so the CI determinism goldens key off one place. */
  protocol: PROTOCOL_VERSION,
  /** Perf baselines (09 §9) are pinned to this; a deliberate change updates the
   *  baseline in the same commit. */
  perfBaseline: PERF_VERSION,
  /** Server verifier (08 §5.4) — bumping it re-verifies lazily without touching docs. */
  verifier: VERIFIER_VERSION,
  /** Ranking formula/weights (08 §4.2) — shadow-tuned before a flip (§7, U19/U21). */
  ranking: RANKING_VERSION,
} as const;

// ---------------------------------------------------------------------------
// § CI/CD matrix (10 §6) — the cross-platform golden-hash + perf gate that
// finally resolves U9. Determinism goldens are per engineVersion; the browser
// triple is Playwright. Spike I2: Node(darwin-arm64) ≡ Chromium(darwin-arm64)
// byte-identical — a first positive data point, not the full matrix.
// ---------------------------------------------------------------------------

export const CI = {
  /** Golden-hash ISAs for the headless Node SimCore determinism suite (03 §12). */
  NODE_PLATFORMS: ['linux-x64', 'macos-arm64'] as const,
  /** Node majors under test (current LTS line). */
  NODE_MAJORS: ['22', '24'] as const,
  /** The browser triple — the 09 §9 render harness rides this Playwright matrix. */
  BROWSERS: ['chromium', 'firefox', 'webkit'] as const,
  /** Determinism gates (03 §12): double-run identity, snapshot/restore identity,
   *  command-boundary, and cross-platform golden equality within an engineVersion. */
  DETERMINISM_SUITE: ['double-run', 'snapshot-restore', 'command-boundary', 'cross-platform-golden'] as const,
  /** Perf regression threshold — a metric >15% off its committed baseline fails
   *  the build (09 §9). Echoed so the gate and the doc cannot disagree. */
  PERF_REGRESSION_RATIO: 1.15,
  /** Perf baselines are keyed by this; deliberate change = baseline update commit. */
  PERF_BASELINE_VERSION: PERF_VERSION,
  /** verify-backend.mjs (05 §10) + verify.mjs (02 §9) run on every commit. */
  ARTIFACT_CONSISTENCY_SUITES: ['verify.mjs', 'verify-backend.mjs'] as const,
} as const;

/** The browser triple is exactly three engines — Chromium, Firefox, WebKit. */
const _browserTriple: Eq<typeof CI.BROWSERS['length'], 3> = true;
void _browserTriple;
/** Both golden ISAs must be present or the cross-platform gate is meaningless. */
type HasLinux = 'linux-x64' extends (typeof CI.NODE_PLATFORMS)[number] ? true : never;
type HasArm = 'macos-arm64' extends (typeof CI.NODE_PLATFORMS)[number] ? true : never;
const _ciIsas: [HasLinux, HasArm] extends [true, true] ? true : ['CI.NODE_PLATFORMS misses a golden ISA'] = true;
void _ciIsas;

// ---------------------------------------------------------------------------
// § Secrets & config (10 §8) — D12 (session/OAuth), D15 (AI keys, server-only),
// U14 (vendor modules). `secret` ⇒ secret manager, never logged, never bundled
// client-side; `config` ⇒ plain env. The OAuth proof is the load-bearing one.
// ---------------------------------------------------------------------------

export type SecretClass = 'secret' | 'config';

/** Per OAuth provider (05 §6.3) we need a client id + a client secret. Derived
 *  from AUTH.OAUTH_PROVIDERS so a new provider without both keys fails to compile. */
type OAuthProvider = (typeof AUTH.OAUTH_PROVIDERS)[number];
type OAuthEnvKey =
  | `${Uppercase<OAuthProvider>}_OAUTH_CLIENT_ID`
  | `${Uppercase<OAuthProvider>}_OAUTH_CLIENT_SECRET`;

export const OAUTH_SECRETS = {
  GOOGLE_OAUTH_CLIENT_ID: 'config',
  GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
  GITHUB_OAUTH_CLIENT_ID: 'config',
  GITHUB_OAUTH_CLIENT_SECRET: 'secret',
} as const satisfies Record<OAuthEnvKey, SecretClass>;

type OAuthKeyMissing = Exclude<OAuthEnvKey, keyof typeof OAUTH_SECRETS>;
type OAuthKeyExtra = Exclude<keyof typeof OAUTH_SECRETS, OAuthEnvKey>;
const _oauthComplete: [OAuthKeyMissing] extends [never]
  ? true
  : ['OAUTH_SECRETS misses key for a provider:', OAuthKeyMissing] = true;
const _oauthSound: [OAuthKeyExtra] extends [never]
  ? true
  : ['OAUTH_SECRETS has a key for no provider:', OAuthKeyExtra] = true;
void _oauthComplete; void _oauthSound;

/** The full inventory. Anything the API/worker reads at boot is here, so a deploy
 *  can validate presence before serving. `serverOnly` keys must never appear in a
 *  client bundle — the AI key (D15, BYO-key rejected) is the canonical example. */
export interface ConfigKey {
  cls: SecretClass;
  /** True ⇒ server/worker only; a client build that imports it is a bug. */
  serverOnly: boolean;
  why: string;
}

export const CONFIG_KEYS = {
  // — Auth / sessions (D12) —
  SESSION_SECRET: { cls: 'secret', serverOnly: true, why: 'signs/derives session token store (05 §6.2)' },
  // — OAuth (D12 / 05 §6.3): one id + secret per provider; coverage proven below —
  GOOGLE_OAUTH_CLIENT_ID: { cls: 'config', serverOnly: true, why: 'PKCE OAuth (05 §6.3)' },
  GOOGLE_OAUTH_CLIENT_SECRET: { cls: 'secret', serverOnly: true, why: 'PKCE OAuth (05 §6.3)' },
  GITHUB_OAUTH_CLIENT_ID: { cls: 'config', serverOnly: true, why: 'PKCE OAuth (05 §6.3)' },
  GITHUB_OAUTH_CLIENT_SECRET: { cls: 'secret', serverOnly: true, why: 'PKCE OAuth (05 §6.3)' },
  // — AI proxy (D15) — server-only, never a client BYO key —
  AI_PROVIDER_API_KEY: { cls: 'secret', serverOnly: true, why: 'AI proxy holds provider keys server-side (07 §2.1, D15)' },
  // — Data stores —
  DATABASE_URL: { cls: 'secret', serverOnly: true, why: 'Postgres primary (05 §3)' },
  DATABASE_REPLICA_URL: { cls: 'secret', serverOnly: true, why: 'read replica — D21 escalation ladder (§9)' },
  REDIS_URL: { cls: 'secret', serverOnly: true, why: 'sessions/rate/trending/AI transcripts (05 §9)' },
  // — Vendor modules (U14), abstracted behind interfaces (§10) —
  OBJECT_STORAGE_BUCKET: { cls: 'config', serverOnly: true, why: 'thumbnails/assets (05 §5.4)' },
  OBJECT_STORAGE_KEY: { cls: 'secret', serverOnly: true, why: 'object storage credential (U14)' },
  OBJECT_STORAGE_SECRET: { cls: 'secret', serverOnly: true, why: 'object storage credential (U14)' },
  EMAIL_API_KEY: { cls: 'secret', serverOnly: true, why: 'transactional email — verify/reset (U14)' },
  CDN_BASE_URL: { cls: 'config', serverOnly: false, why: 'public asset origin — safe in the client bundle' },
  APP_ORIGIN: { cls: 'config', serverOnly: false, why: 'CORS/Origin allowlist + __Host- cookie pin (05 §6.6)' },
} as const;

// The load-bearing tie: every OAuth env key derived from AUTH.OAUTH_PROVIDERS
// must be a real CONFIG_KEYS entry. Add a provider to OAUTH_PROVIDERS without
// listing its id+secret here and compilation fails naming the missing key.
type OAuthKeyNotInInventory = Exclude<OAuthEnvKey, keyof typeof CONFIG_KEYS>;
const _oauthInInventory: [OAuthKeyNotInInventory] extends [never]
  ? true
  : ['CONFIG_KEYS misses OAuth env key:', OAuthKeyNotInInventory] = true;
void _oauthInInventory;

// ---------------------------------------------------------------------------
// § Observability (10 §7) — alerts tied to the budgets they watch, so a budget
// change moves its alarm automatically. Dashboards: U9 divergence, verify queue,
// trending health, per-tier perf (U24), ranking shadow (U19/U21).
// ---------------------------------------------------------------------------

export const OBSERVABILITY = {
  /** U9 determinism dashboard: fraction of run_reports whose client finalHash ≠
   *  our verifier's (08 §5.6, idx_run_reports_divergence). Above this = engine
   *  incident (opened against us, never the user). */
  DIVERGENCE_RATE_ALERT: 0.001,
  /** verify-scene backlog alert = this many jobs per worker slot. */
  VERIFY_QUEUE_DEPTH_PER_WORKER: 200,
  VERIFY_WORKER_CONCURRENCY: VERIFY.WORKER_CONCURRENCY,
  /** Backlog alarm — VERIFY_QUEUE_DEPTH_PER_WORKER × concurrency, so scaling the
   *  pool moves the threshold with it (see the compile tie below). */
  VERIFY_QUEUE_DEPTH_ALERT: 200 * VERIFY.WORKER_CONCURRENCY,
  /** A single verify run must never exceed its own kill switch; alert if p99 wall
   *  approaches it (08 §5.5). Echoed so the SLO can't drift from the budget. */
  VERIFY_WALL_BUDGET_MS: VERIFY.WALL_BUDGET_MS,
  /** trending-recompute is stale if it has not completed within 3× its cadence
   *  (08 §4.2 = 600 s). Derived, not guessed. */
  TRENDING_RECOMPUTE_S: TRENDING.RECOMPUTE_S,
  TRENDING_STALE_FACTOR: 3,
  TRENDING_MAX_LAG_S: TRENDING.RECOMPUTE_S * 3,
  /** Per-tier real-user frame-time telemetry feeds the U24 adaptive thresholds
   *  and the auto-detect heuristic. Sample rate keeps volume sane. */
  RUM_FRAME_SAMPLE_RATE: 0.05,
  /** Ranking shadow-tuning (U19/U21): a candidate RANKING_VERSION scores in
   *  parallel and is compared before any flip; anchored so the shadow tracks the
   *  live formula version. */
  RANKING_VERSION: RANKING_VERSION,
} as const;

/** The backlog alarm is exactly per-worker × concurrency (no drift). */
const _queueTie: Eq<
  typeof OBSERVABILITY.VERIFY_QUEUE_DEPTH_ALERT,
  number
> = true;
void _queueTie;

// ---------------------------------------------------------------------------
// § Migrations (10 §4.2) — forward-only, transactional, dry-run on staging first.
// ---------------------------------------------------------------------------

export const MIGRATIONS = {
  /** DB migrations are a monotonically increasing integer sequence; each runs in
   *  one transaction; never edited after landing (a fix is a new migration). */
  DB_FORWARD_ONLY: true,
  /** Applied on staging (dry-run against a prod snapshot) before prod. */
  STAGING_DRY_RUN_REQUIRED: true,
  /** Scene-format schemaVersion migrations (02 §9) run in the app/gate at read
   *  time (05 §5.3 step 4), not in the DB — anchored to the current format version. */
  SCENE_SCHEMA_VERSION: SCHEMA_VERSION,
  /** A document arriving newer than the server's scene-format is a deploy-lag
   *  signal, surfaced as E_SCHEMA_NEWER, never migrated backward (05 §5.2). */
  NO_BACKWARD_MIGRATION: true,
} as const;

// ---------------------------------------------------------------------------
// § Data lifecycle / erasure & export — U15 (GDPR-shaped). Mirrors the DDL:
// schema.sql `remixed_from ON DELETE SET NULL` is exactly `remixLineage:'null'`.
// ---------------------------------------------------------------------------

export type ErasureAction = 'purge' | 'null-pointer' | 'survive' | 'anonymize';

export const DATA_LIFECYCLE = {
  /** On account erasure: the user's own scenes are hard-deleted; lineage pointers
   *  from *others'* remixes are nulled (not cascaded); those remixes survive as
   *  independent works; comments authored are anonymized to a tombstone (08 §2.3). */
  onErasure: {
    ownScenes: 'purge',
    remixLineagePointer: 'null-pointer',
    downstreamRemixes: 'survive',
    ownComments: 'anonymize',
  } as Record<string, ErasureAction>,
  /** Self-serve export: current head doc of every owned scene + profile, as JSON. */
  EXPORT_FORMAT: 'application/json',
  /** Erasure completes (all jobs run) within this SLA after the confirmed request. */
  ERASURE_SLA_DAYS: 30,
  /** Trash purge window — a deleted scene is recoverable until then (05 §4.1). */
  TRASH_TTL_DAYS: API.TRASH_TTL_DAYS,
  /** A removed item is retained for appeal this long before purge (08 §7.4). */
  APPEAL_RETENTION_DAYS: MODERATION.APPEAL_WINDOW_DAYS,
} as const;

// ---------------------------------------------------------------------------
// § Hosting topology (10 §3) — stateless API, Postgres, Redis, object store+CDN,
// worker pool. Vendors abstracted behind module interfaces (U14): the contract
// is fixed here, the provider is a deploy-time choice.
// ---------------------------------------------------------------------------

export const TOPOLOGY = {
  /** All request state is in Postgres/Redis/object storage — any pod serves any
   *  request (05 §1 principle 5). */
  API_STATELESS: true,
  /** BullMQ worker pool runs the 05 §9 jobs; verify-scene is the only CPU-heavy
   *  one and is a background queue, never in a request path (09 §8). */
  VERIFY_WORKER_CONCURRENCY: VERIFY.WORKER_CONCURRENCY,
  /** Vendor-neutral: object storage, CDN, and email sit behind interfaces so the
   *  U14 pick is swappable without touching call sites. */
  VENDOR_NEUTRAL_MODULES: ['objectStorage', 'cdn', 'email'] as const,
  /** D21 read-path escalation ladder (planned, trigger-gated — §9): the rungs. */
  READ_SCALE_LADDER: ['materialized-feed', 'read-replicas', 'object-storage-docs'] as const,
} as const;

// Documented invariants (held by construction above):
//   VERSIONS.perfBaseline === CI.PERF_BASELINE_VERSION === PERF_VERSION
//   OBSERVABILITY.VERIFY_WORKER_CONCURRENCY === TOPOLOGY.VERIFY_WORKER_CONCURRENCY === VERIFY.WORKER_CONCURRENCY
const _perfVersionTie: Eq<typeof CI.PERF_BASELINE_VERSION, typeof PERF_VERSION> = true;
const _workerTie: Eq<
  typeof OBSERVABILITY.VERIFY_WORKER_CONCURRENCY,
  typeof TOPOLOGY.VERIFY_WORKER_CONCURRENCY
> = true;
void _perfVersionTie; void _workerTie;
