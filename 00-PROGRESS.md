# Physics Sandbox Platform — Progress Tracker

> **Read this file first at the start of every session.** It is the single source of truth for project state.
> Working title: *Physics Sandbox Platform* (placeholder — naming is a later decision).

- **Repository role of this file:** progress tracker + decision index
- **Last updated:** 2026-07-19 (Session 2)
- **Current milestone:** M1 ✅ done → next is **M2 (Simulation Core Design)**

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

---

## 3. Milestones

Mapping of the 13 deliverables in `project_idea.md` into ordered milestones.

| ID | Milestone | Key deliverables | Covers brief item(s) | Status |
|----|-----------|------------------|----------------------|--------|
| M0 | **Foundation** | Architecture overview, tech stack, ADRs 0001–0005, this tracker | 1, 2, 4 | ✅ Done (S1) |
| M1 | **Scene data model** | JSON Schema, TypeScript interfaces, full object catalog (all object types + properties), versioning & migration rules | 3 | ✅ Done (S2) |
| M2 | **Simulation core design** | Worker protocol spec, fixed-timestep loop, determinism spec, custom forces (fans/magnets), snapshot/reset, analytics metric computation | 4, 10 (partly) | ⬜ **Next** |
| M3 | **Builder UX/UI** | Wireframes, interaction model, tool specs, keyboard/touch input | 5 | ⬜ |
| M4 | **Backend design** | Database schema, OpenAPI spec, auth design, scene storage decision | 6, 7 | ⬜ |
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
