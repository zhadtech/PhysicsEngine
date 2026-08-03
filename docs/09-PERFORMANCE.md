# 09 — Performance & Scale

**Status:** Accepted (Session 9, 2026-07-21) — normative budget for the client and the read path
**Implements:** brief item 10; ADR-0001 (2D physics keeps sim cheap), 01 §3 (thread model), R4
**Consumes:** `03-SIMULATION-CORE.md` (§5 transport, §12 perf smoke), `06-PROCGEN.md` (§8.4 budgets), `08-COMMUNITY.md` (§4.2 trending, §5.5 verification), `04-BUILDER-UX.md` (§12 rendering notes)
**Companion file:** `types/perf.ts` (frame budget, tiers, render classification, read-path posture — compile-tied to the engine/catalog/verify constants)
**Consumed by:** M9 (CI perf matrix, infra), first implementation (tuning)

---

## 1. The one claim everything rests on

The brief asks for "thousands of objects… responsive even with large scenes." The measurement that makes this tractable, confirmed on the pinned D7 build (§10, spike P1):

> **Step cost is set by the *awake and contacting* body count, not the total object count.**

A chain-reaction machine is, by its nature, mostly *dormant* at any instant: a domino run stands still until the wave reaches it; a marble track has one marble moving. Rapier sleeps settled islands, and a sleeping island is ~6–13× cheaper to step than the same bodies awake. So a 2 000-object machine with a handful of live bodies steps in **~0.13 ms — 130× under the 16.67 ms frame budget** — while 2 000 bodies *all* awake and colliding (a poured pile, the worst case) costs ~4.4 ms/step. The design job of this document is to (a) keep the common case dormant, (b) keep rendering bounded by *kinds*, not counts, and (c) fail honestly, never catastrophically, when a scene really is 5 000 live bodies.

**Corollary that governs the whole document — adaptation is render-only.** Determinism (03) and leaderboards (08 D17) require every machine to compute the *identical* run. Therefore performance tiers may drop shadows, LOD, and overlays, but **must never change what SimCore steps**. The only "sim-side" concession to a slow device is the engine's honest slow-motion under overload (`MAX_CATCHUP_STEPS`, 03 §5.5) — and by DET-1 that changes *when* steps happen, never *what* they compute. This is why `types/perf.ts` puts every knob on the render side.

---

## 2. The frame budget

Two threads, each owning a full frame, running in parallel (01 §3.1):

```
             16.67 ms  (one 60 Hz frame / one 1× sim step)
 sim worker  |=================== world.step ===================|  (transport ~µs, §5)
 main thread |--interp--|============= draw =============|--UI--|~|  (RENDER_SPLIT)
```

- **Sim worker (`FRAME.BUDGET_MS`).** Effectively the whole budget is `world.step`; transport is ~2 µs at the body cap (§5). The worker holds real time as long as one step ≤ 16.67 ms; past that, `MAX_CATCHUP_STEPS` turns the excess into slow-motion (§5.3), not a stall.
- **Render main thread (`RENDER_SPLIT`, fractions of the budget, summing to 1 by construction).** interpolate 0.08 · draw 0.55 · UI 0.25 · headroom 0.12. Draw is where the instanced submit lives (§4); the SAB decoupling (03 §5.5) lets the renderer run at display Hz regardless of the worker's publish rate.

Under sustained pressure the target degrades to `FRAME.FLOOR_HZ = 30` before it is allowed to jank; the adaptive-quality controller (§7.2) drops render fidelity to defend the floor.

---

## 3. Simulation cost model (spike P1)

Measured steps/s and ms/step by regime, on darwin-arm64 / Node 24 / the D7 build (numbers are single-machine estimates — re-measure on the CI matrix, **U20/U25**; the *shape* of the curve is the point, not the digits):

| Awake+contacting bodies | active pile (worst) | sleeping field | dormant machine (2 000 objs) |
|---|---|---|---|
| 250 | 0.38 ms · 2 600/s | 0.04 ms · 22 600/s | — |
| 500 | 0.66 ms · 1 500/s | 0.16 ms · 6 300/s | — |
| 1 000 | 1.64 ms · 610/s | 0.28 ms · 3 500/s | — |
| 2 000 | 4.40 ms · 230/s | 0.48 ms · 2 100/s | **0.13 ms · 7 500/s** (≈ 10 awake) |
| 4 000 | 12.6 ms · 79/s | 2.6 ms · 380/s | — |

Three facts fall out, and they are the whole budget:

1. **Real-time ceiling ≈ 4 500 *active* simple bodies.** At 4 000 the worst case is 12.6 ms/step — still inside 16.67 ms. Beyond that a fully-active scene enters slow-motion. The vast majority of scenes never approach it because they are dormant.
2. **Sleeping is 6–13× cheaper.** This is not a nice-to-have; it is what makes "thousands of objects" real. The renderer must therefore *show* sleep (dim settled bodies, §4) so authors trust that a big-but-idle scene is fine.
3. **Shape matters more than CCD.** Forced-awake at n = 1 000: boxes 481/s, balls+CCD 614/s, balls no-CCD 716/s. Box two-point manifolds cost *more* than a ball with continuous collision; CCD adds only ~17 %. So 03 §6's selective CCD (marble/pendulum only) is comfortably affordable — the risk was never CCD, it was contact count. No change to §6.

---

## 4. Rendering strategy (`types/perf.ts` `RENDER_CLASS`)

Draw calls are bounded by *kinds*, not object count. Every catalog type is classified (compile-checked exhaustive over `ObjectType`):

| Class | Types | How it draws |
|---|---|---|
| `instanced` (11) | platform, domino, marble, crate, plank, gear, lever, spring, pendulum, piston, conveyor | One `InstancedMesh` per **(type, skin)** over a unit box/sphere/disc; per-instance transform carries pos/rot/scale. Object count inside a group is free. |
| `generated` | ramp, curve (+ per-link rope sag, belt ribbons — 04 §12.1) | Bespoke per-object vertices (convex polygon, arc tessellation) — can't share one instanced mesh. Few per scene. |
| `overlay` | pulley, fan, magnet, trigger, goal | Translucent guides (04 §12.2), never in the solid batch. |

**Draw-call ceiling `MAX_INSTANCE_GROUPS = 11 × 8 = 88`** — a hard bound independent of object count (spike P4). A 5 000-domino scene is **1** instanced draw; a realistic 6-type × 3-skin mix is ~18 instanced + a few dozen generated link meshes ≈ 50–60 draws; the pathological "every (type,skin)" scene is still only 88 + overlays. `types/perf.ts` proves `INSTANCED_TYPES` is exactly the set `RENDER_CLASS` marks instanced, so reclassifying a type without updating the tuple fails compilation naming it.

Render-tier knobs (`RENDER`):
- **Sleep dimming** (`SLEEP_DIM_FACTOR 0.6`): the per-body `state` float already rides in the SAB (03 §5.4); sleeping instances desaturate and dim, making §3's dormancy legible.
- **LOD/culling**: frustum-cull instances outside the workshop camera; past `LOD_FAR_M` a beveled mesh drops to a flat imposter (`maxInstanceDetailLod` per tier). The tilted workshop camera (04 §4) has a bounded view volume, so culling is effective even on packed scenes.
- **Shadows** (`SHADOW_MAP_PX 2048`) are the biggest fill cost and the first thing `mid` drops (§7).
- **Belt/rope meshes** are per-link generated geometry (04 §12.1) — few in any scene, no instancing need, but they *are* the only object-count-linear draw term, so a scene with thousands of ropes is a documented revisit (U11).

This section is the concrete half of **U11**'s asset pass: the strategy, the budget, and the LOD/sleep rules are now normative; the actual materials, meshes, and `CollisionEvent.impulse`-driven SFX remain an implementation art task (U11 stays open, narrowed).

---

## 5. Transport & worker scaling

### 5.1 SAB sizing (spike P5)

`sabByteLength(8000) = 12·4 + 3·8000·4·4 = 384 048 bytes ≈ 375 KiB` — reconciling 03 §5.4's "≈ 384 KB" (it counted bytes). The buffer is fixed-size at load and never grows; triple-buffering is 3 slots regardless of body count.

### 5.2 The postMessage "cliff" is not a throughput cliff (spike P2)

Per published frame at the 8 000-body cap: SAB write **2 µs**, `structuredClone` copy **16 µs**, transferable-`ArrayBuffer` transfer **1 µs**. All three are < 0.1 % of the frame budget — so the fallback transport does **not** collapse on CPU. What SAB actually buys is: (a) zero per-frame allocation (no GC churn from a fresh `Float32Array` each publish), and (b) the renderer reading the *latest* consistent slot at display Hz, decoupled from message delivery timing (03 §5.5 interpolation). The fallback's degradation is therefore **jitter and GC pressure at high publish rates**, visible as micro-stutter, not a throughput ceiling. Decision unchanged: SAB primary, transferable fallback; the fallback is fully usable, just less smooth (and its cross-origin-isolation cost is an M9 embed question, R5/U5).

### 5.3 Overload behavior

`OVERLOAD.MAX_CATCHUP_STEPS = SIM.MAX_CATCHUP_STEPS = 5` (echoed, compile-tied). Per wake the worker does at most 5 steps then publishes; a scene too heavy for real time runs in honest slow-motion with a smooth frame, never a spiral or a frozen tab. Because pacing can't touch state (DET-1), a slow-motion run and a real-time run of the same scene are bit-identical — the leaderboard verifier (08 §5) doesn't care how slowly the author's device ran it.

---

## 6. Memory budget & the 8 000-body cap, revisited (spike P5)

At `MAX_DYNAMIC_BODIES = 8000`:

| Buffer | Size | Note |
|---|---|---|
| SAB (transforms) | 375 KiB | fixed, triple-buffered |
| GPU instance attributes | ~594 KiB | mat4 + color per instance, one set |
| Body registry (JS) | ~188 KiB | slot → (objId, piece) |
| Rapier world (WASM heap) | few MB | dominated by contact/island data, scales with *awake* contacts |

Total client sim+render working set is a few MB — trivial on any target device; **memory is not the constraint, step time is** (§3). The `8000` cap is therefore retained, now with evidence for *why it is the right number*: it sits comfortably above the ~4 500 active-body real-time ceiling (so a scene can be fully live and still merely slow, not broken), while a JSON document at that size is ~1 MB (R6, `LIMITS.maxJsonBytes`) — the storage and step ceilings meet at the same scale. Raising it would let scenes exceed the JSON cap and guarantee slow-motion with no smoothness benefit; lowering it would reject legal dormant mega-scenes that run fine. No change to `SIM.MAX_DYNAMIC_BODIES`.

---

## 7. Device tiers & low-end (`PERF_TIERS`) — U12, U17

The hard sim cap is universal (determinism); tiers vary **render fidelity and authoring guidance only**:

| Tier | smoothBodyTarget | Hz | shadows | overlays | LOD | fast-preview |
|---|---|---|---|---|---|---|
| `high` | `SIM.MAX_DYNAMIC_BODIES` = 8000 | 60 | ✅ | ✅ | full | — |
| `mid` | 4000 (cap/2) | 60 | ✕ | ✅ | 1 | — |
| `low` | `VERIFY.BODY_BUDGET` = 1500 | 30 | ✕ | ✕ | 0 | ✅ |

`smoothBodyTarget` is a *soft* authoring hint (the editor warns past it), not the hard cap — a dormant scene may far exceed it (§3). The load-bearing tie: **`low`'s target is the rankable ceiling.** A scene light enough to be leaderboard-verified (08 §5.5, ≤ 1 500 bodies) is exactly a scene light enough to stay smooth on weak hardware — one number, two guarantees.

### 7.1 Touch / low-end input (U12)
The `low` tier is also the touch profile. The 04 §13 touch maps and `EDITOR` gesture constants stand; what M8 fixes is the *render* envelope they run inside (no shadows, LOD 0, 30 Hz floor). Real-device gesture-conflict validation and any `EDITOR` constant tweaks remain first-implementation work (U12 stays open).

### 7.2 Adaptive-quality controller
A render-only feedback loop: if p95 frame time exceeds `DEGRADE_FRAME_RATIO` (1.25) × budget for `DEGRADE_WINDOW_FRAMES` (90 ≈ 1.5 s), drop one tier's worth of fidelity (shadows → LOD → overlays); recover after a calm window. It never throttles the worker. Thresholds and the initial tier auto-detection (GPU/UA heuristics) are unvalidated without device telemetry → **U24**.

### 7.3 Procgen fast-preview (U17)
Spike P6: a ~30-body generated machine self-checks at ~100 k steps/s, so the 06 §8.4 worst corner (~650 k simulated steps) is ~6.6 s on desktop, but **~20 s on mid and ~50 s on low-end** — unacceptable. `FAST_PREVIEW` (maxObjects = `GEN_DEFAULTS.objectCount`/2, stepFactor 0.5) runs a reduced generate+check first, shown whenever projected wall time exceeds `OFFER_THRESHOLD_MS` (3 s); the full run replaces it on accept. The 06 §8.4 budgets are counted in steps (PG-6), so this changes only *which* preset runs, never determinism. U17 narrows to: measure the real corner on target low-end hardware at implementation.

---

## 8. Backend read-path performance

No new endpoints or tables — the M4/M7 surface already carries the read path; this section validates it against query plans and sets the cache posture (`READPATH`).

| Read path | Plan (existing index) | Cache |
|---|---|---|
| Scene document GET | `scene_revisions` PK; `doc` TOASTed out of line (05 §2) so list queries never touch it | **immutable** — a published revision is content-addressed (05 §3); `SCENE_DOC_CDN_S` = 1 y at the edge |
| Gallery / `explore?sort=new` | `idx_scenes_public_listing (published_at DESC)`, keyset-paged | `EXPLORE_NEW_CACHE_S` 30 s |
| `explore?sort=trending/top` | `rank_score` from the Redis trending zset (08 §4.2), cold-served by `idx_scenes_rank` | `EXPLORE_TREND_CACHE_S` 60 s |
| `explore?sort=following` | join `idx_follows_followee` → `scenes(published_at DESC)`; a query, not a fan-out (08 §2.5) | private, short |
| Search | `idx_scenes_search` (tsvector) + `idx_scenes_title_trgm` | — |

**Posture (D21):** the read path is a plain content/social app — Postgres indexes + a Redis trending zset + CDN edge-cache on immutable public docs — with **no simulation and no write-amplifying fan-out** at MVP. Escalation is staged and trigger-gated, so scale-out is a planned move, not a surprise:

1. **Following feed** → materialized timeline for heavy followers when p95 > `FEED_P95_REVISIT_MS` (150 ms) or median followee set > `FEED_FOLLOWEE_REVISIT` (2 000) — 08 §2.5's trigger, endpoint shape unchanged.
2. **Listings** → read replicas + longer edge TTLs when the primary's read CPU is the bottleneck.
3. **Scene docs** → the 05 §2 object-storage escape hatch (p95 doc > 256 KB), contained to one table.

**Verification worker capacity (08 §5.5, echoed in `READPATH`):** `predictVerifyMs()` at enqueue marks over-budget scenes `unranked` *before* burning CPU (`VERIFY_BODY_BUDGET` 1 500, `VERIFY_WALL_BUDGET_MS` 20 s kill switch). At 10 000 typical publishes/day (~0.1 s each) that is ~17 CPU-min/day — a fraction of one `VERIFY_WORKER_CONCURRENCY`-pinned core. Capacity scales linearly with publish volume and is independent of read traffic; this is the only CPU-heavy job we own, and it is a background queue, never in a request path (01 §1 non-goal).

---

## 9. Measurement harness (extends 03 §12, seeds M9)

The 03 §12 "perf smoke" (5 000-body scene, steps/s per commit) is the seed. M8 makes it a per-tier regression gate; CI records per commit and fails the build on a regression beyond noise:

| Metric | Source | Regresses the build if |
|---|---|---|
| steps/s at 250 / 1 000 / 4 000 active bodies | headless SimCore (Node, all platforms) | > 15 % slower than the committed baseline for the `engineVersion` |
| sleeping-vs-active ratio at n = 1 000 | headless SimCore | drops below ~4× (sleep regression) |
| draw calls for the 6-type mixed corpus scene | render harness (Playwright, browser triple — extends U9's matrix) | exceeds the `MAX_INSTANCE_GROUPS` + generated budget |
| frame p95 at each tier on the 2 000-object dormant corpus | Playwright + tier emulation | > tier budget × 1.1 |
| procgen wall time, default + worst-corner params | headless generator | > committed baseline × 1.15 (also 06 §11) |
| SAB bytes at cap; client working-set memory | static + heap snapshot | exceeds §6 budget |

Baselines are committed per `engineVersion`/`PERF_VERSION`; a deliberate change updates the baseline in the same commit (the diff *is* the perf review). The browser-triple render numbers land with U9's Playwright matrix in M9.

---

## 10. Decisions & open issues

**Decided here:**
- **D20 — Performance budget & render-only adaptation.** Real time is defined by the awake+contacting body set, not object count (§1, §3); the frame budget is two parallel 16.67 ms threads (§2); adaptive quality degrades *rendering only* — determinism and leaderboards forbid touching simulation (§1 corollary, §7.2); three device tiers keyed to render fidelity with the hard sim cap universal (§7); the 8 000-body cap is retained with evidence (§6). Encoded in `types/perf.ts`.
- **D21 — Backend read-path scaling posture.** Gallery/trending/feed serve from existing Postgres indexes + Redis trending zset + CDN edge-cache on immutable published docs, with no read-path simulation and no fan-out; a staged, trigger-gated escalation ladder (materialized timelines → replicas → object storage) means scale-out is planned, not reactive (§8). No new endpoints, tables, or `openapi.yaml`/`schema.sql` changes.

**Resolved / narrowed:**
- **U11** → the rendering *strategy* (instancing per type×skin, 88-group ceiling, LOD/cull/sleep-dim) is now normative (§4); materials/meshes/SFX remain an art task. Open, narrowed.
- **U12** → render envelope for the touch/`low` tier fixed (§7.1); real-device gesture validation still first-implementation. Open.
- **U17** → fast-preview preset specified with a 3 s offer threshold (§7.3); measure the real low-end corner at implementation. Open, narrowed.

**Opened:**
- **U24 (new):** adaptive-quality controller thresholds (`DEGRADE_FRAME_RATIO`/window) and initial tier auto-detection heuristics are unvalidated without real-device frame telemetry → M9 / first implementation.
- **U25 (new):** every §3/§5/§6 number is single-machine (darwin-arm64, like U20); the §9 harness must establish per-tier baselines on real target hardware and the browser triple before these budgets are load-bearing. A WebGPU render path (01 §3.1/§6, flagged) could lift the §4 draw budget and is the natural M9+ follow-up once the WebGL2 baseline is measured.
- Carried: U20 (verify cost re-measure), U9 (cross-platform determinism / browser triple — the §9 render harness rides its Playwright matrix), U5 (SAB cross-origin isolation / embeds — M9).

---

## 11. Spike record (2026-07-21, Session 9)

Environment: darwin-arm64, Node 24, `@dimforge/rapier2d-deterministic-compat@0.19.3` (D7 build), scratchpad only (not committed — S3 precedent). Mini-expansion per 03 §6 for platform/crate/marble/domino with 02 material defaults. As with S6/S8, numbers are estimates to re-measure on the real SimCore (U20/U25); the design conclusions do not depend on their precision.

| Experiment | Result |
|---|---|
| **P1 cost by regime** | active pile (worst) 250→2.6 k · 1 000→610 · 4 000→79 steps/s; sleeping field 6–13× cheaper (n=1 000: 3.5 k vs 610); **dormant 2 000-object machine (≈ 10 awake) 0.13 ms/step, 130× under budget**. Real-time ceiling ≈ 4 500 active simple bodies. Shape/CCD: box 481 < ball+CCD 614 < ball 716 /s forced-awake — box manifolds cost more than CCD; 03 §6 selective CCD affordable |
| **P2 transport** | per frame @8 000: SAB write 2 µs · postMessage copy 16 µs · transfer 1 µs — all < 0.1 % of budget; the fallback's cost is GC/jitter, not throughput |
| **P4 draw calls** | 5 000 dominoes → 1 instanced draw; 6-type×3-skin mix → ~50–60; ceiling 88 (11×8), object-count-independent |
| **P5 memory** | SAB 375 KiB @cap (reconciles 03 §5.4's "384 KB" bytes); GPU attrs ~594 KiB; registry ~188 KiB — working set a few MB, step time is the constraint |
| **P6 procgen (U17)** | ~30-body machine ~100 k steps/s → worst corner ~6.6 s desktop / ~20 s mid / ~50 s low-end → fast-preview needed below the 3 s threshold |

All spike assertions pass (regime ordering, sleeping gain, dormant-machine headroom, CCD affordability, SAB size, draw ceiling). `types/perf.ts`: strict `tsc` green on all nine type files; **3/3 negative compile tests bite naming the offender** — dropping `goal` from `RENDER_CLASS` (missing key), reclassifying `marble` without updating `INSTANCED_TYPES` (`INSTANCED_TYPES lists non-instanced: "marble"`), dropping `low` from `PERF_TIERS` (missing tier).

---

## 12. Changelog

- **2026-07-21 (Session 9, M8):** initial acceptance. D20 (perf budget + render-only adaptation + tiers + cap retained), D21 (read-path posture). `types/perf.ts` added. No changes to the scene format, engine constants, API, or DB schema — M8 is a budget and a strategy over the existing surface, by design (the only object-count-linear risks — thousands of ropes, real low-end wall times — are logged as U11/U25/U17, not new caps).
