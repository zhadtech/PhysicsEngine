# Physics Sandbox Platform — Progress Tracker

> **Read this file first at the start of every session.** It is the single source of truth for project state.
> Working title: *Physics Sandbox Platform* (placeholder — naming is a later decision).

- **Repository role of this file:** progress tracker + decision index
- **Last updated:** 2026-07-20 (Session 7)
- **Current milestone:** M6 ✅ done → next is **M7 (Community & leaderboards)**

---

## 1. How to resume a session

1. Provide all project docs (this file, `01-ARCHITECTURE.md`, all `ADR-*.md`, and any milestone docs) to the session.
2. Say "Continue the project."
3. The assistant reads this file, picks the first milestone not marked ✅, and works only on it.
4. At session end: this file gets updated (milestone status + session log) and all new/changed docs are delivered back.

---

## 2. Decision log (summary — details in ADRs)

| # | Decision | Where | Status |
|---|----------|-------|--------|
| D1 | **2.5D hybrid**: physics simulated in 2D, rendered with 3D visuals | ADR-0001 | ✅ Accepted (user decision, Session 1) |
| D2 | Physics engine: **Rapier2D (Rust → WASM)**, deterministic build | ADR-0002 | ✅ Accepted |
| D3 | Frontend: **TypeScript + React + Three.js**, simulation in a Web Worker | ADR-0003 | ✅ Accepted |
| D4 | Backend: **Node.js + TypeScript + Fastify + PostgreSQL**, no server-side physics | ADR-0004 | ✅ Accepted |
| D5 | Scene format: **versioned JSON describing inputs, never results** | ADR-0005 | ✅ Accepted |
| D6 | Scene format v1 detail: **prefab-style catalog (18 object types + 5 link types)**, degrees in file, scalar gravity + planeAngle, explicit `gearMesh`, pulleys as rope `via` waypoints, data-only trigger/goal sensors | `02-SCENE-FORMAT.md` §11 | ✅ Accepted (Session 2) |
| D7 | Engine build: **official `@dimforge/rapier2d-deterministic-compat`, exact-pinned (0.19.3)** — no custom Rust toolchain; engineVersion policy + determinism rules DET-1…DET-11 | `03-SIMULATION-CORE.md` §2–3 | ✅ Accepted (Session 3) |
| D8 | **Pre-release v1 default amendments** (analytic tuning pass): `spring.stiffness` 80→25 N/m, `fan.strength` 2→0.4 N, magnet strength unit anchored (N at 5 cm ref); schemaVersion stays 1 | `03` §13, `02` §13 changelog | ✅ Accepted (Session 3) |
| D9 | **`gearMesh` visuals & auto-management from `ratio` prop**: no `ratio` = geometric mesh (editor auto-creates on pitch-circle snap, auto-removes on drag-apart; contact-glint visual); explicit `ratio` = manual (never auto-removed; positive → open belt, negative-at-distance → crossed belt). Resolves U8 renderer-only | `04-BUILDER-UX.md` §6.4, §12.1 | ✅ Accepted (Session 4) |
| D10 | **Scene storage (U3): Postgres JSONB in a dedicated `scene_revisions` table** — metadata/document separation structural (lists never touch docs); object-storage escape hatch pre-designed with explicit revisit triggers (p95 doc > 256 KB, table > 500 GB, TOAST in GET p95) | `05-BACKEND.md` §2 | ✅ Accepted (Session 5) |
| D11 | **Revision + publish model**: immutable per-save revisions; `head_rev` vs `published_rev` pointers (publish pins head; edits never leak until re-publish); visibility private/unlisted/public with DDL-enforced invariant; ETag/If-Match optimistic concurrency; keep-20 pruning FK-protected | `05-BACKEND.md` §3–4 | ✅ Accepted (Session 5) |
| D12 | **Auth**: DB sessions + `__Host-` cookie (no JWTs), argon2id (64 MiB/3/1), PKCE OAuth (Google/GitHub) with verified-email-only auto-linking, verified-email publish gate, zero server-side anonymous state (drafts stay in IndexedDB), Origin-check CSRF | `05-BACKEND.md` §6 | ✅ Accepted (Session 5) |
| D13 | **Procgen architecture**: stage-grammar over baton hand-offs (18-stage library, gear excluded pending U10), serpentine gravity-frame layout with exact seating, **verify-by-simulation self-check** (headless SimCore, gates G1–G6, targeted repair, closest-candidate fallback), fully client-side, deterministic under PG-1…PG-6 (labeled PCG32 streams, canonical writer, procgenVersion-scoped byte reproducibility, chaos = distribution width) | `06-PROCGEN.md` | ✅ Accepted (Session 6) |
| D14 | **Pre-release 03 §10 amendment — sensor-entry attribution** (rule 0: a trigger/goal's activation cause = the entering body; `ActivationCause` gains `{ via: 'sensor' }`). Sensors emit intersection events, not collision-starts, so trigger wires silently fragmented the chain forest — found designing M5's G4 gate | `03` §10, §15; `types/protocol.ts` | ✅ Accepted (Session 6) |
| D15 | **AI serving architecture**: server-side proxy (`POST /ai/generate` + `/{id}/repair`, session-auth, SSE), provider keys server-only (BYO-key rejected v1); Redis per-generation transcripts (clients send findings only — turn integrity, structural round caps, cache-stable prefix); quotas as 05 §8 buckets (3/min burst, **20 model calls/day**, 1 concurrent) + circuit breaker; codes `E_AI_BUDGET` 429 / `E_AI_UNAVAILABLE` 503; no schema.sql change; flag-off ⇒ paste-path-only tab | `07-AI-PIPELINE.md` §2, §7 | ✅ Accepted (Session 7) |
| D16 | **AI model & prompt strategy**: pinned `claude-opus-4-8` (adaptive thinking, effort high, streamed, 16 k max_tokens; swaps eval-gated); build-time prompt compiler from 02's tables (S1–S9, `AI_PROMPT_VERSION`-hashed, 4 096 < tokens ≤ 8 000); **structured-outputs shape rail** derived by transform T1–T5 (authoritative validation stays client-side: G1 + 06 §8 sim gates via shared `check.ts`; freeform + tolerant-extraction fallback); two cache breakpoints (shared 1 h system prefix — the D15 cost argument — + 5 m transcript tail); repair = full-document re-emission from findings, ≤ 2 rounds | `07-AI-PIPELINE.md` §3–§5, §9 | ✅ Accepted (Session 7) |

---

## 3. Milestones

Mapping of the 13 deliverables in `project_idea.md` into ordered milestones.

| ID | Milestone | Key deliverables | Covers brief item(s) | Status |
|----|-----------|------------------|----------------------|--------|
| M0 | **Foundation** | Architecture overview, tech stack, ADRs 0001–0005, this tracker | 1, 2, 4 | ✅ Done (S1) |
| M1 | **Scene data model** | JSON Schema, TypeScript interfaces, full object catalog (all object types + properties), versioning & migration rules | 3 | ✅ Done (S2) |
| M2 | **Simulation core design** | Worker protocol spec, fixed-timestep loop, determinism spec, custom forces (fans/magnets), snapshot/reset, analytics metric computation | 4, 10 (partly) | ✅ Done (S3) |
| M3 | **Builder UX/UI** | Wireframes, interaction model, tool specs, keyboard/touch input | 5 | ✅ Done (S4) |
| M4 | **Backend design** | Database schema, OpenAPI spec, auth design, scene storage decision | 6, 7 | ✅ Done (S5) |
| M5 | **Procedural generation** | Algorithm spec + pseudocode, constraint satisfaction approach | 8 | ✅ Done (S6) |
| M6 | **AI generation pipeline** | Prompt → scene JSON pipeline, validation/repair loop, cost controls | 9 | ✅ Done (S7) |
| M7 | **Community & leaderboards** | Gallery, likes/comments/follows, challenges, trending, leaderboard anti-cheat & verification | (community section) | ⬜ **Next** |
| M8 | **Performance & scale** | Client perf budget (thousands of objects), rendering strategy (instancing), backend scaling | 10 | ⬜ |
| M9 | **Infrastructure & deployment** | CI/CD, hosting, observability, environments | (technical goals) | ⬜ |
| M10 | **Multiplayer roadmap & monetization** | Collaboration design sketch, monetization options | 11, 12 | ⬜ |
| M11 | **Final roadmap MVP → production** | Consolidated development roadmap + task breakdown | 13 | ⬜ |

Milestone order rationale: the scene format (M1) is depended on by everything else (simulation, builder, backend, procgen, AI), so it comes first after foundation. Backend (M4) comes after builder (M3) so the API serves real UI needs.

---

## 4. Session log

### Session 1 — 2026-07-19

**Completed:**
- Reviewed brief (`project_idea.md`).
- User decisions collected: 2.5D hybrid; docs delivered via outputs folder each session.
- Produced: `00-PROGRESS.md`, `01-ARCHITECTURE.md`, `ADR-0001` … `ADR-0005`.
- M0 complete.

**Unresolved issues (carried forward):**
- U1: Rapier's cross-platform determinism needs the `enhanced-determinism` compile flag; the standard npm package may not enable it. A custom WASM build is likely needed. → Verify in M2 (first implementation spike).
- U2: Leaderboard trust: metrics are computed client-side, so cheating is possible. Candidate fix: replay validation using the same WASM in Node. → Decide in M7.
- U3: Scene storage location (Postgres JSONB vs object storage) leaning JSONB for MVP. → Final call in M4.
- U4: Fans/magnets/rope are not native Rapier features; need a custom force layer and joint compositions. → Design in M2.
- U5: SharedArrayBuffer needs cross-origin isolation headers (COOP/COEP), which restricts third-party embeds of share pages. Fallback path defined but embed strategy TBD. → M9.

### Session 2 — 2026-07-19

**Completed — M1 (Scene data model):**
- Produced `02-SCENE-FORMAT.md`: normative spec for schemaVersion 1 — conventions (SI units, degrees, desk scale, 4-digit quantization, single id namespace), `meta`/`world` settings, full object catalog (**18 types**: platform, ramp, curve, domino, marble, crate, plank, gear, lever, spring, pendulum, piston, conveyor, pulley, fan, magnet, trigger, goal), link catalog (**5 types**: rope, springLink, weld, axle, gearMesh), named anchors, trigger activation table, 12 semantic validation rules, size limits, versioning/migration policy, 2 worked examples.
- Produced `scene.schema.json`: JSON Schema draft 2020-12, one strict variant per object/link type (ajv strict mode clean).
- Produced `types/scene.ts`: discriminated unions, defaults tables (`MATERIAL_DEFAULTS`, `WORLD_DEFAULTS`, `NAMED_ANCHORS`), limits, type guards. Plus `types/scene.typecheck.ts` (dev-only cross-check).
- **Verified:** ajv (strict) compiles the schema; both doc examples validate; 15 negative cases correctly rejected; 3 positive edge cases accepted; `tsc --strict` (with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) passes on types + examples. `verify.mjs` kept as the seed of the CI validation-corpus runner (ADR-0005 consequence).
- Design decisions recorded in `02-SCENE-FORMAT.md` §11 (summarized as D6). Notable: gravity stored as scalar + planeAngle (the vector form in ADR-0005's sketch was redundant — sketch was marked illustrative; no ADR change needed).

**Unresolved issues (new):**
- U6: Ideal rope-over-pulley (constant total length through `via` waypoints) is not a native Rapier constraint → custom constraint design in M2.
- U7: Density/force defaults in the catalog are provisional → tuning pass with real simulation in M2; if defaults change, that's schemaVersion 2 + migration.
- U8: Belt/chain drives representable (`gearMesh` with positive ratio) but have no visual → belt rendering decision in M3/M8.

**Next milestone: M2 — Simulation core design.** Expected outputs: `03-SIMULATION-CORE.md` — worker protocol (messages, shared-buffer layout), fixed-timestep loop & interpolation contract, determinism spec (incl. U1 spike plan, quantized-input round-trip rule), custom force layer (fan cone / magnet falloff formulas, conveyor contact velocity — U4), prefab expansion rules (how each catalog type maps to bodies/joints), pulley constraint design (U6), snapshot/reset semantics, trigger signal processing, analytics metric definitions & algorithms, default-tuning pass (U7).

### Session 3 — 2026-07-19

**Completed — M2 (Simulation core design):**
- **U1 spike executed** (not just planned): dimforge publishes **official deterministic builds** — `@dimforge/rapier2d-deterministic(-compat)` 0.19.3, same release train as the standard package. Installed and ran in Node: full API checklist present (rope + spring joints, revolute/prismatic motors + limits, snapshot/restore, sensors, contact-pair queries, CCD, `applyImpulseAtPoint`, `convexHull`); 600-step double-run identity and mid-run snapshot/restore equivalence both bit-identical (hash `91a2b287`, darwin-arm64/Node 24). → **D7**: pin the official package; no custom Rust toolchain. Cross-ISA confirmation split off as U9.
- Produced `03-SIMULATION-CORE.md` (normative): environment-free SimCore package shape (same code in worker + Node for CI/replay); determinism rules **DET-1…DET-11** (fixed 60 Hz step, pinned build, stable construction order, quantized-input round-trip, transcendentals load-time-only via own `dmath` — per-step code restricted to IEEE-exact ops, single PCG32, fixed phase order, command log on step boundaries, two-phase effects, deterministic removal, one-way transport); step pipeline P0–P7; worker protocol (lifecycle FSM, commands/acks, SAB triple-buffer layout, postMessage fallback, pacing + renderer interpolation contract); prefab expansion tables for all 18 object types + 5 link types (exact geometry incl. ramp vertices, curve tessellation formula, joint/motor configs, creation order); field/surface forces — fan cone (axis-aligned, linear falloff), magnet (inverse-square anchored at 5 cm reference), conveyor (grip-capped contact impulses) — **U4 resolved**; custom Gauss-Seidel layer — `gearMesh` ratio constraint + rope-over-pulley shared-budget unilateral constraint — **U6 resolved**; finish conditions (stopped / hardCap 600 s / quiescent / idle); trigger–goal semantics; normative analytics (activation thresholds, cause-attribution forest, chain metrics, efficiency formula, state hash for future replay verification); snapshot/reset bundle (`ExtraState` completeness rule); CI verification plan (golden hashes, round-trip, command-boundary, force-layer units, perf smoke).
- Produced `types/protocol.ts` — commands, messages, events, `AnalyticsReport`, SAB layout + engine constants. **Verified:** `tsc --strict` (with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) passes on scene + typecheck + protocol types.
- **D8 — defaults tuning pass (U7):** analytic mass/energy pass over the catalog at desk scale (table in 03 §13). Two defaults were off by ~an order of magnitude and amended **pre-release** in 02 + `types/scene.ts` (with 02 §13 changelog): `spring.stiffness` 80→25 N/m, `fan.strength` 2→0.4 N; magnet strength unit anchored (N at the 5 cm reference — the formula makes the default sane). schemaVersion stays 1 (format unreleased). **Re-verified:** ajv strict suite still green (schema compiles, both examples valid, 15 negatives rejected, 3 positives accepted).
- Naming hygiene: 03's determinism rules use the `DET-n` prefix so they can't collide with project decisions `Dn` in this file.

**Unresolved issues (status after S3):**
- U1 ✅ resolved (D7); U4 ✅ resolved (03 §7); U6 ✅ resolved (03 §8.2).
- U7 → narrowed: analytic pass done (D8); empirical confirmation with the running engine at first implementation; any post-release change = schemaVersion 2 + migration.
- **U9 (new):** cross-ISA golden-hash CI (linux-x64 + macos-arm64, browser triple later) must confirm `enhanced-determinism` across platforms — the spike covered one machine. → M9 / first implementation.
- **U10 (new):** Rapier motor force-cap semantics (`maxTorque`, piston `force`) verified by API presence only; confirm the exact motor model at implementation (fallback: motors in the custom constraint layer).
- U2 (M7), U3 (M4), U5 (M9), U8 (M3/M8) unchanged.

**Next milestone: M3 — Builder UX/UI.** Expected outputs: `04-BUILDER-UX.md` — screen map & wireframes (builder, player, gallery entry), interaction model (place/move/rotate/duplicate/delete, grid & snap rules, link-creation flows incl. auto-`gearMesh` on gear snap per 02 §11 item 3, anchor picking), tool & panel specs (palette from the 18-type catalog, property inspector driven by the catalog tables, world settings), keyboard/touch input maps, play-mode UI over the 03 §5 protocol (timeline from `firstActivationSteps`, event feedback, analytics panel), undo/redo model over the scene store, belt visual decision (U8).

### Session 4 — 2026-07-19

**Completed — M3 (Builder UX/UI):**
- Produced `04-BUILDER-UX.md` (normative): screen map & routes with edit⇄test FSM mirroring the worker lifecycle; builder wireframes (edit + test), palette/inspector/status-bar layout; camera model (tilt-clamped workshop view, planeAngle roll clamp ±25° + gravity compass), grid tied to snap step; interaction model — click/drag placement, **domino-run drag tool** (spacing 0.75·h), surface-seat snap along gravity, **prop-handle gizmos** (handles edit catalog props, never free transforms), duplicate/clipboard (`physics-sandbox/objects@1`, boundary rules for links/refs), cascade delete; snapping system (grid/rotation steps, smart guides incl. equal-spacing repeat, screen-space anchor snap, **gear pitch-circle snap with auto-`gearMesh`**); link-creation flows per type (rope `via` waypoint clicks, quick-link `L`, trigger/goal canvas pick modes); **descriptor-driven inspector** (compile-checked field tables), world/meta panel, live validation panel, worker error/warning copy tables; undo/redo command model (coalescing, composites, 200-step ring, save-pointer dirty tracking); test mode over 03 §5 (transport controls incl. determinism-honest Reset+Play, HUD + debug overlay, **timeline as event log** with `durationHint` target zone, analytics panel mapping `AnalyticsReport` incl. client-side chain rebuild from `ActivationEvent.cause` + empty-state coaching); player page (`/s/{id}`, no-autoplay + fallback-transport requirement), **thumbnail spec** (640×360 WebP, feeds M4), gallery card contract; rendering notes (D9 belt visuals, rope sag/wrap, sleep dimming, **skin name set v1** with per-type defaults); full keyboard/touch/a11y input maps; limits/autosave/import-export affordances.
- Produced `types/editor.ts` — editor constants (`EDITOR`), tool/selection/undo-command types, `TYPE_PROP_FIELDS`/`LINK_PROP_FIELDS` inspector descriptors with **prop keys compile-checked against `types/scene.ts`** (ranges mirror the schema, defs mirror 02 §5.3), palette groups with type-level coverage proof, `ID_PREFIX`, skins, D9 `gearMeshVisual()` classifier, machine-readable `DEFAULT_KEYMAP`.
- **Verified:** `tsc --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess` passes on all four type files; negative test confirmed the proofs bite (dropping `goal` from the palette and typo'ing a prop key each fail compilation with the offending name).
- **D9** recorded (belt/mesh visuals + geometric-vs-manual `gearMesh` rule derived from `ratio` presence — no sidecar state, remix-safe). **U8 resolved.**

**Unresolved issues (status after S4):**
- U8 ✅ resolved (D9; 04 §12.1).
- **U11 (new):** presentation asset pass — materials for the 8 skin names, belt/rope meshes + animation polish, SFX palette from `CollisionEvent.impulse`, `InstancedMesh` strategy for skins × types. → M8.
- **U12 (new):** touch interaction set (gesture conflicts, anchor sheet, two-finger-twist rotate) needs validation on real devices; adjust `EDITOR` constants only. → first implementation / M8.
- U2 (M7), U3 (M4), U5 (M9), U9 (M9), U10 (first implementation) unchanged.

**Next milestone: M4 — Backend design.** Expected outputs: `05-BACKEND.md` — PostgreSQL schema (users + OAuth identities, scenes with versioning/size caps, thumbnails, remix lineage, tables shaped for M7 social without implementing it), OpenAPI spec (scenes CRUD + remix + gallery queries + thumbnail upload per 04 §11.2, error model aligned with the shared validation gate), auth design (email + OAuth per 01 §4, session cookies, anonymous-draft → account upgrade path), **scene storage decision (U3: JSONB vs object storage)**, server-side validation via the shared `scene-format` package (ADR-0004 rationale made concrete), rate limits & abuse caps, autosave/draft sync semantics for 04 §14, privacy/publish state machine (01 §6). Covers brief items 6, 7.

### Session 5 — 2026-07-20

**Completed — M4 (Backend design):**
- Produced `05-BACKEND.md` (normative): **D10 — U3 resolved** (Postgres JSONB in a dedicated `scene_revisions` table; sizing math, JSONB-vs-text rationale anchored to "canonical bytes = strict writer, simulation identity = DET-4"; object-storage escape hatch + concrete revisit triggers); **D11 — revision/publish model** (immutable per-save revisions, `head_rev`/`published_rev` pinning, tri-state visibility FSM with access matrix, trash + 30 d purge, remix = copy-published + lineage); server validation gate as an 8-step normative order (transport cap 1 MiB above the 1 MB doc cap so oversize diagnoses as `E_LIMITS`, secure parse, migrate-then-validate, W-rules returned as non-blocking `warnings`); 18-code error model as a **strict superset of the worker's `SimErrorCode`** (04 §8.6 copy extends to API failures, findings shape = builder validation panel); **D12 — auth** (DB sessions + `__Host-` cookie, argon2id 64 MiB/3/1, PKCE OAuth with verified-email-only auto-linking, verified-email publish gate, anonymous drafts stay in IndexedDB through the OAuth round-trip, Origin-check CSRF); autosave/draft sync semantics for 04 §14 (explicit-save-only server, If-Match concurrency, three-way conflict dialog, **no-merge policy** — fork on conflict); rate-limit/quota tables (login buckets sized against argon2 cost; M7 social buckets name-reserved); Redis/BullMQ job inventory (purge, prune, thumb-GC, token sweep, counter reconcile).
- Produced `schema.sql` (9 tables): users/identities/tokens/sessions + scenes/scene_revisions + M7-shaped likes/comments/follows; DDL-enforced invariants — visibility⇒published CHECK, revision `size_bytes ≤ 1000000` mirroring `LIMITS.maxJsonBytes`, deferred composite FKs making head/published revisions unprunable-by-construction, citext-safe handle pattern (cast to text — citext `~` is case-insensitive), generated tsvector + pg_trgm indexes, list indexes that never touch doc pages.
- Produced `openapi.yaml` (OpenAPI 3.1, 25 operations: 11 auth, 10 scenes, 3 gallery, 1 health) — card/scene DTOs matching the 04 §11.3 contract, If-Match required on saves (428/412), thumbnail PUT (`image/webp`, 640×360, ≤128 KiB, content-addressed), example scene payloads real (02 §10.1 verbatim).
- Produced `types/api.ts`: `ApiErrorCode` + `ERROR_STATUS`, DTOs typed against `Scene`, `ROUTES` table, constants (`API`, `AUTH`, `RATE_LIMITS`, `RESERVED_HANDLES`); compile ties — `SimErrorCode ⊆ ApiErrorCode` and thumbnail dims === `EDITOR.THUMB_W/H`.
- Produced `verify-backend.mjs` (companion to `verify.mjs`, same copy-to-scratch convention): OpenAPI 3.1 meta-schema validation; per-operation structure rules (operationId/tags/summary, enveloped ≥400 responses, declared path params); `ROUTES` ⇔ spec equality; error-code **three-way** set+status equality (api.ts / YAML enum / 05 §5.2 table); embedded example scenes validated against `scene.schema.json` (ajv strict); `schema.sql` parsed by the **real PostgreSQL grammar** (pgsql-parser/libpg_query, PG 17); table inventory ⇔ 05 §3; DDL caps/patterns ⇔ `LIMITS`/api.ts.
- **Verified:** `tsc --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess` passes on all five type files; verify-backend suite fully green (25 ops, 18 codes, 9 tables, 35 SQL statements). **Negative tests confirmed every check bites** (6/6): drifted route path, code missing from YAML enum, corrupted example scene, SQL typo, thumbnail 641, worker code dropped from the union — each caught with the offending name.

**Unresolved issues (status after S5):**
- U3 ✅ resolved (D10).
- **U13 (new):** server-side drafts / cross-device continue-editing deliberately deferred (MVP autosave is local-only; explicit saves only on the server) → design belongs to M10's collaboration model.
- **U14 (new):** external vendor picks — object storage/CDN, transactional email (SPF/DKIM, deliverability). Abstracted behind modules in 05; concrete choices → M9.
- **U15 (new):** account deletion / data-export compliance flow (erasure vs public scenes + remix lineage: scenes purge, lineage pointers null, remixes survive — policy sketched in 05 §12, not decided) → M9.
- U2 (M7), U5 (M9), U9 (M9), U10/U7/U12 (first implementation), U11 (M8) unchanged.

**Next milestone: M5 — Procedural generation.** Expected outputs: `06-PROCGEN.md` — parameter surface from the brief (seed, target duration, object count/types, difficulty, plane angle, theme, chaos, desired chain-reaction count) mapped onto scene-format inputs; generator architecture (client-side, seeded PCG32 per 03 DET-6 — same seed ⇒ same machine); machine-idiom template/grammar library (domino runs, marble drops, ramp cascades, lever/pulley lifts, trigger chains) with composition rules; placement/constraint-satisfaction approach (support & reachability, no-overlap, bounds fitting, solver order + backtracking) with pseudocode; **self-check loop**: generated scenes must pass the full 02 validation gate, and headless SimCore (03 — same package in Node) confirms finish conditions / chain metrics vs. the requested parameters (reject-and-retry budget); difficulty/chaos knob semantics; integration: Generate dialog (04 §3.1), scenes saved via the M4 API as ordinary documents (ADR-0005 rule 5 — no special gate). Likely `types/procgen.ts` (params, template descriptors, generator report) compile-tied to `types/scene.ts`. Covers brief item 8.

### Session 6 — 2026-07-20

**Completed — M5 (Procedural generation):**
- **Calibration spike executed first** (S3 pattern — scratchpad, not committed; full record in 06 §12): reference **PCG32** in BigInt reproduces the published pcg32-demo prefix (6-value test vector recorded); mini-expansion (03 §6 geometry for platform/ramp/domino/marble/sensors) on the real pinned `rapier2d-deterministic-compat@0.19.3`. Measured: **exact seating never activates** (max |v| 10⁻⁷ m/s — 6 orders under `V_ACT`, so seated machines start silent); ramp exit `K_RAMP_EXIT 0.92·√(4gΔy/3)`; domino front speed `K(s/h)·√(g·h)` sweep (0.797 at default 0.75 spacing ⇒ 85 ms/domino; √h scaling ±5% for h 0.05–0.12; **regime break at h 0.2** → run heights capped 0.15); flat runout retains 100%/m (**flats are time knobs, never brakes**); center-spin domino starters **fail** (floor contact eats the energy) → normative **corner-pivot kick** formula; determinism double-run identical; ~190–240 k steps/s headless. **End-to-end existence proof:** mini-generator (ramp → runout → 40 dominoes → goal) through ajv-strict gate + simulated self-check: success, goal at 5.72 s vs 6.00 s target (−4.7%), 40/40 activated, byte-identical regenerate.
- Produced `06-PROCGEN.md` (normative): parameter surface (brief's 9 knobs → `GenParams` → scene fields → gates, clamp/viability rules incl. port-graph closure check); determinism rules **PG-1…PG-6** (pure function, labeled PCG32 streams `cand{i}/lane{l}/stage{j}/{purpose}` so repairs stay local, canonical writer with fixed key orders, chaos = width never entropy, procgenVersion-scoped goldens, budgets counted in steps not wall-clock); machine model (5 baton kinds; **catalog truths CT-1…CT-8** — only roots self-start, gears can't start off (→ excluded, ties U10), the 5 signal receivers, step-0 fields root their own trees, crisp-hand-off attribution window, bounds/time caps, no rolling resistance); 18-stage library with recipes/sentinels; planner + multi-lane timing (`chains` = lanes; delayed roots via cycle-piston `period = 2·delay, phase 0.5`; **anti-idle overlap rule** — activity-interval union may not gap ≥ 4 s or the engine's idle finisher kills the run); layout CSP (gravity-frame serpentine rows, generator-chosen bounds, **exact seating with quantization-error proof**, ballistic hand-off solver with funnels/adapters, backtracking budgets, OBB safety net); self-check loop (SimCore harness **shared with M6**, gates G1–G6, diagnosis→repair table, closest-candidate fallback per the brief's "as closely as possible"); difficulty/chaos/theme semantics; Generate-dialog integration (04 §3.1 Procedural tab, insert = one composite undo, save path ordinary by design); CI plan (goldens, 100%-G1 fuzz, calibration regression, perf smoke).
- Produced `types/procgen.ts`: `GenParams`/defaults/ranges (value-tied to `LIMITS.maxObjects`, `SIM.HARD_CAP_S`), `STAGE_LIBRARY` (18 descriptors) with **compile proofs that name culprits** (catalog-type coverage vs `PROCGEN_EXCLUDED_TYPES`, starter/terminal set equality), `THEMES` (skins compile-tied to editor `SKIN_NAMES`), plan IR, `GenReport`/gates, `PROCGEN` constants (budgets, tolerances, calibrated models), `PCG32_TEST_VECTOR`.
- **D14 — pre-release 03 amendment** (D8 mechanics): sensor-entry attribution rule 0 in 03 §10 + changelog §15; `ActivationCause` gains `{ via: 'sensor' }` (additive). Found because G4's chain accounting fragmented at every trigger wire under the old rules.
- **Verified:** strict tsc passes on all six type files; **5/5 negative compile tests bite naming the offender** (dropped stage, typo'd ObjectType, unknown skin, missing starter, unexcluded gear); spike suite green (schema gate, sim gates, determinism, PCG32 vectors).

**Unresolved issues (status after S6):**
- **U16 (new):** estimate models calibrated on a mini-expansion, one platform — recalibrate on real SimCore across the full stage library at first implementation; drift > 15% = procgenVersion bump (06 §11).
- **U17 (new):** generation wall-time on low-end devices (worst corner ≈ 650 k simulated steps); measure at implementation; budget constants or a fast-preview preset may need M8 attention.
- U10 note: motor-model risk now also blocks `gear` stages in procgen (06 CT-2) — resolving it unlocks a library extension.
- U2 (M7), U5 (M9), U9 (M9), U7/U10/U12 (first implementation), U11 (M8), U13 (M10), U14 (M9), U15 (M9) unchanged.

**Next milestone: M6 — AI generation pipeline.** Expected outputs: `07-AI-PIPELINE.md` — prompt → scene JSON pipeline (model + structured-output strategy; system prompt compiled from the 02 catalog tables + few-shot corpus scenes; degrees/defaults conventions stated for the model); **validation/repair loop reusing procgen's `check.ts` harness verbatim** (06 §8.1 contract: G1 gate → simulated gates → diagnosis fed back as repair prompts, bounded rounds); serving decision (server-side proxy holding provider keys vs client BYO-key — rate limits/quotas extending 05 §8, cost controls, abuse caps; likely a `POST /ai/generate`-style addition to the 05 API needing D-decision); Generate-dialog AI tab (04 §3.1's second half; streaming progress, paste-fragment fallback via the 04 §5.2 clipboard format); prompt-injection/content-safety posture for user text; eval corpus + metrics (gate pass rates per model, cost per accepted scene); likely `types/ai.ts` compile-tied to `types/procgen.ts` report shapes. Covers brief item 9.

### Session 7 — 2026-07-20

**Completed — M6 (AI generation pipeline):**
- **Spike executed first** (S3/S5/S6 pattern — scratchpad, not committed; record in 07 §11; **no live API calls** — provider limits from current documentation, live acceptance = U18): the **structured-outputs profile transform** (T1 inline `$ref` / T2 flatten `allOf`+`unevaluatedProperties` / T3 `oneOf`→`anyOf` / T4 strip rejected constraint keywords / T5 close every object) run over the real `scene.schema.json` → 14 KB profile, `oneOf`/`$ref`/`allOf` fully lowered, 160 numeric bounds + 61 string + 87 array constraints stripped; **relaxation proven** (02 §10.1/§10.2 + new exemplar valid under full schema *and* profile), **rail-vs-gate split proven** (unknown key → profile rejects; out-of-range value → profile accepts, full schema rejects); 3/3 transform mutations caught. Few-shot corpus (3 prompt→doc pairs incl. a new trigger-wire exemplar) ajv-strict green. Prompt budget measured: 02 §2–§8 + few-shots + boilerplate ≈ 21.6 k chars ≈ **5.4–6.3 k tokens** (> 4 096 Opus 4.8 cache minimum, < 8 000 budget).
- Produced `07-AI-PIPELINE.md` (normative): **D15 — serving architecture** (thin session-auth SSE proxy `POST /ai/generate` + `/{id}/repair`; keys server-only, BYO-key rejected; Redis transcripts — clients send *findings only*, so turns can't be forged, round caps are structural, and the cache prefix stays byte-stable; quotas 3/min · 20 model-calls/day · 1 concurrent + circuit breaker; `E_AI_BUDGET`/`E_AI_UNAVAILABLE`; flag-off ⇒ paste-only tab; **no schema.sql change**); **D16 — model & prompt strategy** (pinned `claude-opus-4-8`, adaptive thinking explicitly on, effort high, streamed, 16 k max_tokens; build-time **prompt compiler from 02's own tables** — S1–S9 fixed order incl. physics-truths from the 06 §12 calibration (85 ms/domino, exact-seating, timing formulas), golden-hashed `AI_PROMPT_VERSION`; SO shape rail + freeform/tolerant-extraction fallback; 1 h shared system-prefix + 5 m transcript-tail cache breakpoints; stop-reason table incl. `refusal`); **validation/repair loop** on the 06 §8.1 contract verbatim — client-side `check.ts`, gate profile scaled to knobs (G3 vs `durationHint` self-consistency at ×2 tolerance when unset; G4/G6 knob-only; W-rules repairable-not-blocking, unlike procgen's zero-W rule), ≤ 2 repair rounds then closest/failed with the 06 §8.3 score; AI tab spec (quota chip, progress states, result card, **paste path as zero-cost lane + unconfigured fallback**); injection posture (bounded blast radius: no tools, findings-only client input, full gate on output); cost model (**≈ $0.08–0.20/accepted scene** typical, $1.25 worst-case, quota ceiling $8/user/day); eval corpus (40 pinned prompts incl. adversarial) + metrics (parseRate, g1Round0 ≥ 85%, acceptRate ≥ 95%, costPerAccepted) + **promotion rule** for any model/prompt/profile change, run via Batches API at 50%.
- Produced `types/ai.ts` (constants, S1–S9 section list, `SO_STRIPPED_KEYWORDS`, knobs as compile-tied `Pick` of `GenParams`, stream-event union, `AI_GATE_PROFILE` exhaustive over `GateId`, `AiReport` reusing 06 gate shapes). **API surface registered:** `openapi.yaml` +2 SSE operations (25→27) with request schemas + `AiRateLimited`/`AiUnavailable` envelopes; `types/api.ts` +2 codes (18→20), +2 routes, +2 rate buckets; `05-BACKEND.md` §1/§5/§5.2/§8/§9 updated; `verify-backend.mjs` extended (M6 block: SSE content-type on both AI ops; `aiCallsDay ≥ 1 + REPAIR_ROUNDS_MAX`).
- **Verified:** strict tsc passes on all seven type files; verify-backend suite fully green (27 ops, 20 codes three-way, SSE + budget checks, all M4 checks intact). **Negative tests: 10/10 bite naming the offender** — 3 spike mutations, 5 runtime (dropped route, dropped YAML code, non-SSE 200, budget < one generation, dropped 05 table row), 2 compile (dropped prompt section, dropped gate key).

**Unresolved issues (status after S7):**
- **U18 (new):** no live provider call this session — SO-profile API acceptance (size/keyword handling), real `count_tokens` prompt numbers, and the §9.2 eval baselines are documented-limits/estimate-based; verify at first implementation (fallbacks specified in 07 §4.3 if acceptance fails).
- **U19 (new):** SSE viability through real proxies/CDNs (buffering kills `progress`) + provider-outage UX; owner M9, dialog degrades to spinner-only.
- U2 (M7 — next), U5/U9/U14/U15 (M9), U7/U10/U12/U16/U17 (first implementation), U11 (M8), U13 (M10) unchanged.

**Next milestone: M7 — Community & leaderboards.** Expected outputs: `08-COMMUNITY.md` — social endpoints on the reserved surface (likes/comments/follows: tables already shaped in `schema.sql` §3.4, buckets already named in `RATE_LIMITS`, counters + `counter-reconcile`/`trending-recompute` jobs pre-listed in 05 §9); gallery ranking (`sort=trending/top` extending the 05 §5.5 enum without contract change; ranking job + Redis zsets); challenges model (needs new tables — first schema.sql change since M4 — challenge definition, entries, judging); **leaderboards with anti-cheat (U2 resolution)**: client-signed `AnalyticsReport` submission, spot-check replay verification server-side using the deterministic Node SimCore (03 §1 environment-free core + §10 state hash — the design 01 §4 reserved), rate/plausibility screens, engineVersion scoping (01 §6); moderation & reporting posture (content reports, takedown flow — also closes 07 §7.1's deferred moderation note for AI/hand-typed text); remix-lineage surfacing (tree endpoint or cards). Extends `openapi.yaml`/`types/api.ts`/`schema.sql` + verify suite; likely `types/community.ts`. Covers the brief's community section + U2.

---

## 5. Planned repository layout (when implementation starts)

```
physics-sandbox/
├── docs/                  # everything produced in these sessions
│   ├── 00-PROGRESS.md
│   ├── 01-ARCHITECTURE.md
│   ├── 02-SCENE-FORMAT.md
│   └── adr/ADR-000*.md
├── packages/
│   ├── scene-format/      # schema, TS types, validation, migrations (shared client+server)
│   │   ├── scene.schema.json
│   │   └── src/scene.ts
│   ├── engine/            # simulation core: Rapier wrapper, worker, determinism layer
│   ├── procgen/           # procedural generation
│   └── shared/            # misc shared utilities
├── apps/
│   ├── web/               # React app (builder, player, gallery)
│   └── api/               # Fastify backend
└── (pnpm workspaces + Turborepo)
```
