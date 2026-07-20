# 07 — AI Generation Pipeline

**Status:** Accepted (Session 7, 2026-07-20) — normative for the AI generation feature
**Covers:** brief item 9 (natural-language prompt → scene JSON)
**Consumes:** `02-SCENE-FORMAT.md` (catalog, rules, gate), `03-SIMULATION-CORE.md` (SimCore, analytics), `04-BUILDER-UX.md` (Generate dialog, clipboard/import, undo), `05-BACKEND.md` (API conventions, error model, rate limits), `06-PROCGEN.md` §8 (the shared check harness — the M6 contract)
**Companion files:** `types/ai.ts` (params, report, stream events, constants); additions to `openapi.yaml`, `types/api.ts`, `05-BACKEND.md` (two operations, two error codes, rate buckets)
**Consumed by:** M8 (progress-UX perf), M9 (CI evals, observability, secrets)

---

## 1. Scope and architecture

The pipeline turns a natural-language prompt into a scene document that **provably works**, by the same standard as procgen: the model's output is only a *candidate* until it has passed the full 02 validation gate and headless simulation in `check.ts` (06 §8.1 — reused verbatim, its designed-for-M6 contract).

```
Browser                                   Backend (proxy)              Anthropic API
┌─────────────────────────┐   POST /ai/generate  ┌──────────────┐   messages.stream
│ Generate dialog (AI tab)│ ───────────────────► │ auth · quota │ ─────────────────►
│  prompt + optional knobs│  ◄── SSE: progress…  │ prompt build │ ◄── SSE tokens ───
│                         │  ◄── SSE: result ────│ Redis state  │   claude-opus-4-8
│ procgen worker          │                      └──────────────┘
│  check.ts (06 §8):      │      candidate doc
│  G1 gate → sim gates ───┼── findings ──► POST /ai/generate/{id}/repair (≤ 2) ──►
│  → insert / report      │
└─────────────────────────┘
```

Hard rules:

1. **The output is an ordinary scene document.** Same gate, same save path, no provenance fields, no special server handling (ADR-0005 rule 5; identical to 06 §10.2). The dialog tags accepted scenes `meta.tags += ["ai"]` client-side (user-removable) — the only marker, mirroring procgen's.
2. **The proxy is thin.** It holds the provider key, compiled prompts, quotas, and per-generation transcript state — and treats candidates as opaque text bounded by size caps. It never parses scenes beyond "is it JSON and under the cap", never simulates (D4), never repairs on its own.
3. **All gates run client-side.** G1 (ajv strict + semantic rules) and the simulated gates run in the procgen worker via `check.ts` — the browser has SimCore; the server never will. The client compiles findings into repair prompts and calls the repair endpoint (01 §5's "client validates + auto-repairs" made concrete).
4. **Generation is not reproducible — the scene is.** Unlike procgen (PG-1), an LLM call is not a pure function; the same prompt can yield different machines. Once accepted, the document is plain deterministic scene data (`world.seed` included). The dialog says "save the scene, not the prompt"; regeneration is explicitly a new draw.

---

## 2. Serving architecture — D15

**Decision: a server-side proxy owns the provider relationship.** Two operations, session-auth, streaming responses. Client-supplied provider keys (BYO-key) are rejected for v1: keys in browsers leak, support burden is real, per-user keys fragment the prompt cache (§4.4 — the shared cache is a large cost win), and quota enforcement becomes voluntary. A self-host escape hatch is config, not UI: deployments without a key ship with the feature flag off (tab shows the paste path only, §6.4); the endpoints answer `E_AI_UNAVAILABLE`.

### 2.1 Operations (added to `openapi.yaml` + `ROUTES`)

| Op | Method/path | Auth | Purpose |
|---|---|---|---|
| `aiGenerate` | `POST /ai/generate` | `session` | Round 0: prompt + optional knobs → streamed candidate |
| `aiRepair` | `POST /ai/generate/{generationId}/repair` | `session` | Round n: gate findings → streamed corrected candidate |

Both respond `200` with `text/event-stream` (§2.3). Pre-stream failures use the ordinary JSON error envelope (05 §5.2); the codes below join `ApiErrorCode` (three-way checked like the rest):

| Code | HTTP | Meaning |
|---|---|---|
| `E_AI_BUDGET` | 429 | Daily AI budget exhausted (`Retry-After` = reset). Distinct from `E_RATE_LIMITED` because the client treats it differently: quota meter + disabled tab, not backoff. |
| `E_AI_UNAVAILABLE` | 503 | Upstream provider down/overloaded (after SDK retries), or feature unconfigured. `Retry-After` when known. |

Reused codes: `E_BAD_REQUEST` (prompt too long, malformed knobs), `E_AUTH_REQUIRED`, `E_CONFLICT` (a generation is already running for this user, or repair rounds exhausted / unknown `generationId`), `E_RATE_LIMITED` (burst bucket).

### 2.2 Per-generation state (Redis)

The repair loop needs the model-side conversation. The client never supplies transcript turns — it sends only findings; the proxy reconstructs messages from its own record. That keeps turn integrity (a client cannot forge assistant turns or smuggle system-prompt overrides), makes round caps structural (the server counts), and keeps the byte-exact prefix for caching (§4.4).

- Key `ai:gen:{generationId}` → `{ userId, model, promptVersion, round, messages[] }`; TTL `AI.SESSION_TTL_S` (600 s, refreshed per round); capped at `AI.TRANSCRIPT_CAP_BYTES` (256 KiB — 3 rounds of large candidates fit; overflow ends the generation with `E_CONFLICT`).
- One concurrent generation per user (Redis lock, `E_CONFLICT` on second). State is disposable — a lost transcript just means "Try again"; nothing durable depends on Redis (05 §9 rule kept).
- **No schema change.** Daily budgets are Redis counters like every 05 §8 bucket; durable spend accounting is observability (M9), not rows.

### 2.3 Stream vocabulary (both operations)

Server-sent events, in order; `types/ai.ts` `AiStreamEvent` is the contract:

| Event | Payload | Notes |
|---|---|---|
| `meta` | `{ generationId, round, quota }` | First event; quota = `{ remainingCalls, resetAt }` after debiting this call. |
| `progress` | `{ outputTokens, elapsedMs }` | ~2/s while the model streams (derived from the provider stream; raw tokens are never forwarded). |
| `result` | `{ round, status, doc?, usage }` | Terminal. `status`: `candidate` (doc present) · `refused` · `truncated` · `unparseable` (§3.3). `usage` = token counts incl. cache reads. |
| `error` | the 05 §5.2 envelope body | Terminal, for failures after the stream opened (upstream drop mid-call → `E_AI_UNAVAILABLE`). |

A call is debited from the budget when the provider call starts, regardless of outcome — model tokens were spent (`refused` before output costs ~nothing but still counts one call; keeping the rule simple beats litigating refunds).

---

## 3. Model strategy — D16 (with §4)

### 3.1 Model, thinking, streaming

- **Pinned default `claude-opus-4-8`** ($5 in / $25 out per MTok, 1 M context) via the official TypeScript SDK (`@anthropic-ai/sdk`) in the Fastify app. The registry `AI.MODELS` also lists `claude-sonnet-5` ($3/$15) as *eval-only*: any swap or downgrade is an eval-gated config decision (§9.3), never silent. The model id is telemetry, not document data.
- **Adaptive thinking, explicitly on**: `thinking: { type: "adaptive" }` (on Opus 4.8, omitting the field runs *without* thinking), `output_config: { effort: AI.EFFORT }` (`high` default; `medium` is the eval-tunable cost lever). `display` stays omitted — reasoning is never shown.
- **Always streamed** (`messages.stream`): feeds §2.3 progress, avoids HTTP timeouts, and lets the proxy kill runaway calls.
- `max_tokens = AI.MAX_TOKENS` (16 000): the per-call spend ceiling (≤ $0.40 output). A ~60-object scene is ~1.5–2.5 k tokens; 16 k covers ~400 objects plus thinking headroom.

### 3.2 Request shape (normative sketch)

```ts
client.messages.stream({
  model: AI.MODELS.default,                      // 'claude-opus-4-8'
  max_tokens: AI.MAX_TOKENS,
  thinking: { type: 'adaptive' },
  output_config: {
    effort: AI.EFFORT,
    ...(soProfileAccepted && { format: { type: 'json_schema', schema: SO_PROFILE } }), // §4.3
  },
  system: [{ type: 'text', text: COMPILED_PROMPT,          // §4.1 — byte-stable
             cache_control: { type: 'ephemeral', ttl: '1h' } }],
  cache_control: { type: 'ephemeral' },          // top-level auto: caches the transcript tail per round
  messages,                                      // §2.2 transcript + this round's user turn
});
```

### 3.3 Stop-reason handling (proxy)

| `stop_reason` | `result.status` | Client behavior |
|---|---|---|
| `end_turn`, JSON extracted (§4.3) | `candidate` | Run the check loop (§5) |
| `end_turn`, no JSON object found | `unparseable` | Counts as a failed round; repair round asks for JSON-only if rounds remain |
| `max_tokens` | `truncated` | Repair round instructs "smaller machine, ≤ N objects"; if rounds exhausted → outcome `failed` |
| `refusal` | `refused` | Neutral copy ("The AI declined this prompt"); `stop_details.category` logged, never shown; no auto-retry |

---

## 4. Prompt pipeline — D16 (with §3)

### 4.1 Compiled system prompt

Built **at build time** by `packages/ai/prompt-compile.ts` from the 02 spec — the catalog tables are the single source; the prompt can never drift from the validator because both are generated from the same document. Output is one byte-stable string, versioned `AI_PROMPT_VERSION` (semver; any content change bumps it), golden-hashed in CI.

Fixed section order (`AI.PROMPT_SECTIONS`, exhaustive in `types/ai.ts`):

| # | Section | Content (condensed from) |
|---|---|---|
| S1 | `role` | Task framing: you emit one scene JSON document for a 2D physics sandbox; nothing else. |
| S2 | `output-contract` | JSON only, no fences/prose; strict writer (omit defaults, ≤ 4 fractional digits, `−0 → 0`); ids `^[A-Za-z0-9_-]{1,24}$`, one namespace, builder-style prefixes (`dom1`, `tri1` — 04 conventions); include a `goal` unless the prompt clearly wants an endless/ambient machine; set `meta.title/description/durationHint` from the prompt; set `world.seed` (any uint32) and `world.bounds` to fit the machine + 0.2 m margin. |
| S3 | `conventions` | 02 §2: SI units, **degrees**, X right / Y up, origin center, desk scale, 2D density (kg/m²). |
| S4 | `world-meta` | 02 §3–§4 field tables with ranges/defaults. |
| S5 | `catalog` | 02 §5.2–§5.3 condensed per type: props, defaults, ranges, reference point / `rot` meaning. |
| S6 | `links` | 02 §6 link catalog + named-anchor table. |
| S7 | `physics-truths` | What makes machines actually run: only self-starting objects move at step 0 (06 CT-1); rest objects *exactly* on surfaces (marble `y = top + r`, domino base on top, crate `y = top + h/2` — 06 §7.2); signal receivers are the 02 §5.4 table, `active:false`/`triggered` for off→on; timing facts for duration targets (85 ms/domino at default spacing, ramp exit `0.92·√(4gΔy/3)`, fall `√(2h/g)`, conveyor `w/speed`, flats never brake — 06 §12); keep every trajectory inside `world.bounds` (bodies past bounds + 2 m are removed). |
| S8 | `rules` | 02 §8 E1–E8 verbatim-condensed + "avoid warnings W9–W12". |
| S9 | `few-shot` | The committed corpus (§4.5): 3 prompt → document pairs, minified. |

**Budget:** spike-measured upper bound (uncondensed 02 §2–§8 + few-shots + boilerplate) ≈ 21.6 k chars ≈ **5.4–6.3 k tokens**; the condensed compile must land ≤ `AI.PROMPT_BUDGET_TOKENS` (8 000) and ≥ 4 096 (the Opus 4.8 cache-minimum — below it the prefix silently doesn't cache). CI enforces both via the real `count_tokens` endpoint (estimate-only until implementation — U18).

### 4.2 User turn

```
Build this machine.
Prompt: {user text, ≤ AI.PROMPT_MAX_CHARS = 1000 chars}
{one line per explicitly-set knob: "Target duration: 45 s" · "Target objects: 80" ·
 "Major chain reactions: 2" · "Theme skins: candyland" · "Plane angle: 10°" ·
 "Allowed types: domino, marble, ramp, platform, goal"}
```

Knobs are the AI tab's optional fields (§6.1), a subset of procgen's `GenParams` — same names, same ranges (`types/ai.ts` reuses the `GenParams` field types). Unset knobs produce no line: the prompt decides, and the gates scale accordingly (§5.2). User text is data inside the user turn; it cannot displace S1–S9 (§7.1).

### 4.3 Structured-outputs shape rail (SO-profile)

Anthropic structured outputs cannot enforce `scene.schema.json` as-is: the API rejects/ignores numeric ranges (`minimum`/`maximum` — 69 pairs), string and array bounds, `pattern`, `oneOf`, `not`, and `unevaluatedProperties`, and requires `additionalProperties: false` on every object. So the build step derives a **profile** — a syntactic rail that guarantees parseable JSON with the right keys, discriminated variants, and no stray properties, while the *full* schema remains the authoritative gate (G1, client-side ajv):

| Rule | Transform |
|---|---|
| T1 | Inline every `$ref` (schema is non-recursive; the transform asserts it) |
| T2 | Flatten `allOf` compositions into self-contained object schemas (merge `properties`/`required`; drop `unevaluatedProperties`) |
| T3 | `oneOf` → `anyOf` (branches carry discriminating `const`s; equivalent in practice) |
| T4 | Strip unsupported constraint keywords (`minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `minItems`, `maxItems`, `uniqueItems`, `not`, …) — their enforcement stays in G1 |
| T5 | `additionalProperties: false` on every object schema; `required` kept only when non-empty |

Spike results (§11): profile = 14 KB minified; corpus scenes valid under full schema stay valid under the profile (relaxation holds); unknown keys are rejected by the profile (the rail bites); out-of-range values pass the profile and fail the full schema (G1 stays authoritative); transform assertions all bite under mutation. Passed as `output_config.format`; sent with `AI.USE_STRUCTURED_OUTPUTS` on (default). If the API rejects the schema (size/keyword — unverified live, U18), the proxy logs, flips to freeform for the call, and falls back to **tolerant extraction**: strip markdown fences, take first `{` through last `}`, parse; failure → `unparseable`. Extraction is deterministic and applies in freeform mode only (with the rail on, output is bare JSON by construction).

### 4.4 Prompt caching

Prefix order is `tools (none) → system → messages`; two breakpoints:

1. **System breakpoint, 1 h TTL** — the compiled prompt is identical for every user and request (no timestamps, no user ids, knobs live in the user turn), so the whole platform shares one cache entry per (`model`, `AI_PROMPT_VERSION`). At any sustained traffic it stays warm: reads at 0.1× ≈ $0.003/call vs $0.03 uncached — the shared-cache argument for D15. (1 h writes cost 2×; break-even at ~3 reads/hour globally.)
2. **Top-level auto breakpoint (5 m)** — caches the transcript tail, so repair round *n* re-reads round *n−1*'s prefix instead of re-billing it.

The 05 §9 rule holds: Redis/caches are never the only copy of anything; a cold cache is a cost blip, not a failure.

### 4.5 Few-shot corpus

Committed at `packages/ai/fewshot/` as (prompt, document) pairs; v1 = 02 §10.1, 02 §10.2, and the M6 `ai-exemplar` (a trigger→piston relay showing wiring + fuller `meta`). Every corpus document must pass the full gate in CI (ajv strict — already exercised in the spike) — a broken exemplar would *teach* the model mistakes.

### 4.6 Repair turns

The client's findings compiler turns the §5 gate table into one user-role message per round:

```
Your machine failed validation/simulation. Fix every issue and return the FULL
corrected JSON document (no fences, no commentary, keep working parts unchanged).
Issues:
- [G1/E2] link "r1" endpoint b.obj = "bax" does not exist            (path /links/0)
- [G3] simulated duration 11.2 s vs target 45 s — machine too short: lengthen
  the run (more dominoes ≈ 85 ms each, longer conveyor, extra stages)
- [G5] 14 of 31 movable objects never activated: the marble flies over the
  domino run — lower the launch or raise the run
```

Findings carry rule/gate ids, offending ids/paths (from `ApiFinding` and `GateResult.detail`), and the 06 §8.5 diagnosis language mapped to prose. Full-document responses (not diffs): byte-simple, and models are reliable at re-emission at these sizes.

---

## 5. Validation & repair loop (client)

### 5.1 Rounds

```
round 0: candidate ← generate(prompt, knobs)
loop:
  G1: scene-format gate (ajv strict + E-rules). E-failures → findings.
      W-rules → findings while rounds remain; on the final accepted doc they
      surface as ordinary builder warnings (04 §8.5), never blocking — unlike
      procgen's zero-W rule (a W from *our* generator is a bug; from a model
      it's a repairable imperfection).
  if G1 errors: repair (if rounds left) else outcome = failed
  else: sim gates via check.ts(scene, aiExpectations) — 06 §8 harness verbatim
        all pass → outcome = satisfied
        else repair (if rounds left) else outcome = closest (best G1-passing
        candidate by the 06 §8.3 score over active gates)
rounds: ≤ AI.REPAIR_ROUNDS_MAX (2) repair calls — server-enforced per §2.2.
```

`failed` (no G1-passing candidate) shows the error state + paste path (§6.4); the raw text is offered for copy-out, never inserted.

### 5.2 Expectations — gates scale to what was asked

`check.ts` takes `(scene, expectations)` (06 §8.1); for AI the expectations derive from the knobs, with prompt-implied targets self-reported by the model through the document itself:

| Gate | Active when | Target / tolerance |
|---|---|---|
| G1 valid | always | hard (E-rules; W handling per §5.1) |
| G2 success | doc contains a `goal` | hard (mirrors 06 §2.1 waiver otherwise; report says so) |
| G3 duration | duration knob set — else doc has `meta.durationHint` | knob: 06 tolerances (max(2 s, 15%)); hint-only: ×2 tolerance (self-consistency — the machine should run about as long as the model claims) |
| G4 chains | chains knob set | exact count of trees ≥ 3 edges (no `expectedRoots` check — there is no plan) |
| G5 activation | always | `objectsActivated / activatable ≥ 0.85` (fraction half only; sentinels are procgen's) |
| G6 count | objects knob set | ±20% |

Sim budget: `SIM_FACTOR_CAP` (2×) × target duration (knob, else `durationHint`, else `AI.CHECK_DEFAULT_S` 60), inside the engine hard cap — same accounting as 06 §8.4.

### 5.3 Report

`AiReport` (`types/ai.ts`): outcome, per-gate `GateResult`s (procgen's types reused), per-round `status` + token usage, model + `AI_PROMPT_VERSION` + `engineVersion`, analytics of the accepted candidate's check run, totals. Fuels the result card (§6.2) and telemetry (§8). Never stored in the document.

---

## 6. Generate dialog — AI tab (04 §3.1's reserved affordance, second half)

### 6.1 Form

- **Prompt** textarea, counter to 1 000 chars; placeholder cycles the brief's examples ("Build a 60-second marble run…").
- **Optional knobs** (collapsed "Guide it" row): duration, object count, chains, theme, plane angle, allowed types — each defaulting to *Let the prompt decide* (unset ⇒ no user-turn line, gate inactive/scaled per §5.2). Same widgets as the Procedural tab (06 §10.1).
- **Generate** button with quota chip ("{remainingCalls} left today" from the last `meta` event; `E_AI_BUDGET` disables with reset time). Disclosure line: "Prompts are sent to our AI provider."

### 6.2 Progress and result

States: **sending → generating** (token progress bar from `progress` events + elapsed) **→ checking** (gate ticks, reusing the procgen progress row) **→ repairing r/2 → done**. Cancel while generating aborts the stream (the call still counts, §2.3); cancel while checking returns to the form.

Result card = procgen's card (06 §10.1) with AI deltas: gate table with ✓/✗ + deltas, rounds/tokens used, outcome banner for `closest` and `refused`/`truncated`/`failed` copy. Actions: **Insert** (one composite undo op, exactly 04 §9 / 06 §10.1), **Try again** (same form, new generation), **Edit prompt**.

### 6.3 Insert and after

Identical to procgen: replaces the document as one undo step; save/publish/thumbnail all ordinary (06 §10.2). The dialog appends `"ai"` to `meta.tags` on insert (user-removable).

### 6.4 Paste path (fallback and zero-cost lane)

The tab always includes **"…or paste scene JSON"**: a paste box feeding the same client loop — tolerant extraction (§4.3) → G1 → `check.ts` with the current knobs → same result card (Insert/report). This is the 04 §5.5-adjacent full-document path: it serves users bringing JSON from external AI chats, degrades the feature gracefully when the proxy is unconfigured (flag off ⇒ the tab renders only this), and costs nothing. Fragments (the 04 §5.5 clipboard format) still go through ordinary paste in the canvas, not this dialog.

---

## 7. Safety, abuse, and cost

### 7.1 Prompt injection & content

- **Bounded blast radius by construction:** the model has no tools, fetches nothing, and its only output channel is a JSON candidate that must survive the full gate; user text rides in the user turn and cannot displace the system prompt (§2.2 — clients never supply transcript turns). The worst a hostile prompt achieves is a weird-but-valid scene *for its own author*.
- **Text fields:** generated `meta.title/description/tags` are the author's own document content — the same moderation surface as hand-typed titles (publish gates 05 §6.4; community reporting lands with M7). No extra M6 machinery.
- **Refusals** (§3.3) are surfaced neutrally and logged with `stop_details.category` for abuse monitoring; repeated-refusal patterns feed the M9 abuse dashboards.

### 7.2 Cost model (Opus 4.8, list prices)

| Component | Typical | Notes |
|---|---|---|
| System prefix ~6 k tok | $0.003 cached / $0.03 cold | §4.4; shared platform-wide |
| User turn + transcript | < $0.01 | round 0 tiny; repairs read prior rounds mostly from cache |
| Output (thinking + doc) | 2–6 k tok → $0.05–0.15/call | `max_tokens` caps a call at ≈ $0.40 output |
| **Accepted scene (≈ 1.2 calls avg)** | **≈ $0.08–0.20** | worst case 3 calls at cap ≈ $1.25 |

Daily budget 20 calls/user ⇒ hard ceiling ≈ $8/user/day at the cap, typical heavy use $1–2 — the free-tier knob to tune with real data (`AI.QUOTA` constants; monetization ties in M10). Eval runs use the Batches API at 50% (§9).

### 7.3 Quotas and limits (extends 05 §8; rows in `RATE_LIMITS`)

| Bucket | Limit | Notes |
|---|---|---|
| aiBurst | 3 / min per user | keystroke/retry storms |
| aiCallsDay | 20 / day per user | **model calls** (generate + repairs each count); `E_AI_BUDGET` |
| concurrent | 1 generation per user | Redis lock → `E_CONFLICT` |
| upstream breaker | trip on sustained provider 429/5xx | fast-fail `E_AI_UNAVAILABLE` org-wide; protects UX + budgets |

Server-side request caps: prompt ≤ 1 000 chars, knobs schema-validated, `generationId` must belong to the caller.

### 7.4 Privacy & retention

Prompts and candidates go to the provider under our org's API terms (no training on API traffic per current Anthropic policy; provider-side retention per their policy). Proxy logs (prompt, usage, outcome — never full candidates) rotate at `AI.LOG_RETENTION_DAYS` (30) for abuse/eval. Secrets handling (key storage, rotation) is M9's vault design; until then the key is deployment config, never in the repo.

---

## 8. Telemetry

Per call: model, `AI_PROMPT_VERSION`, round, status, token usage (in/out/cache-read/cache-write), latency; per generation: outcome, gates passed/failed, rounds, objects/links. Emitted as metrics + structured logs (M9 wiring); powers §9 dashboards and the cost knobs. Nothing lands in documents or Postgres in v1.

---

## 9. Eval corpus and promotion metrics

### 9.1 Corpus

`packages/ai/eval/prompts.json` — 40 fixed, versioned prompts: the brief's three verbatim; duration-targeted; count-targeted; type-constrained; theme/visual; vague one-liners ("something satisfying"); overspecified; adversarial (injection attempts, fence-bait, "output YAML", 2 000-object asks); non-goal prompts ("draw me a cat"). Knob combinations included for gate coverage.

### 9.2 Harness and metrics

CI job (nightly + on any `AI_PROMPT_VERSION`/model/profile change) runs the corpus through the real pipeline headless — proxy code invoked directly in Node, candidates checked by the same `check.ts` + SimCore (03 §1's environment-free core) — submitting model calls via the **Batches API** (50% price, latency-insensitive). Metrics per (model, promptVersion):

| Metric | Definition |
|---|---|
| `parseRate` | rounds yielding a JSON candidate (rail health) |
| `g1Round0` | candidates passing G1 with zero repair |
| `acceptRate` | generations ending `satisfied` or `closest` (G1-clean) |
| `meanRounds`, `meanTokens{in,out,cacheRead}` | cost drivers |
| `costPerAccepted` | list-price dollars per accepted scene |
| `gateBreakdown` | failure counts per gate (repair-prompt tuning signal) |

Initial targets (to be baselined live — U18): parseRate ≈ 100% with the rail; g1Round0 ≥ 85%; acceptRate ≥ 95%.

### 9.3 Promotion rule

A model swap, prompt change, or profile change ships only if, on the pinned corpus: `g1Round0` ≥ baseline − 2 pts, `acceptRate` ≥ baseline − 1 pt, and `costPerAccepted` ≤ 1.2 × baseline (unless the change's purpose is cost, then quality bars only). Results are CI artifacts; the baseline is the last shipped run.

---

## 10. Verification plan (CI — extends 05 §10 / 06 §11)

| Test | Guards |
|---|---|
| Compiled-prompt golden hash per `AI_PROMPT_VERSION`; byte-stability across double compile | §4.1 determinism, cache stability |
| `count_tokens` on the compiled prompt: 4 096 < tokens ≤ 8 000 | §4.1 budget + cache minimum |
| SO-profile transform assertions (spike §11 promoted to tests): no unsupported keywords, all objects closed, compiles, relaxation over the corpus, rail-vs-gate split; mutations bite | §4.3 |
| Few-shot corpus: every document passes the full gate | §4.5 |
| Three-way API consistency (verify-backend suite): 27 operations, 20 error codes, SSE content type on both AI ops, `aiCallsDay ≥ 1 + REPAIR_ROUNDS_MAX` | §2 |
| Eval corpus job (§9.2) nightly via Batches | model/prompt health |
| Tolerant-extraction unit vectors (fences, prose-wrapped, truncated, empty) | §4.3 fallback |

---

## 11. Spike record (2026-07-20, Session 7)

Environment: darwin-arm64, Node 24, ajv 8.20 strict, scratchpad only (S3/S6 precedent). **No live API calls were made** — structured-outputs constraints come from current provider documentation (claude-api reference, cached 2026-06); live acceptance is U18.

| Experiment | Result |
|---|---|
| SO-profile transform (T1–T5) over `scene.schema.json` | 14 019 B minified (source 12 770 B); stripped: 160×`min/maximum`, 61×string bounds+`pattern`, 87×array bounds, 11×`not`, 37×`unevaluatedProperties`; `oneOf`/`$ref`/`allOf` fully lowered (0 remain) |
| A1–A3 profile hygiene | no unsupported keywords; every object `additionalProperties:false`; compiles under ajv 2020-12 strict ✓ |
| A4 relaxation | 02 §10.1, §10.2, ai-exemplar: valid under full schema **and** profile ✓ |
| A5 rail-vs-gate split | unknown key `hight` → profile rejects (rail bites); `h: 99999` → profile accepts, full schema rejects (G1 authoritative) ✓ |
| N1–N3 mutations | disable stripping / disable closing / corrupt corpus — each caught, naming the offender (3/3 bite) |
| Few-shot corpus | 3 scenes ajv-strict green, incl. the new trigger-wire exemplar |
| Prompt budget | 02 §2–§8 raw 16.1 k chars; + few-shots + boilerplate = 21.6 k chars ≈ **5.4–6.3 k tokens** (upper bound; > 4 096 cache min, < 8 000 budget) |

---

## 12. Decisions and question status

**D15 — Serving architecture:** server-side proxy (`POST /ai/generate` + `/repair`, session-auth, SSE), provider keys server-only, BYO-key rejected for v1; Redis per-generation transcript (client sends findings only — turn integrity, structural round caps, byte-stable cache prefix); quotas as 05 §8 buckets (`aiBurst` 3/min, `aiCallsDay` 20/day counting model calls, 1 concurrent) + upstream circuit breaker; two new error codes (`E_AI_BUDGET` 429, `E_AI_UNAVAILABLE` 503); no schema.sql change; feature-flag off ⇒ paste-path-only tab.

**D16 — Model & prompt strategy:** pinned `claude-opus-4-8`, adaptive thinking explicitly on, effort `high`, streamed, `max_tokens` 16 k; build-time prompt compiler from 02's tables (S1–S9 fixed order, `AI_PROMPT_VERSION`-hashed, 4 096 < tokens ≤ 8 000); structured-outputs **shape rail** derived by T1–T5 (authoritative validation stays client-side G1 + 06 §8 sim gates; freeform + tolerant extraction fallback); two cache breakpoints (shared 1 h system prefix, 5 m transcript tail); repair = full-document re-emission from findings, ≤ 2 rounds; model/prompt changes eval-gated (§9.3).

**Opened:**
- **U18** — no live provider call was made this session: SO-profile acceptance by the API (size/keyword handling), real `count_tokens` numbers, and the §9.2 metric baselines are all documented-limits/estimate-based; verify at first implementation (first eval run). Fallbacks are specified (§4.3) if acceptance fails.
- **U19** — SSE through real-world proxies/CDNs (buffering breaks `progress`) and the provider-outage UX need production validation; owner M9 (infra) with the 04 §3.1 dialog degrading to spinner-only if buffered.

**Unchanged:** U2/U5/U9 (M9/M7), U7/U10/U12/U16/U17 (implementation), U11 (M8), U13 (M10), U14/U15 (M9).
