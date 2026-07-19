# Physics Sandbox Platform — Progress Tracker

> **Read this file first at the start of every session.** It is the single source of truth for project state.
> Working title: *Physics Sandbox Platform* (placeholder — naming is a later decision).

- **Repository role of this file:** progress tracker + decision index
- **Last updated:** 2026-07-19 (Session 4)
- **Current milestone:** M3 ✅ done → next is **M4 (Backend design)**

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

---

## 3. Milestones

Mapping of the 13 deliverables in `project_idea.md` into ordered milestones.

| ID | Milestone | Key deliverables | Covers brief item(s) | Status |
|----|-----------|------------------|----------------------|--------|
| M0 | **Foundation** | Architecture overview, tech stack, ADRs 0001–0005, this tracker | 1, 2, 4 | ✅ Done (S1) |
| M1 | **Scene data model** | JSON Schema, TypeScript interfaces, full object catalog (all object types + properties), versioning & migration rules | 3 | ✅ Done (S2) |
| M2 | **Simulation core design** | Worker protocol spec, fixed-timestep loop, determinism spec, custom forces (fans/magnets), snapshot/reset, analytics metric computation | 4, 10 (partly) | ✅ Done (S3) |
| M3 | **Builder UX/UI** | Wireframes, interaction model, tool specs, keyboard/touch input | 5 | ✅ Done (S4) |
| M4 | **Backend design** | Database schema, OpenAPI spec, auth design, scene storage decision | 6, 7 | ⬜ **Next** |
| M5 | **Procedural generation** | Algorithm spec + pseudocode, constraint satisfaction approach | 8 | ⬜ |
| M6 | **AI generation pipeline** | Prompt → scene JSON pipeline, validation/repair loop, cost controls | 9 | ⬜ |
| M7 | **Community & leaderboards** | Gallery, likes/comments/follows, challenges, trending, leaderboard anti-cheat & verification | (community section) | ⬜ |
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
