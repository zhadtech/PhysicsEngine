/**
 * AI generation pipeline — TypeScript definitions.
 *
 * Normative source: 07-AI-PIPELINE.md. This file mirrors it for compile-time
 * safety in the proxy (Fastify), the Generate dialog's AI tab, and the eval
 * harness. Compile-tied to `types/procgen.ts` (knobs are a GenParams subset;
 * gates/report reuse the 06 §8 types), `types/scene.ts` (documents),
 * `types/protocol.ts` (analytics), and `types/api.ts` (error envelope).
 *
 * Unlike procgen (PG-1), generation is NOT a pure function — the model draw is
 * nondeterministic. Reproducibility lives in the accepted document, never the
 * prompt (07 §1 rule 4).
 */

import type { Id, Scene } from './scene';
import type { AnalyticsReport } from './protocol';
import type { GenParams, GateId, GateResult } from './procgen';
import type { ApiErrorBody } from './api';

/**
 * Semver of the compiled system prompt + few-shot corpus + SO-profile transform
 * (07 §4.1). Any content change bumps it; CI golden-hashes the compiled bytes.
 * Telemetry key together with the model id — never stored in documents.
 */
export const AI_PROMPT_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Model registry (07 §3.1) — pinned; changes are eval-gated (07 §9.3)
// ---------------------------------------------------------------------------

export type AiModelId = 'claude-opus-4-8' | 'claude-sonnet-5';

export const AI_MODELS = {
  /** The serving default. Never downgraded silently (07 §3.1). */
  default: 'claude-opus-4-8',
  /** Allowed in eval runs for comparison; serving swap requires 07 §9.3. */
  evalOnly: ['claude-sonnet-5'],
} as const satisfies { default: AiModelId; evalOnly: readonly AiModelId[] };

export type AiEffort = 'low' | 'medium' | 'high';

// ---------------------------------------------------------------------------
// Constants (07 §2–§4, §7) — single source for proxy + client + CI
// ---------------------------------------------------------------------------

export const AI = {
  /** Adaptive thinking is explicitly enabled (omitting it disables thinking on Opus 4.8). */
  THINKING: 'adaptive',
  /** Cost/quality lever; eval-tunable (07 §3.1). */
  EFFORT: 'high' as AiEffort,
  /** Per-call output ceiling — the spend cap (07 §3.1). */
  MAX_TOKENS: 16_000,

  /** User prompt length cap, characters (07 §4.2). */
  PROMPT_MAX_CHARS: 1000,
  /** Compiled system prompt budget, tokens — CI-enforced via count_tokens (07 §4.1). */
  PROMPT_BUDGET_TOKENS: 8000,
  /** Opus 4.8 minimum cacheable prefix; below it the system prompt silently doesn't cache. */
  PROMPT_MIN_CACHE_TOKENS: 4096,
  /** Shared system-prefix cache TTL (07 §4.4 breakpoint 1). */
  SYSTEM_CACHE_TTL: '1h',

  /** Structured-outputs shape rail on by default; freeform fallback per 07 §4.3. */
  USE_STRUCTURED_OUTPUTS: true,

  /** Repair calls per generation, server-enforced (07 §5.1). Total model calls ≤ 1 + this. */
  REPAIR_ROUNDS_MAX: 2,
  /** Redis transcript TTL, refreshed per round (07 §2.2). */
  SESSION_TTL_S: 600,
  /** Transcript size cap; overflow ends the generation (07 §2.2). */
  TRANSCRIPT_CAP_BYTES: 262_144,

  /** Sim-check target when neither knob nor durationHint exists (07 §5.2). */
  CHECK_DEFAULT_S: 60,
  /** G3 tolerance multiplier when the target is the model's own durationHint. */
  HINT_TOL_FACTOR: 2,

  /** Proxy log retention for prompts/usage (07 §7.4). */
  LOG_RETENTION_DAYS: 30,
} as const;

// ---------------------------------------------------------------------------
// Compiled prompt sections (07 §4.1) — fixed order, exhaustive
// ---------------------------------------------------------------------------

export type AiPromptSectionId =
  | 'role'
  | 'output-contract'
  | 'conventions'
  | 'world-meta'
  | 'catalog'
  | 'links'
  | 'physics-truths'
  | 'rules'
  | 'few-shot';

/** Normative assembly order (S1–S9). Reordering is a promptVersion bump. */
export const PROMPT_SECTIONS = [
  'role',
  'output-contract',
  'conventions',
  'world-meta',
  'catalog',
  'links',
  'physics-truths',
  'rules',
  'few-shot',
] as const;

type SectionMissing = Exclude<AiPromptSectionId, (typeof PROMPT_SECTIONS)[number]>;
type SectionExtra = Exclude<(typeof PROMPT_SECTIONS)[number], AiPromptSectionId>;
const _sectionsComplete: [SectionMissing] extends [never]
  ? true
  : ['PROMPT_SECTIONS misses:', SectionMissing] = true;
const _sectionsSound: [SectionExtra] extends [never]
  ? true
  : ['PROMPT_SECTIONS lists unknown section:', SectionExtra] = true;
void _sectionsComplete;
void _sectionsSound;

/**
 * Keywords the SO-profile transform strips (07 §4.3 T4) — the structured-outputs
 * API rejects or ignores them; their enforcement stays in the client G1 gate.
 * Shared by the build-time transform and its CI tests (spike 07 §11).
 */
export const SO_STRIPPED_KEYWORDS = [
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern',
  'minItems', 'maxItems', 'uniqueItems', 'prefixItems', 'contains',
  'not', 'unevaluatedProperties', 'format', 'default', '$comment',
  'propertyNames', 'minProperties', 'maxProperties', 'if', 'then', 'else',
] as const;

// ---------------------------------------------------------------------------
// Requests (07 §2, §4.2, §4.6)
// ---------------------------------------------------------------------------

/**
 * The AI tab's optional knobs — a strict subset of procgen's GenParams (same
 * names, same ranges: GEN_RANGES applies). Unset = "let the prompt decide";
 * only set knobs produce a user-turn line and activate their gate (07 §5.2).
 * `seed`, `difficulty`, and `chaos` are procgen-only concepts by design.
 */
export type AiKnobs = Partial<
  Pick<GenParams, 'durationS' | 'objectCount' | 'chains' | 'theme' | 'planeAngle' | 'allowedTypes'>
>;

export interface AiGenerateRequest {
  /** ≤ AI.PROMPT_MAX_CHARS characters; rides in the user turn only (07 §7.1). */
  prompt: string;
  knobs?: AiKnobs;
}

/** One repair-round finding, compiled client-side from the gate table (07 §4.6). */
export interface AiRepairFinding {
  gate: GateId;
  /** For G1_valid: "schema" or a 02 §8 rule id (E1–E8, W9–W12). */
  rule?: string;
  message: string;
  /** JSON pointer into the candidate, when locatable. */
  path?: string;
  /** Offending object/link ids, when known. */
  ids?: readonly Id[];
}

export interface AiRepairRequest {
  findings: readonly AiRepairFinding[];
}

// ---------------------------------------------------------------------------
// Stream contract (07 §2.3) — both operations respond text/event-stream
// ---------------------------------------------------------------------------

export interface AiQuota {
  /** Model calls left today after debiting this one (07 §7.3 aiCallsDay). */
  remainingCalls: number;
  /** ISO-8601 UTC bucket reset. */
  resetAt: string;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
}

/** Terminal status of one model call (07 §3.3). */
export type AiRoundStatus = 'candidate' | 'refused' | 'truncated' | 'unparseable';

export interface AiResultData {
  /** 0 = generate; 1.. = repair rounds. */
  round: number;
  status: AiRoundStatus;
  /** Present iff status === 'candidate'. Untrusted until it passes the client gate. */
  doc?: Scene;
  usage: AiUsage;
}

export type AiStreamEvent =
  | { event: 'meta'; data: { generationId: string; round: number; quota: AiQuota } }
  | { event: 'progress'; data: { outputTokens: number; elapsedMs: number } }
  | { event: 'result'; data: AiResultData }
  | { event: 'error'; data: ApiErrorBody };

// ---------------------------------------------------------------------------
// Gate profile (07 §5.2) — how the shared 06 §8 gates scale to AI candidates
// ---------------------------------------------------------------------------

export type AiGateWhen =
  | 'always'
  | 'goal-present'
  | 'knob-duration-or-hint'
  | 'knob-chains'
  | 'knob-count';

/**
 * Exhaustive over GateId (compile-enforced): when each gate is active for an AI
 * candidate, and what changes vs procgen. Tolerances come from PROCGEN unless
 * noted (hint-only G3 widens by AI.HINT_TOL_FACTOR).
 */
export const AI_GATE_PROFILE: Record<GateId, { when: AiGateWhen; note: string }> = {
  G1_valid: { when: 'always', note: 'E-rules hard; W-rules repairable, never blocking (07 §5.1)' },
  G2_success: { when: 'goal-present', note: 'waived + reported when the doc has no goal (06 §2.1 mirror)' },
  G3_duration: {
    when: 'knob-duration-or-hint',
    note: 'knob target at 06 tolerances; durationHint-only target at ×HINT_TOL_FACTOR',
  },
  G4_chains: { when: 'knob-chains', note: 'tree count only — no expectedRoots (there is no plan)' },
  G5_activation: { when: 'always', note: 'fraction ≥ ACTIVATION_MIN_FRAC; sentinel half is procgen-only' },
  G6_count: { when: 'knob-count', note: '±COUNT_TOL_FRAC of the knob' },
} as const;

// ---------------------------------------------------------------------------
// Report (07 §5.3, §8) — fuels the result card and telemetry, never documents
// ---------------------------------------------------------------------------

export type AiOutcome = 'satisfied' | 'closest' | 'failed';

export interface AiRoundInfo {
  status: AiRoundStatus;
  usage: AiUsage;
}

export interface AiReport {
  promptVersion: string;
  model: AiModelId;
  engineVersion: string;
  outcome: AiOutcome;
  /** Same shapes as procgen's report; inactive gates report pass with a waived note. */
  gates: Record<GateId, GateResult>;
  rounds: readonly AiRoundInfo[];
  /** Check-run analytics of the returned candidate (absent when outcome = failed). */
  analytics?: AnalyticsReport;
  majorChains?: number;
  objectsTotal: number;
  linksTotal: number;
  /** 02 §8 W-rule findings on the accepted doc — surfaced, never blocking. */
  warningsCount: number;
}
