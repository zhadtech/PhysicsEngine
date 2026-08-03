# 03 — Simulation Core Specification

**Status:** Accepted (Session 3, 2026-07-19) — normative for the `engine` package
**Implements:** ADR-0002 (Rapier2D), the worker half of ADR-0003
**Consumes:** `02-SCENE-FORMAT.md` (schemaVersion 1), `types/scene.ts`
**Companion file:** `types/protocol.ts` (worker protocol types + shared-buffer layout + engine constants)
**Consumed by:** M3 (builder/player UI), M7 (replay verification), M8 (perf), M9 (CI)

---

## 1. Scope and package shape

The simulation core turns a scene document into a deterministic run: expand prefabs → step at fixed 60 Hz → publish transforms and events → compute analytics → snapshot/reset. It never renders, never touches the DOM, and never talks to the network.

```
packages/engine/
├── sim/          SimCore — pure, environment-free (runs in browser worker AND Node)
│   ├── expand.ts       scene → bodies/colliders/joints (§6) + shared geometry derivation
│   ├── step.ts         the fixed-step pipeline (§4)
│   ├── forces.ts       field & surface forces (§7)
│   ├── constraints.ts  gearMesh + pulley-rope solver (§8)
│   ├── analytics.ts    metric accumulators (§10)
│   ├── snapshot.ts     snapshot/reset bundles (§11)
│   └── dmath.ts        deterministic sin/cos/atan2 (§3, rule DET-5)
├── worker.ts     browser Web Worker shell speaking the protocol (§5)
└── transport.ts  SAB triple-buffer + postMessage fallback (§5.4)
```

Two hard rules:

1. **SimCore is environment-free.** No DOM, no `Date`, no `Math.random`, no `setTimeout`. The same code runs in the browser worker, in Node for CI determinism tests, and later for server-side replay verification (R2). Only `worker.ts`/`transport.ts` know about the browser.
2. **Rapier types never leak** out of `packages/engine` (ADR-0002). The public surface is exactly the protocol in `types/protocol.ts`.

---

## 2. Engine build — U1 resolved

**Spike result (2026-07-19, this session):** dimforge publishes official deterministic builds on npm. No custom Rust toolchain is needed.

| Check | Result |
|---|---|
| `@dimforge/rapier2d-deterministic` / `-deterministic-compat` on npm | ✅ exist, v0.19.3 (same release train as the standard package) |
| API surface needed by this spec (rope joint, spring joint, revolute/prismatic + motors + limits, fixed joint, snapshot/restore, sensors, `contactPairsWith`, `intersectionPairsWith`, `EventQueue`, contact-force events, CCD flag, `applyImpulseAtPoint`, `convexHull`) | ✅ all present in 0.19.3 |
| Double-run identity (62 bodies incl. motorized revolute, 600 steps, Node/darwin-arm64) | ✅ identical hash `91a2b287` |
| `takeSnapshot` at step 300 → `restoreSnapshot` → 300 more steps vs. straight 600-step run | ✅ identical hash |

**Decision (D7):**

- Package: **`@dimforge/rapier2d-deterministic-compat`**, version **pinned exact** (`0.19.3` at time of writing; no `^`/`~`). The `-compat` variant embeds the WASM as base64 — identical bytes in browser and Node, no bundler/loader variance. Cost: larger JS bundle; revisit non-compat + native WASM loading in M8 if bundle size hurts.
- `enhanced-determinism` excludes SIMD (upstream constraint). The M8 performance budget must be measured on **this** build, not the standard one.
- **`engineVersion`** is the semver of the `engine` package. Each engineVersion maps permanently to one exact Rapier package version plus this spec's constant set (`ENGINE_BUILD` const, reported in the `ready` message). Anything that can change simulation output bumps it: Rapier upgrade, solver/integration parameter change, any formula or constant in §7/§8, expansion-rule change (§6), analytics definition change (§10). Determinism, replays, and leaderboards are scoped to one engineVersion (ADR-0005 rule 4).
- Remaining tail of U1 → **U9**: cross-ISA identity (the actual point of `enhanced-determinism`) must be confirmed by the golden-hash CI matrix (§12) — the spike covered one platform. Risk is low (it is the feature's documented purpose), but it stays open until CI proves it.

---

## 3. Determinism specification

Same scene + same seed + same engineVersion + same command log ⇒ bit-identical state at every step, on every platform. The rules:

- **DET-1 — Fixed step.** `dt = 1/60` s exactly, set once at world creation. The world only ever advances by whole steps. Simulated time is `stepIndex / 60`; wall clocks exist only in the worker shell's pacing (§5.5) and never influence state. Rapier solver iteration counts stay at the pinned build's defaults; changing them is an engineVersion bump.
- **DET-2 — Pinned build.** §2. In addition, the JS layer computes in f64; values cross into Rapier's f32 through the WASM boundary cast, which is exact rounding and therefore deterministic. No manual `Math.fround` needed.
- **DET-3 — Stable construction order.** Expansion iterates objects sorted by id (lexicographic byte order — ids are ASCII by pattern), then links sorted by id. Within one prefab, bodies/colliders/joints are created in the fixed order its §6 table lists. Every engine-assigned handle is recorded keyed by `(objectId, piece)`; **any iteration over an engine-provided collection (contact pairs, event queues, body sets) is materialized into an array and sorted by our keys before effects are applied.**
- **DET-4 — Input canonicalization.** On load, every number in the scene passes `quantize(x) = Math.round(x * 1e4) / 1e4` (the writer's 4-digit rule, applied again by the reader), and defaults are filled from the single tables in `types/scene.ts`. Consequence: serialize → parse → expand is bit-identical to expanding the in-memory original (ADR-0005 consequence). Degrees convert once at load: `rad = deg * DEG2RAD`, `DEG2RAD = Math.PI / 180` (one shared constant, one multiply).
- **DET-5 — Transcendentals are load-time only, and ours.** JS guarantees bit-exact `+ − × ÷ sqrt abs min max` and comparisons across engines; it does **not** guarantee `Math.sin/cos/tan/atan2/pow/exp/log`. Therefore: per-step SimCore code may use only the exact operations. All angle→direction conversions (fan axis, conveyor tangent, prismatic axes, initial poses) happen at expansion time using our own `dsin/dcos/datan2` in `dmath.ts` — an fdlibm-style implementation built from exact operations only, hence cross-engine deterministic. Our angle domain is bounded (|angle| ≤ 4π after normalizing file degrees), so simple Cody–Waite range reduction suffices. `Math.sin` etc. are lint-banned in `packages/engine` (allowed nowhere but `dmath.ts`'s test file). Rapier's internal trig lives inside the pinned WASM — deterministic by DET-2.
- **DET-6 — One PRNG.** PCG32 (PCG-XSH-RR 64/32, reference constants), seeded from `world.seed`, owned by SimCore. v1 physics consumes zero random numbers; the PRNG exists so future features and procgen (M5) share one seeded source. Its state is part of the snapshot (§11).
- **DET-7 — Fixed phase order.** Every step runs the §4 pipeline; within each phase, iteration order is defined (emitters by id, bodies by registry index, links by id).
- **DET-8 — Commands land on step boundaries.** Every UI command takes effect at the start of the next step and is recorded as `(stepIndex, command)` in the command log. A run is fully described by `(scene, engineVersion, commandLog)`. v1's state-affecting commands are only play/pause/stepN/stop/reset, so replays are trivial; any future interactive tool must flow through the same log.
- **DET-9 — Two-phase effects.** Events observed after stepping `k` (collisions, sensor entries) produce state changes applied at the start of step `k+1` (trigger activations, removals). No mid-step mutation, no order ambiguity.
- **DET-10 — Deterministic removal.** Every 15 steps (0.25 s), bodies whose AABB lies fully outside `world.bounds` inflated by 2 m on every side are removed ("fell off the table"), in id order, emitting `removed` events. Removal is permanent until reset.
- **DET-11 — Transport is one-way.** The shared buffer is render-output only; SimCore never reads UI-written memory. The UI influences the simulation exclusively through commands (DET-8).

---

## 4. The fixed-step pipeline

Normative order, executed for each step `k`:

| Phase | Work | Ordering rule |
|---|---|---|
| P0 | Apply queued effects from step `k−1`: command effects (by `seq`), then trigger activation effects (by source trigger id, then target id — table 02 §5.4, semantics §9.3) | commands before effects |
| P1 | Schedules: piston cycle targets, spring latch state, motor states — pure functions of `stepIndex` + stored state (§6) | objects by id |
| P2 | Reset external forces; apply field forces: all fans, then all magnets (§7.1–7.2) | emitters by id; targets by registry index |
| P3 | Conveyor surface impulses (§7.3) via `contactPairsWith`, materialized + sorted | pairs by (conveyor id, body registry index) |
| P4 | Custom velocity constraints: gearMesh + rope-over-pulley (§8) — Gauss-Seidel, `CUSTOM_SOLVER_ITERATIONS = 8` passes | links by id within each pass |
| P5 | `world.step(eventQueue)` | — |
| P6 | Drain events (materialize + sort): collision starts, contact forces, sensor intersections → trigger/goal logic queues effects for `k+1`; analytics accumulators update (§10); every 15 steps: removal sweep (DET-10) | events by (a id, b id) |
| P7 | Publish: write frame slot (§5.4), post event batch, evaluate finish conditions (§9.2) | — |

---

## 5. Worker protocol

Message and constant definitions live in `types/protocol.ts`; this section is the behavioral contract.

### 5.1 Lifecycle

```
idle → (load) → ready → (play) → running ⇄ paused → finished → (reset) → ready
                  ↑______________________(reset)________________|
```

`error` during load returns to `idle`; `error` during a run is fatal for that run (reset required). Commands invalid in the current state are acked with `ok: false` and ignored.

### 5.2 Commands (UI → worker)

Every command carries `seq` (u32, monotonic). The worker acks each with `{ seq, ok, error? }`.

| Command | Payload | Semantics |
|---|---|---|
| `load` | scene (structured clone) | Validation gate (schema + semantic, shared `scene-format`) → expand → step-0 snapshot → `loaded` |
| `play` | — | Start/resume stepping |
| `pause` | — | Halt after current step; state preserved |
| `stepN` | `n` (1–600) | Debug: advance exactly n steps while paused |
| `setSpeed` | 0.25 \| 0.5 \| 1 \| 2 \| 4 | Playback pacing only — steps per wall-second. Never changes `dt`, never changes results (DET-1) |
| `stop` | — | Finish now: `finished(reason: "stopped", analytics)` |
| `reset` | — | Restore step-0 snapshot bundle (§11); back to `ready` |
| `shutdown` | — | Free world + buffers; worker may be terminated |

### 5.3 Messages (worker → UI)

| Message | Payload | Notes |
|---|---|---|
| `ready` | `engineVersion`, Rapier package + version, `transport: "sab" \| "postmessage"` | Once at boot (worker checks `crossOriginIsolated`) |
| `loaded` | `bodyCount`, `registry: {objId, piece}[]` (index = buffer slot), `warnings: LoadWarning[]`, `sab?` (SAB transport) | **Static geometry is not sent.** The renderer derives all static placement (ramp vertices, curve tessellation, spring/piston base poses) from the scene document via the same shared `expand`-geometry module SimCore uses — one source of truth, nothing to serialize |
| `frame` | `stepIndex`, transferable `Float32Array` | Fallback transport only; 3-buffer recycling pool, UI transfers buffers back |
| `events` | `fromStep`, `toStep`, `SimEvent[]` | Per publish batch. Semantic events (activation, trigger, goal, removal, actuator toggle, finish-relevant) are never dropped; collision/SFX events are capped at 256 per batch, highest impulse first |
| `finished` | `reason`, `AnalyticsReport` | §9.2, §10 |
| `error` | `code`, `message`, `detail?` | Codes: `E_SCHEMA`, `E_SEMANTIC`, `E_LIMITS`, `E_SCHEMA_NEWER`, `E_INTERNAL` |
| `ack` | `seq`, `ok`, `error?` | Every command |

### 5.4 Shared-buffer layout (primary transport)

One `SharedArrayBuffer`, created by the worker after expansion (it knows `bodyCount` — dynamic bodies only; static bodies never move and have no slot).

```
Int32Array header (12 words, Atomics):
  [0] MAGIC "SIM1"      [1] layoutVersion = 1   [2] bodyCount
  [3] writeCounter c    [4] latestStepIndex     [5] simStatus
  [6] flags             [7] reserved
  [8..10] stepIndex written in slot 0..2        [11] reserved

Float32Array body slabs: 3 slots × bodyCount × 4 floats
  per body: x, y, rot (radians), state (0 = asleep, 1 = awake, 2 = removed)
```

Writer protocol: write slot `(c+1) % 3`, store its stepIndex in `[8 + slot]`, then `Atomics.store` the incremented `c` into `[3]`. The two most recently published slots are never written, so a reader holding `c` can always safely read slots `c % 3` and `(c−1) % 3` as a consistent interpolation pair. **Rotations are radians in the buffer** (engine-native); only the file format uses degrees.

Body count cap: expansion may produce more bodies than objects (segmented ropes up to 64 each). Hard engine limit `MAX_DYNAMIC_BODIES = 8000`, checked at load (`E_LIMITS`). SAB size at cap ≈ 384 KB.

### 5.5 Pacing and interpolation contract

- **Worker pacing:** a MessageChannel-driven loop. Per wake: `owed = clamp(floor((now − epoch) · speed / dt) − stepsDone, 0, MAX_CATCHUP = 5)` steps, then one publish. The cap turns overload into slow motion, never a death spiral. Pacing affects *when* steps happen, never *what* they compute (DET-1).
- **Renderer interpolation (normative for M3):** maintain playhead `p` in step units; per display frame `p = clamp(p + Δt_display · 60 · speed, c_latest − 2, c_latest − 0.5)`; with `i = floor(p)`, `α = p − i`, output `lerp(state_i, state_{i+1}, α)`; angles interpolate along the shortest arc. Staying ≥ 0.5 step behind the newest slot absorbs publish jitter.

---

## 6. Prefab expansion — catalog type → Rapier realization

Shared rules:

- Local frames: each object's body origin is placed so the **type's reference point (02 §5.3) lands exactly at `pos`**, rotated by `rot`. `R(θ)` below is CCW rotation; all angles already radians (DET-4).
- Every collider gets the object's resolved `friction`/`restitution`; dynamic colliders get resolved `density` (mass from area × density, Rapier-computed).
- `anchored: true` on a dynamic-bodied type creates the body as `fixed` (its joints, if any, are still created).
- One shared `ground` body (fixed, at origin, no colliders) receives all world attachments.
- Collision groups: `DEFAULT` (everything physical), `ROPE` (segmented-rope segments; collides with `DEFAULT`, not with `ROPE`), sensors (`trigger`/`goal`) intersect `DEFAULT` but never solve contacts.
- CCD enabled on: `marble` bodies and `pendulum` bobs (small, fast). All others: off (cost; revisit in M8 if tunneling shows up).
- Creation order within a prefab is the row order listed here (DET-3).

**Structural (static, no slots)**

| Type | Realization |
|---|---|
| `platform` | Fixed cuboid half-extents `(w/2, h/2)` at `pos`, rotation `rot`. |
| `ramp` | Fixed convex polygon. Vertices (local, before `rot`), default = slope descending left→right: `(−w/2, −h/2), (w/2, −h/2), (−w/2, h/2)`. `flip: true` mirrors x (winding re-ordered CCW). |
| `curve` | Fixed compound of wall segments tracing an arc. Center `pos`, radius `r`, start angle **−90°** (pointing down from center), sweeping CCW by `sweep` (`flip` → CW), all rotated by `rot`. Tessellation (normative): `N = max(4, ceil(sweep_deg / 7.5))` segments; points `p_j = pos + R(rot) · r·(dcos φ_j, dsin φ_j)`; each consecutive pair becomes a cuboid of half-extents `(|p_{j+1}−p_j|/2, thickness/2)` at the midpoint, rotated to the segment direction. Anchors: `endA = p_0`, `endB = p_N`. |

**Simple dynamic bodies** (one body, piece `main`)

| Type | Realization |
|---|---|
| `domino` | Dynamic cuboid `(h/5) × h`; body center at `pos + R(rot)·(0, h/2)` (reference = center of base edge). |
| `marble` | Dynamic ball `r` at `pos`. CCD on. |
| `crate` | Dynamic cuboid `w × h` at `pos`. |
| `plank` | Dynamic cuboid `w × h` at `pos`. |

**Mechanisms**

| Type | Realization (bodies → joints → behavior) |
|---|---|
| `gear` | Dynamic body at `pos`, ball collider `r` (teeth are visual; coupling via `gearMesh`). Revolute to `ground` at `pos`. If `motorSpeed ≠ 0`: velocity motor, target `motorSpeed·DEG2RAD`, force cap `maxTorque`. Runtime: trigger toggle motorSpeed ↔ 0 (§9.3). Piece `main`. |
| `lever` | Dynamic cuboid `len × h`; body center at `pos + R(rot)·((0.5 − pivot)·len, 0)`. Revolute to `ground` at `pos`. If `minAngle`/`maxAngle` present: joint limits `[minAngle − rot, maxAngle − rot]` (radians, relative to initial pose). Load warning if `rot` outside `[minAngle, maxAngle]`. Piece `main`. |
| `spring` | Fixed base cuboid `w × 0.02` at `pos` + dynamic plate cuboid `w × 0.015` (piece `plate`). Prismatic joint base↔plate, axis `R(rot)·(0, 1)` (`rot = 0` → up), limits `[0, travel]` (0 = compressed, plate seated on base). Spring behavior: position motor targeting `travel` with `stiffness`/`damping`. `passive`: starts at `travel`. `triggered`: starts at 0 with limits locked `[0, 0]`; activation unlocks to `[0, travel]` — the pre-loaded spring fires (once; latch state in snapshot). |
| `pendulum` | `arm: "rod"`: one dynamic body with origin at `pos` (the pivot), rotation `rot` (arm hangs along −Y at `rot = 0`); colliders: ball `bobR` at local `(0, −len)` (type density; CCD on) + arm cuboid `0.015 × len` centered `(0, −len/2)` (fixed density 2 — hittable, contributes inertia). Revolute to `ground` at `pos`. Piece `main`. `arm: "rope"`: dynamic ball bob (piece `bob`) at `pos + R(rot)·(0, −len)`; Rapier rope joint (max distance `len`) to `ground` at `pos`; renderer draws the slack/taut line. |
| `piston` | Fixed base cuboid `w × 0.03` at `pos` + dynamic head cuboid `w × 0.03` (piece `head`). Prismatic base↔head, axis `R(rot)·(0, 1)`, limits `[0, stroke]`. Velocity motor with force cap `force`: each step (P1) target position `T` is computed, then motor velocity = `speed · sign(T − x)` (0 when `|T − x| < 1e−3`). `cycle`: `t = stepIndex/60 + phase·period`; `T = stroke` if `t mod period < period/2` else `0`. `triggered`: `T = 0` until activated, then `T = stroke` forever (latched). |
| `conveyor` | Fixed cuboid `w × h` at `pos`, rotation `rot`. Belt tangent `t̂ = R(rot)·(1, 0)` precomputed. Runtime: §7.3 when `active`. |
| `pulley` | Fixed body at `pos` + ball collider `r` (marbles can roll over the wheel; ideal ropes route through the **center** — §8.2). |

**Fields** — no bodies, no colliders; entries in the force tables (§7). Links attaching to a field object (or any static object) attach to `ground` at the resolved anchor's world point.

**Logic** — `trigger`/`goal`: fixed sensor cuboids `w × h` at `pos`, rotation `rot`. Intersection events only (§9.3).

**Links**

| Link | Realization |
|---|---|
| `rope` (`segments: 0`, no `via`) | Rapier rope joint (max distance = `length`, default = initial anchor distance) between resolved anchor points. |
| `rope` (with `via`) | Custom constraint §8.2. If `segments > 0` too, `via` wins and `segments` is ignored with a load warning (02 §6.2). |
| `rope` (`segments: 2–64`) | Chain of `segments` capsule bodies (radius 0.008, length `length/segments`, density 1.5, group `ROPE`), consecutive segments joined by revolutes at their ends; first/last segment joined by revolute to the endpoint anchors. Pieces `seg0 … segN−1`. |
| `springLink` | Rapier spring joint (`restLength` default = initial distance, `stiffness`, `damping`) between anchors. |
| `weld` | Fixed joint; relative pose captured at load from the two anchor frames. |
| `axle` | Revolute between the two dynamic bodies at world point `P` = endpoint `a`'s resolved anchor (local anchors derived from `P` for both). Load warning if `b`'s resolved anchor is > 0.05 m from `P`. Motor as `gear`. |
| `gearMesh` | Custom ratio constraint §8.1; `ratio` default `−rA/rB` from quantized radii. |

Anchor resolution (02 §6.3) maps named anchors to local points from **current props**, then to world via the object's pose; `at` offsets are local-frame as specified.

---

## 7. Field and surface forces (normative formulas)

Shared wake rule: an **active** field applies to awake dynamic bodies; it wakes a sleeping body only when the computed force magnitude satisfies `|F| ≥ FIELD_WAKE_FACTOR · m · max(g, 0.7)` with `FIELD_WAKE_FACTOR = 0.7` (strong enough to plausibly move it). This keeps distant cones from pinning the world awake while still letting fans blow resting marbles. Forces are applied at the center of mass (no torque) except the conveyor (contact-point impulses).

### 7.1 Fan

Precomputed at load: axis `d = (dcos θ, dsin θ)` (θ = `rot`; 0 = +X), `cosHalf = dcos(spread · DEG2RAD)`.
Per awake dynamic body with center `c`: `r = c − c_fan`, `dist = |r|`.
In the field iff `dist ≤ range` and `dot(r, d) ≥ cosHalf · dist` (cone test without normalization; `dist < 1e−4` counts as in-cone).
Force: `F = strength · (1 − dist / range) · d` — along the **axis** (air stream), linear falloff, peak `strength` newtons at the fan.

### 7.2 Magnet

Acts only on bodies with `magnetic: true`. `strength` is the force in newtons **at the reference distance `MAGNET_REF_DIST = 0.05 m`**; sign > 0 attracts.
Per eligible awake body: `r = c_mag − c_body`, `dist = |r|`; if `dist ≤ range`:
`F = strength · (MAGNET_REF_DIST / max(dist, MAGNET_REF_DIST))² · r̂` (inverse-square, clamped inside 5 cm — never singular). Magnets are static; no reaction force.

### 7.3 Conveyor

For each contact pair (conveyor, dynamic body) with contact points `q_i` (materialized + sorted, P3), let `v_belt = speed · t̂`. Per contact point:
`v_rel = dot(v_body(q_i), t̂)`; desired change `Δv = speed − v_rel`; applied impulse along `t̂`:
`J = m_eff(q_i, t̂) · clamp(Δv, ±CONVEYOR_MAX_ACCEL · dt · n_pts⁻¹)` with `CONVEYOR_MAX_ACCEL = 10 m/s²` (belt grip limit), `n_pts` = points in this pair, `m_eff` the effective mass along `t̂` at `q_i` (standard point-Jacobian: `1/m_eff = 1/m + (r_⊥·t̂_⊥)²/I`). Applied via `applyImpulseAtPoint` → marbles roll, boxes drag, exactly like a belt. Inactive conveyors are plain static boxes.

---

## 8. Custom velocity constraints (P4)

Both run in one Gauss-Seidel loop: `CUSTOM_SOLVER_ITERATIONS = 8` passes, links in id order within each pass, no warm starting (simplicity + determinism), f64 exact-ops math only (DET-5). They execute before `world.step`, so Rapier's own solver has the final word each step; coupling error is bounded and vanishes at 60 Hz scales.

### 8.1 `gearMesh` — ratio constraint

Constraint `C: ω_B − ρ·ω_A = 0` (velocity-level; `ρ` = `ratio`, default `−rA/rB`).
Per pass: `λ = −(ω_B − ρ·ω_A) / (1/I_B + ρ²/I_A)`; apply `ω_A −= ρ·λ/I_A`, `ω_B += λ/I_B`.
(`I` = angular inertia; a body with locked rotation or `fixed` status contributes `1/I = 0`.) Ideal coupling — no slip torque limit in v1 (noted for v2 if machines need clutches). Chains of meshes (A–B, B–C) converge within the 8 passes.

### 8.2 Rope over pulleys — U6 resolved

Rope `a → via[0] → … → via[k−1] → b`, total length `L` (prop or initial path length through pulley **centers** — wheel radius is visual in v1). Interior span lengths (pulley→pulley) are constants since pulleys are static, so the constraint reduces to the two end spans sharing a budget:

`C = |p_a − w_first| + |p_b − w_last| − B ≤ 0`, `B = L − Σ interior spans` (positive after load validation; `B ≤ 0` → load warning + rope starts violated, resolved by bias).

Unilateral velocity constraint (ropes only pull), solved per pass with accumulated impulse `Λ ≥ 0`:

- `û_a = (p_a − w_first)/|·|`, `û_b = (p_b − w_last)/|·|` (span < 1e−6 → that side's Jacobian is zero this step)
- `Ċ = dot(v_a(p_a), û_a) + dot(v_b(p_b), û_b)` (velocities at attachment points)
- bias `b = (ROPE_BIAS_BETA / dt) · max(0, C − ROPE_SLOP)`, `ROPE_BIAS_BETA = 0.2`, `ROPE_SLOP = 0.001`
- `λ = −(Ċ + b) / (K_a + K_b)` with `K_x = 1/m_x + (r_x × û_x)²/I_x`; clamp so `Λ = max(0, Λ + λ)`, apply `Δλ = Λ_new − Λ_old` as impulses `Δλ·û_a` at `p_a` and `Δλ·û_b` at `p_b`.

Endpoints on static bodies contribute `K = 0` naturally. Plain two-point ropes use Rapier's native rope joint instead (§6) — stronger solver, warm-started internally.

---

## 9. Run lifecycle

### 9.1 Load

Validation gate (shared `scene-format`: schema + semantic rules; `E_SCHEMA_NEWER` if `schemaVersion` exceeds ours) → expansion (§6) with load warnings collected → step-0 snapshot bundle (§11) → `loaded` published, initial frame written. Load warnings (this spec adds no new *errors* beyond 02 §8): lever `rot` outside limits, `via`+`segments` conflict, axle anchor mismatch > 0.05 m, rope starting violated, `MAX_DYNAMIC_BODIES` is an error (`E_LIMITS`).

### 9.2 Finish conditions

Evaluated in P7; first match wins:

| Reason | Condition |
|---|---|
| `stopped` | `stop` command |
| `hardCap` | `stepIndex ≥ HARD_CAP_S · 60`, `HARD_CAP_S = 600` |
| `quiescent` | Every dynamic body asleep or removed, **and** no live actuator (fan/magnet/conveyor currently `active`, gear with nonzero current motor speed, cycle-mode piston). Triggered-but-unfired pistons/springs don't block: if everything is asleep, nothing can enter a trigger, so they can never fire |
| `idle` | For `IDLE_WINDOW_S = 5` s straight: no semantic event (activation, collision start, trigger, goal, removal, actuator toggle) **and** no dynamic body outside the live actuators' own prefabs moved > 1e−4 m. Catches "fan pressing a marble into a wall" and "piston cycling in an empty corner" |

`finished(reason, AnalyticsReport)` freezes the run; only `reset`/`shutdown` (and `load`) are valid after.

### 9.3 Trigger and goal processing

- Sensor intersections drained in P6. A **trigger** fires on a dynamic body's entry: if `once` (default) and already fired → ignore; else queue one activation effect per `targets` entry **in array order** (file order — the one place authors control effect order) for step `k+1`. `once: false` re-fires on each entry event (per body entry, not continuous).
- Activation effects (02 §5.4): fan/magnet/conveyor → toggle `active`; `piston(triggered)` → latch extended; `spring(triggered)` → release latch (once); `gear` → toggle current motor speed between 0 and the **file value** (file value 0 → no effect; 02's W9 already warns). Targets with no effect: ignore (02 rule 9 warned at validation).
- A **goal** is satisfied on entry of an accepted body (`any` dynamic body, or one whose owning object id is in `accepts` — every expanded body knows its owner). First satisfaction per goal is recorded with its step; `success` = any goal satisfied (02 §5.3). The simulation does **not** stop on success (chains continue; the player UI may offer "stop at goal").

---

## 10. Analytics (normative definitions)

Constants: `V_ACT = 0.05 m/s`, `W_ACT = 10 °/s`, `CHAIN_WINDOW = 15` steps (0.25 s).

**Activation.** An object activates at the first step where any of its bodies has `|v| ≥ V_ACT` or `|ω| ≥ W_ACT` (initial `vel`/`angVel` ⇒ step 0), or it *fires* (trigger fires, goal satisfied, piston extends, spring releases, field/conveyor toggles on; fields starting `active` activate at step 0). **Activatable set** = all objects except pure structure (`platform`, `ramp`, `curve`, `pulley`).

**Attribution (chain edges).** When object O first activates at step k, its cause is searched in priority order; first hit creates edge cause→O:
0. **Sensor entry** (O is a `trigger` or `goal` that fired): the cause is known directly from the intersection event — the owner of the entering body; edge enterer→O. *(Added Session 6 — sensors emit intersection events, not collision-starts, so rule 1 never matches them; without this rule every trigger wire would cut the forest and start a new root. See §15.)*
1. **Contact:** among objects P (P ≠ O, P activated at step ≤ k) with a collision-start event P↔O in `[k − CHAIN_WINDOW, k]` — most recent contact wins, ties broken by smaller id (P6 keeps a compact recent-contact table).
2. **Trigger:** a trigger whose effect on O applied in `[k − CHAIN_WINDOW, k]`.
3. **Field:** an active fan/magnet whose region contained O's body at step k (emitters in id order).
Step-0 activations are roots (no edge). The edges form a forest.

**Report** (`AnalyticsReport` in `types/protocol.ts`):

| Metric | Definition |
|---|---|
| `simEndS` | `stepIndex / 60` at finish |
| `durationS` | Last step with any dynamic body at `|v| ≥ V_ACT` or any semantic event, `/ 60` — "when the machine stopped doing things" |
| `objectsActivated`, `activatableCount` | Distinct activated objects; size of activatable set |
| `firstActivationSteps` | Map objId → step (powers the UI timeline) |
| `chainReactions` | Edge count of the attribution forest |
| `longestChain` | Longest path (in edges) in the forest, computed at finish by DFS in id order |
| `maxSpeedMS`, `maxSpeedObj` | Max over steps of any dynamic body's `|v|` (sampled in P7 while writing frames); ties → earlier step, then smaller id |
| `success`, `goalTimes` | §9.3; `goalTimes` = map goalId → first-satisfaction second |
| `removedCount` | Bodies removed by DET-10 |
| `efficiencyScore` | `round(100 · (0.45·A + 0.35·min(1, longestChain / max(3, activatableCount − 1)) + 0.20·S))` where `A = objectsActivated/activatableCount`, `S = success ? 1 : 0`. Provisional formula; metric definitions are part of the determinism surface (engineVersion-scoped), so leaderboards stay comparable within a version |
| `finalHash` | State hash at finish (§12) — carried on leaderboard submissions for future replay verification (R2/M7) |

---

## 11. Snapshot and reset

`SnapshotBundle = { rapier: Uint8Array (world.takeSnapshot), extra: ExtraState }`

`ExtraState` (plain serializable struct): `stepIndex`, PRNG state, per-trigger fired flags, spring/piston latch + target state, field/conveyor/gear active-motor state, analytics accumulators, command log, recent-contact table. **Every stateful thing outside Rapier lives here** — adding runtime state anywhere else is a spec violation (it would silently break reset/replay).

- v1 keeps exactly one bundle: step 0, taken at load. `reset` restores it (spike verified restore-equivalence) and republishes the initial frame.
- The same bundle format is forward-compatible with rewind points and server-side replay verification — both operate on `(scene, engineVersion, commandLog, SnapshotBundle?)`.

---

## 12. Verification plan (CI — seeds M9)

**State hash** (normative, implemented in SimCore, exposed in `finished`): FNV-1a 32 over dynamic bodies in registry order — per body `round(x·1e4), round(y·1e4), round(rot·1e4), state` — plus `stepIndex`.

| Test | Guards against |
|---|---|
| Double-run identity: every corpus scene, 3600 steps, hash every 60 — two runs, same process | Internal nondeterminism (map iteration, unsorted event handling) |
| Cross-platform golden hashes: CI matrix (linux-x64 + macos-arm64, pinned Node LTS) against committed goldens per engineVersion; browser triple (Chromium/Firefox/WebKit, Playwright) added in M9 | U9 — the enhanced-determinism promise |
| Snapshot equivalence: run 300 → snapshot → run 300 vs. straight 600 | Snapshot/ExtraState completeness (§11) |
| Round-trip: expand(scene) vs. expand(parse(serialize(scene))), hash-equal after 600 steps | DET-4 quantization rule |
| Force-layer units: fan falloff/cone edges, magnet clamp at 5 cm, conveyor accel cap, gearMesh chain convergence < 1e−3 rad/s after 8 passes, pulley length error < 2·slop under 10× load | §7/§8 formulas |
| Command-boundary test: pause/resume/setSpeed at random wall times vs. uninterrupted run — identical hashes | DET-1/DET-8 (pacing never leaks into state) |
| Perf smoke: 5000-body corpus scene, steps/s recorded per commit | Baseline for M8 (non-SIMD build!) |

The corpus = 02's examples + one scene per catalog type + adversarial scenes (5000 dominoes; 64-segment ropes; gear chains; all-fields). Grows with every bug found.

---

## 13. Defaults tuning pass (U7)

Analytic pass over the M1 catalog at desk scale (masses from 2D density × area):

| Object | Mass | Check |
|---|---|---|
| marble r 2.5 cm | 4.9 g | target ≈ 5 g ✓ |
| domino 8 cm | 7.7 g | target ≈ 8 g ✓ |
| crate 8 cm | 25.6 g | ✓ plausible |
| plank 40 cm | 40 g | ✓ |
| gear r 10 cm | 188 g | motor `maxTorque` 0.5 N·m lifts a 26 g crate at r = 0.1 (needs 0.025 N·m) with 20× headroom ✓ |
| pendulum bob r 4 cm | 30 g | ✓ |

Force/energy sanity: piston 5 N vs. heaviest default part (40 g ⇒ 0.4 N weight) ✓; conveyor 10 m/s² grip reaches full belt speed in ~30 ms ✓; springLink 50 N/m sags 5 mm under a crate ✓. **Two defaults failed sanity** and are amended (D8, pre-release — see below):

- **`spring.stiffness` 80 → 25 N/m.** At 80, stored energy ½kx² = 0.26 J launches a marble ~10 m/s — it leaves a 4 m board instantly. At 25 (0.08 J, shared with the 7.5 g plate): marble exit ≈ 3.6 m/s, rise ≈ 0.65 m — a satisfying desk-scale kicker that still shoves crates.
- **`fan.strength` 2 → 0.4 N.** 2 N on a 5 g marble is 400 m/s² (40 g) — everything in the cone blasts off-screen. 0.4 N peak with linear falloff: marbles get a brisk ~40 m/s² up close, crates (needing ≥ ~0.13 N against friction) creep only near the fan — tunable upward per scene.
- **`magnet.strength` 3 unchanged**, but its unit is now anchored by §7.2: newtons **at the 5 cm reference distance** (raw inverse-square with no reference would have meant ~1200 N at contact). At 5 cm a default magnet yanks a crate at ~115 m/s²; at 20 cm, ~7 m/s² — snappy, sane.

**Amendment mechanics:** schemaVersion 1 is unreleased (no scenes exist outside this repo), so v1 is amended in place — 02 §5.3 tables, `types/scene.ts` doc comments, changelog note in 02; schema ranges are untouched (defaults live in spec + types only). Post-release, the same change would have required schemaVersion 2 + migration (02 §9); that rule stands. **U7 narrows to:** empirical confirmation with the real engine at first implementation (expected outcome: small tweaks at most; any post-release change bumps schemaVersion).

---

## 14. Decisions and question status

**Decided here:** D7 — engine build: official `@dimforge/rapier2d-deterministic-compat`, exact-pinned; engineVersion policy (§2). D8 — pre-release default amendments (§13). Plus the normative determinism rules DET-1–DET-11, the phase pipeline, protocol, expansion tables, force formulas, custom constraints, finish conditions, and analytics definitions above.

**Resolved:** U1 (spike — official deterministic build works; tail tracked as U9), U4 (§7), U6 (§8.2), U7 (narrowed — §13).

**Opened / carried:**

- **U9** — cross-ISA golden-hash CI must confirm enhanced-determinism across platforms (low risk; M9 sets up the matrix, first implementation runs it).
- **U10** — Rapier motor parameter naming/behavior for force caps (`maxTorque`/`force`) verified only by API presence, not by dynamics tests; confirm exact motor model (impulse clamp vs. stiffness form) at first implementation. Fallback: model motors in our P4 layer (same solver as §8).
- U8 (belt visuals) unchanged → M3/M8. *(Since resolved in M3: D9, 04 §12.1.)*

---

## 15. Changelog

- **2026-07-20 (Session 6, M5 — D14):** pre-release amendment to §10: added attribution rule 0 (**sensor entry** — a `trigger`/`goal`'s activation cause is the object whose body entered it). Sensors produce intersection events, not collision-start events, so rule 1 could never match them; every trigger wire silently fragmented the attribution forest into a new root, breaking chain metrics for any machine using signal hand-offs (found designing M5's chain accounting). `ActivationCause` in `types/protocol.ts` gains the `{ via: 'sensor'; from }` variant (additive). Analytics definitions are engineVersion-scoped (§2, §10); the engine is unimplemented and the format pre-release, so this is an in-place amendment with no migration — same mechanics as D8 (02 §13).
