# 06 — Procedural Generation Specification

**Status:** Accepted (Session 6, 2026-07-20) — normative for the `procgen` package
**Covers:** brief item 8 (parameters: seed, duration, object count/types, difficulty, plane angle, theme, chaos, chain count)
**Consumes:** `02-SCENE-FORMAT.md` (catalog + validation gate), `03-SIMULATION-CORE.md` (SimCore, determinism, analytics), `04-BUILDER-UX.md` (Generate entry, undo, save flow), `05-BACKEND.md` (ordinary save path)
**Companion file:** `types/procgen.ts` (params, stage library, plan IR, report, constants)
**Consumed by:** M6 (AI pipeline reuses §8's checker), M8 (perf budget), M9 (CI)

---

## 1. Scope and architecture

The generator turns nine user knobs into a scene document that **provably works**: it plans a machine as a grammar of stages, lays it out geometrically, emits scene JSON through the ordinary 02 validation gate, then **simulates it headlessly with SimCore** and only returns candidates whose measured behavior satisfies the request (or the closest miss, reported honestly).

```
packages/procgen/
├── rng.ts       PCG32 + stream selection (§3)
├── params.ts    resolve/clamp/viability (§2)
├── plan.ts      lane & stage selection (§6)
├── layout.ts    gravity-frame placement + hand-off solver (§7)
├── emit.ts      canonical writer (§3 PG-3)
├── check.ts     SimCore harness + gates (§8) — shared with M6's repair loop
└── repair.ts    diagnosis → targeted fixes (§8.5)
```

Hard rules:

1. **Client-side only.** Generation runs in its own Web Worker (never the render/sim worker) in the browser, and in Node for CI — `check.ts` embeds SimCore directly (03 §1 makes it environment-free; the engine's `worker.ts` is just a shell over the same core). No server-side generation service exists; a generated scene is saved through the ordinary M4 API like any hand-built document (ADR-0005 rule 5 — same gate, no special path).
2. **Deterministic** (§3): same `procgenVersion` + same resolved params ⇒ byte-identical scene JSON and equal report. "Random" comes only from the seed the user (or the dialog's dice button) chose.
3. **The self-check loop is the truth.** Planner estimate models (§6, calibrated in §12) only need to land within repair's reach; correctness claims come from simulation, never from the models.

---

## 2. Parameter surface

The brief's nine knobs, resolved to `ResolvedGenParams` (`types/procgen.ts`; defaults `GEN_DEFAULTS`, ranges `GEN_RANGES` — out-of-range values are clamped, not rejected):

| Brief knob | Param | Range (default) | Maps onto | Verified by |
|---|---|---|---|---|
| Random seed | `seed` | uint32 (dialog rolls one) | `world.seed` (provenance) + every sampling stream (§3) | byte-identical regenerate |
| Desired duration | `durationS` | 3–300 s (30) | `meta.durationHint` + planner target | gate G3 |
| Number of objects | `objectCount` | 8–5000 (60) | plan budget, includes structure | gate G6 |
| Object types | `allowedTypes` | ⊆ catalog (all) | stage-pool filter (§2.1) | G1 (nothing outside the set) |
| Difficulty | `difficulty` | 0–1 (0.5) | tier unlock, margins, wiring (§9.1) | indirectly via G2 retries |
| Plane angle | `planeAngle` | −45–45° (0) | `world.planeAngle`; layout works in the gravity frame (§7.1) | G2 |
| Theme | `theme` | 5 names (workshop) | skins, weights, title words (§9.3) — **never physics** | — |
| Chaos | `chaos` | 0–1 (0.3) | sampling widths (§9.2) | PG-4 invariant |
| Chain reactions | `chains` | 1–3 (1) | lane count = independent cascades (§6.3) | gate G4 |

Duration ≤ 300 s keeps the check budget inside the engine hard cap (`SIM_FACTOR_CAP` × 300 = `HARD_CAP_S`). `objectCount` tops at `LIMITS.maxObjects` (value-tied in `GEN_RANGES`).

### 2.1 `allowedTypes` viability

The pool = stages whose `uses` ⊆ `allowedTypes`, tier-gated by difficulty (§9.1). Resolution rules:

- `platform` is structurally required (shelves) — excluding it is `E_PROCGEN_PARAMS` (`REQUIRED_TYPES`).
- `goal` excluded → the machine ends in a `crashTopple` flourish; gate G2 (success) is waived and the report says so.
- After filtering, the **port graph** (stage `emits` → stage `accepts`) must contain a path from ≥ 1 starter to ≥ 1 terminal. If not, `E_PROCGEN_PARAMS` with the missing capability named ("no mover among allowed types", "nothing can start").
- `gear` is in the catalog but not in the v1 library (`PROCGEN_EXCLUDED_TYPES`): its motor model is unverified (U10) and a gear cannot start off and be toggled on (§5.1 CT-2). Allowing it is a no-op; the report notes it.

---

## 3. Determinism rules (PG-1 … PG-6)

Mirrors 03 §3 in spirit; scope is the generator, not the engine.

- **PG-1 — Pure function.** `generate(params) → { scene, report }` depends on nothing but `procgenVersion` + `ResolvedGenParams`. `Math.random`, `Date`, locale, and environment are lint-banned in `packages/procgen` (same rule as the engine). The dialog may roll a random default seed — that is UI, outside the function.
- **PG-2 — One PRNG family, labeled streams.** PCG32 (PCG-XSH-RR 64/32, reference constants — the same algorithm as DET-6). Every draw comes from a **labeled stream**: `rngFor(seed, label)` = PCG32(initstate = `seed`, initseq = FNV-1a-32(label)). Label grammar (normative): `cand{i}/{phase}` for plan-level draws, `cand{i}/lane{l}/stage{j}/{purpose}` for stage-local draws (`purpose` ∈ `pick`, `size`, `jitter`, `skin`), `title` for naming. Consequence: repairing stage j re-draws only stage j's streams — everything else is untouched (local repair stability). Reference implementation in BigInt; optimized variants must be bit-identical (test vector `PCG32_TEST_VECTOR`).
- **PG-3 — Canonical writer.** Fixed key order: root `schemaVersion, engineVersion, meta, world, objects, links`; `meta` `title, description, tags, durationHint`; `world` `gravity, planeAngle, seed, bounds`; objects `id, type, pos, rot, skin, props`; links `id, type, a, b, props`; props keys in the 02 §5.3/§6.2 table order for their type. Strict-writer default omission (02 §2), 4-fractional-digit quantization with `−0 → 0`, objects/links in creation order. Two runs produce identical bytes.
- **PG-4 — Chaos is width, never entropy.** `chaos` widens sampling distributions (§9.2) whose draws still come from PG-2 streams. Jitter is capped at `CHAOS_JITTER_MAX_FRAC` (0.5) of the local hand-off margin, so chaos can shave reliability headroom but never spend it below the floor the solver guaranteed.
- **PG-5 — Versioned reproducibility.** `procgenVersion` (semver, `types/procgen.ts`) bumps on any change to templates, weights, constants, sampling order, or the writer. Golden outputs are scoped to the pair (`procgenVersion`, `engineVersion`) — the check half depends on engine behavior.
- **PG-6 — Deterministic budgets.** Search effort is counted in candidates, repair rounds, and simulated steps (`PROCGEN` constants) — never wall-clock. Wall time drives only the progress UI and the user's cancel button; cancel returns the best candidate so far with `outcome: "closest"` and the report's `candidatesTried` showing how far it got.

---

## 4. Machine model

A machine is 1–3 **lanes** (independent cascades — attribution trees, § G4). A lane is a chain of **stages** (template instances) connected by **hand-offs**. What a hand-off carries is its **baton**:

| Baton | Carrier | Typical producer → consumer |
|---|---|---|
| `roll` | body rolling along a surface | ramp → dominoes, curve → conveyor |
| `fall` | body arriving ballistically | shelf-edge drop → lever, funnel |
| `tip` | toppling body striking at height | domino → marble on a pedestal |
| `push` | lateral shove at floor level | piston head, pendulum bob → crate |
| `signal` | trigger activation (a wire, no body) | triggerWire → piston/fan/magnet/spring/conveyor |

### 4.1 Catalog truths (CT-1 … CT-8)

Facts of 02/03 the generator must respect — each was load-bearing in the design:

- **CT-1 — Only roots self-start.** Anything moving/firing at step 0 becomes an attribution root (03 §10). Mid-lane stages must therefore start **at rest** and be caused externally: pendulums displaced (`rot ≠ 0`) only as roots, mid-lane pendulums hang straight and get struck; all seated bodies use exact seating (§7.2) so settling never crosses `V_ACT`.
- **CT-2 — Gears can't start off.** A nonzero `motorSpeed` is applied from step 0; the trigger effect toggles current ↔ 0 (02 §5.4). There is no off→on-once semantics, and motor dynamics are U10-unverified → `gear` excluded from the v1 library.
- **CT-3 — The five signal receivers** are `fan`/`magnet`/`conveyor` with `active: false` (toggle on), `piston` `mode: "triggered"` (extend once), `spring` `mode: "triggered"` (release once). These are the only off→on targets a `triggerWire` may drive.
- **CT-4 — Step-0-active emitters are roots.** A conveyor/fan/magnet that starts `active`, and any cycle-mode piston, activates at step 0 (03 §10) and roots its own (usually tiny) tree. The plan records them in `expectedRoots`; G4 counts only trees with ≥ `MAJOR_CHAIN_MIN_EDGES` (3) edges, so they never inflate the chain count, but they do count toward G5 activation.
- **CT-5 — Attribution likes crisp hand-offs.** A contact edge requires collision-start within `CHAIN_WINDOW` (0.25 s) of the effect's activation (03 §10). Impulsive hand-offs (strikes, drops, kicks) always qualify; slow compressive pushes (a crate leaning into a crate for > 0.25 s before it moves) can drop the edge and fragment the forest. The planner prefers impulsive hand-offs; G4 failures repair by raising incoming speed (§8.5).
- **CT-6 — Stay on the board.** Layout keeps every trajectory and rest position inside `world.bounds` (generator-chosen, §7.1) with margin; DET-10 removes bodies beyond bounds + 2 m, which would kill a lane silently.
- **CT-7 — Time budget.** Target ≤ 300 s; check runs cap at `SIM_FACTOR_CAP` (2×) target, inside `HARD_CAP_S` 600.
- **CT-8 — Flats never brake.** Rigid-body rolling has no rolling resistance (measured §12 E4: 100% speed retention). Flat runouts are pure *time* knobs; speed is shed only by slopes, impacts, or catchers.

---

## 5. Stage library (v1 — 18 stages)

Normative table in `types/procgen.ts` (`STAGE_LIBRARY`: tier, `uses`, ports, object/duration envelopes, stretch rates). Expansion recipes and sentinels:

| Stage | Recipe (objects it places) | Sentinel |
|---|---|---|
| `rampRoll` | ramp; when root: marble seated on the hypotenuse near the apex (§12 E2 placement) | the marble (or incoming payload) |
| `curveChannel` | 1–3 `curve` arcs chained end-to-end, redirecting a rolling/falling payload | payload |
| `dominoRun` | n dominoes at spacing `s = f·h`, `f` ∈ 0.5–0.9, along the row (serpentine wobble under chaos); when root: first domino gets the §6.2 kick | last domino |
| `dominoFork` | Y-split: 3-domino stem, two diverging arms ≥ 25° apart — the lane forks (fanout 2) | last domino of each arm |
| `marbleDrop` | marble seated at a shelf edge; incoming tip/push nudges it off | the marble |
| `weightDrop` | crate seated at a shelf edge (heavy payload for levers/pulleys) | the crate |
| `leverLaunch` | lever (pivot 0.35–0.5) + payload on the short end; incoming fall on the long end catapults the payload | the payload |
| `springKicker` | spring pad (passive: compressed by arriving payload; triggered: latched, fired by signal) launching a marble | the marble |
| `pendulumStrike` | pendulum; root variant displaced 40–80°, mid-lane at rest struck by the baton | the pendulum |
| `conveyorCarry` | conveyor belt (active, or `active: false` + signal); carries payload its length, drops off the end — the main long-duration knob (w/speed set the time) | payload |
| `pulleyGate` | crate (falls) — rope `via` pulley — plank gate lifting; released marble rolls off a shallow ramp | the released marble |
| `pistonPunch` | triggered piston + payload on a ledge in front of the head | the payload |
| `fanCarry` | fan (usually `active: false` + signal) drifting a marble along a channel — slow knob | the marble |
| `magnetSnap` | magnet (`active: false` + signal) yanking a `magnetic: true` crate across a gap | the crate |
| `triggerWire` | trigger zone straddling the previous stage's exit path; `targets` = the signal receivers (fan-out 2 at difficulty ≥ 0.5) | the trigger |
| `timedPistonStart` | cycle piston (`period = 2·delay`, `phase: 0.5` ⇒ first extension exactly at `delay`, CT-7 delay ≤ 30 s) punching a payload — the delayed root for lanes 2+ | the payload |
| `crashTopple` | 3–12 crates/planks stacked to collapse — terminal flourish | last-placed crate |
| `goalCatch` | goal zone (+ catch platform when the baton falls) sized to the arriving payload; `accepts` = [payload id] | the goal |

Port-compatibility closure over the library guarantees a tier-0-only pool (`rampRoll`, `curveChannel`, `dominoRun`, `marbleDrop`, `goalCatch`) can still build complete machines — the §12 spike machine is exactly that.

### 5.1 Payload sharing

A hand-off's payload object belongs to the *emitting* stage; the accepting stage receives it (a `dominoRun` accepting `roll` places a strike-plate domino in the marble's path, not a new marble). Adapters (§7.3) never add payloads, only geometry.

---

## 6. Planner

### 6.1 Lane and stage selection

```
plan(params, rng):
  pool ← viable stages (§2.1) with weights = theme.weights × tierWeight(difficulty) ^ chaosTemperature
  lanes ← params.chains lanes; lane 0 carries the goal
  budget per lane: lane 0 gets ⌈55%⌉ of objectCount, rest split evenly
  for each lane:
    root ← weighted pick from starters in pool (lane 0 prefers gravity starters;
            lanes 1+ prefer timedPistonStart when a delay is needed — §6.3)
    repeat:
      next ← weighted pick from pool where prev.emits ∈ next.accepts
              (insert triggerWire automatically when next accepts only signal)
      size next toward remaining duration share (stretch knobs first: §6.4)
    until estDuration ≥ lane share  or  object budget spent
  lane 0 ends: goalCatch (or crashTopple if goal excluded); other lanes end: crashTopple
  return plan  (estObjects within G6 tolerance, else re-plan — counts toward PLAN_ATTEMPTS_MAX)
```

Weighted picks and sizes draw from `cand{i}/lane{l}/stage{j}/…` streams (PG-2).

### 6.2 Roots

- `rampRoll`: marble on the slope — gravity starts it at step 0.
- `dominoRun`: first domino gets the **corner-pivot kick** (spike-verified — a center spin fights the floor contact and dies): file props `angVel = −ω` and `vel = (−ω̂·h/2, |ω̂|·w/2)` with `ω = DOMINO_KICK_DEGS` (350 °/s), `ω̂` in rad/s, `w = h/5`. Quantized like everything else.
- `pendulumStrike`: `rot` displaced 40–80° — swings at step 0.
- `timedPistonStart`: the only *delayed* root (CT-4 makes it a step-0 attribution root, but its punch lands at `delay`).

### 6.3 Multi-lane timing (`chains` ≥ 2)

Lane delays must defeat the engine's idle finisher (03 §9.2 ends a run after 5 quiet seconds): the union of intervals `[delay_i, delay_i + est_i]` must cover `[0, machineEnd]` with every gap < `IDLE_WINDOW_S − IDLE_OVERLAP_MARGIN_S` = 4 s. Planner assigns `delay_k` inside the running window of already-started lanes; delays > `MAX_STARTER_DELAY_S` (30 s) are unreachable (piston period cap) and re-planned. Machine duration estimate = max over lanes of `delay + Σ stage estimates`.

### 6.4 Duration estimating and stretching

Stage estimates come from the calibrated models (§12): domino front speed `K(s/h)·√(g·h)` (`DOMINO_FRONT_K`, valid h ≤ `DOMINO_RUN_MAX_H_M`), ramp exit `K_RAMP_EXIT·√(4·g·Δy/3)`, ballistic fall `√(2h/g)`, flat runout `d/v` (CT-8), conveyor `w/|speed|`, pendulum quarter-period `(π/2)·√(len/g)`. When a lane needs more seconds than its stages' natural envelope, the planner stretches, in order: `conveyorCarry` length/speed → `dominoRun` count (0.085 s/domino) → flat runout length → extra `curveChannel`. Each knob's marginal cost in objects and meters is known, so duration and object-count targets are negotiated together at plan time.

---

## 7. Layout and constraint solving

### 7.1 Gravity frame and bounds

Layout happens in the **gravity frame** — the board frame rotated by `−planeAngle` so effective gravity is exactly −Y and shelves are perpendicular to it. On emit, positions rotate back by `+planeAngle` and shelf/conveyor `rot` gains `planeAngle` (board-frame file, 02 §2). `world.bounds` is **generator-chosen**: the AABB (board frame) of all geometry plus ballistic envelopes, plus 0.2 m margin, clamped to the schema's 200 m — machines define their own table size rather than cramming into the 4 × 2.4 default (CT-6 keeps everything inside; DET-10's +2 m removal apron stays untouched).

### 7.2 Rows, shelves, exact seating

Serpentine flow: rows stacked top-to-bottom, direction alternating (lane 0 outermost); row height = tallest stage + drop clearance; each row gets shelf `platform`s under its stages (one per contiguous run). Row-to-row transport is gravity (drops at row ends — a free, reliable hand-off).

**Exact seating (normative):** every resting body is placed at the *contact-exact* pose from catalog geometry (03 §6 reference points make this one line per type: domino `pos.y = shelfTop`; marble `pos.y = shelfTop + r`; crate `pos.y = shelfTop + h/2`; …), then quantized (DET-4). Worst-case quantization error is 0.05 mm; a body released from 0.05 mm reaches `√(2g·5·10⁻⁵)` ≈ 0.031 m/s < `V_ACT` 0.05, so **seated objects can never self-activate** (CT-1). Spike E1 measured 10⁻⁷ m/s — five orders of headroom.

### 7.3 Hand-off solver

Each hand-off is solved locally, in lane order:

- **Emit window:** exit point, direction, speed range `v·(1 ± 0.15)` from the stage model (± chaos widening).
- **Transfer map:** same-row batons continue along the row; row-drops are ballistic — `t = √(2h/g)`, `Δx = v·t`, landing dispersion = speed uncertainty × `t` + chaos jitter.
- **Accept window:** next stage's entry geometry must contain the landing/arrival zone inflated by `HANDOFF_MARGIN_BASE_M` × difficulty scale (§9.1). If dispersion exceeds the window, insert a **funnel** (two angled platforms) — dispersion collapses to the funnel throat.
- **Adapters** (geometry-only, no payloads — §5.1): `runoutFlat` (time, CT-8), `dropChute` (roll → fall at a row end), `funnelCatch` (fall → roll). Inserted automatically on port or geometry mismatch.
- **Speed shedding:** never by flats (CT-8); a too-hot arrival gets an upslope segment (`Δy = 3v²/4g` stops a rolling marble) or a catcher wall.

### 7.4 Backtracking

```
layout(plan):
  for lane, stage in plan (lane-major order):
    for try in 0 .. BACKTRACK_PER_SLOT:                     # 8
      sample stage size/pose from its streams (try suffix in the label)
      if fits row (else open new row via dropChute) and hand-off solvable: place; break
    else:
      backtrack ≤ 2 stages (re-sample them); planAttempts += 1
      if planAttempts > PLAN_ATTEMPTS_MAX: candidate fails   # 40 → next candidate seed
  safety net: pairwise OBB overlap scan (different stages, non-contact pairs) — any hit
              is a layout bug: reject candidate (a shipped overlap would fail G1 anyway)
```

Object ids: builder-convention `ID_PREFIX` + ordinal (`dom12`, `tri2` — `types/editor.ts`), assigned in creation order; ids are opaque (02 §2.1) but familiar ids keep generated scenes editable.

---

## 8. Self-check loop

### 8.1 Harness

`check.ts` loads the emitted scene into SimCore (the identical package the player runs — 03 §1), steps to a finish condition or the step cap, and collects: the full event log (activations with causes, trigger/goal events), `AnalyticsReport`, and the attribution forest rebuilt from `ActivationEvent.cause` (the 04 §10.5 client rebuild, shared). Requires the D14 sensor-entry rule (03 §10 rule 0) — without it every `triggerWire` would cut its lane's tree in two.

**M6 contract:** this harness — gate table, diagnosis, report — is exactly what the AI pipeline calls on candidate scenes from the LLM. `check.ts` has no dependency on the planner, only on `(scene, expectations)`.

### 8.2 Gates

| Gate | Check | Tolerance |
|---|---|---|
| **G1 valid** | 02 gate: schema (ajv strict) + all semantic rules; **zero warnings** — a W from our own output is a generator bug | hard |
| **G2 success** | `report.success` — an accepted body entered the goal | hard (waived when goal excluded, §2.1) |
| **G3 duration** | `report.durationS` (machine-stopped metric) vs target | ≤ max(`DURATION_TOL_S` 2 s, `DURATION_TOL_FRAC` 15%) |
| **G4 chains** | rebuilt forest: trees with ≥ 3 edges == `chains`; actual roots == `plan.expectedRoots` | exact |
| **G5 activation** | every stage sentinel in `firstActivationSteps`, and `objectsActivated / activatableCount` ≥ `ACTIVATION_MIN_FRAC` 0.85 | per constants |
| **G6 count** | emitted object count vs `objectCount` | ≤ `COUNT_TOL_FRAC` 20% (enforced at plan time) |

### 8.3 Verdict

All gates pass → `outcome: "satisfied"`, return scene + report. Otherwise repair (§8.5), then next candidate; when budgets exhaust, return the **best candidate** by score = 0.4·durationMiss + 0.25·chainsMiss + 0.2·activationMiss + 0.15·countMiss (normalized; G2-passing candidates always outrank G2-failing ones; G1 failures are discarded — if *all* candidates fail G1 that is `E_PROCGEN_INTERNAL`). `outcome: "closest"`, per-gate deltas in the report — the brief's "as closely as possible", made explicit.

### 8.4 Budgets (PG-6)

`CANDIDATES_MAX` 6 candidate seeds × (1 + `REPAIR_ROUNDS_MAX` 2) check runs, each capped at `SIM_FACTOR_CAP` 2 × target × 60 steps: ≈ 65 k simulated steps at default params, ≈ 650 k at the 300 s duration cap. The §12 E6 measurement (~190 k steps/s at 27 bodies, scaling roughly inversely with body count) puts default-param generation around ~1–2 s and the pathological corner inside ~15 s on a desktop — verify on low-end devices at implementation (**U17**).

### 8.5 Diagnosis → repair

Repairs are targeted (PG-2 keeps them local) and deterministic:

| Symptom | Diagnosis | Repair (in order) |
|---|---|---|
| A sentinel never activated | chain died at that stage's hand-off | widen catcher/funnel; +10% incoming speed (raise drop, upsize kick); shrink gap; re-route with an adapter |
| G3 low (too short) | not enough machine | stretch knobs in the goal lane (§6.4 order) |
| G3 high (too long) | overshoot | inverse: shorten conveyors/runs/runouts |
| G4 low | a lane's tree < 3 edges or died | fix that lane like a sentinel failure; if a root failed, re-sample the root stage |
| G4 roots mismatch | an unplanned root (something self-started) or a planned one missing | re-seat the offender (CT-1) / fix the starter |
| G5 low with sentinels OK | baton skipped mid-stage objects (flew over dominoes) | flatten trajectory: lower emit speed or raise the run |

Two rounds per candidate; unrepaired → next candidate seed (streams `cand{i+1}/…`).

---

## 9. Knob semantics

### 9.1 Difficulty (0–1)

- **Tier unlock:** stage tier t requires `difficulty ≥ TIER_UNLOCK[t]` = [0, 0.25, 0.5, 0.75]. Low difficulty = gravity classics; high adds wiring (signal stages), pulley/piston logic, fields.
- **Margins:** hand-off margin scale = `1.5 − 0.7·difficulty` (1.5× generous → 0.8× tight). The floor is whatever still passes the self-check — tighter margins spend retries, not correctness.
- **Wiring:** `triggerWire` fan-out 2 and `dominoFork` require difficulty ≥ 0.5 (their tier).

### 9.2 Chaos (0–1)

Widths, not entropy (PG-4): placement jitter uniform ± `chaos · CHAOS_JITTER_MAX_FRAC ·` local margin; size variance ± (10 + 20·chaos)% within catalog ranges; domino-run wobble amplitude ∝ chaos; selection temperature `weight^(1/(1+chaos))` (flattens the theme's preferences); skin variety (one family skin at 0 → free pick from theme pool at 1).

### 9.3 Theme

`THEMES` (`types/procgen.ts`): skin pool (⊆ editor `SKIN_NAMES`, compile-tied), stage-weight multipliers, title word pools. Themes touch **visuals and selection weights only** — never a physics value (the skin rule of 02 §5.1, extended to generation). v1 names: `workshop` (default), `candyland`, `factory`, `dominoHall`, `spaceLab`.

### 9.4 Generated metadata

- `meta.title`: `{Adj} {Noun} No. {n}` from theme pools, `title` stream, `n` = seed mod 100 — deterministic, re-rollable, human-editable after.
- `meta.description`: fixed format `Generated · {durationS}s · {chains} chain(s) · difficulty {difficulty} · seed {seed}`.
- `meta.tags`: `["procgen"]` (dialog default, user-removable — the only provenance marker; the backend neither knows nor cares, D10/ADR-0005 rule 8).
- `meta.durationHint = round(durationS)` — feeds the player timeline (04 §10.4).

---

## 10. Integration

### 10.1 Generate dialog (fills 04 §3.1's reserved button — Procedural tab; AI tab lands in M6)

- **Presets row:** Quick demo (15 s / 30 obj / difficulty 0.3), Standard (= defaults), Showcase (90 s / 150 obj / 0.7) — param bundles, nothing more.
- **Fields:** the nine knobs; seed input with 🎲 (rolls a fresh random seed — the one UI-side random act, PG-1); allowed-types as palette-grouped checkboxes (04 §3.1 groups).
- **Progress:** candidate i / N with per-candidate check ticks; cancel returns best-so-far (PG-6).
- **Result card:** gate table with ✓/✗ and deltas (`GenReport`), objects/links/duration/chains/efficiency, `outcome` banner when `closest` ("Duration 24.1 s vs 30 s requested — closest found").
- **Actions:** **Insert** — replaces the current document as **one composite undo command** (04 §9; undo restores the pre-generate scene); **Regenerate** (new seed, same knobs); **Tweak** (back to form, params kept).

### 10.2 Save path

None. A generated scene is a dirty in-memory document like any edit; autosave (04 §14), explicit save, publish, thumbnails, and validation all follow the ordinary 04/05 paths. The server cannot tell procgen output from hand work (by design — ADR-0005 rule 5).

---

## 11. Verification plan (CI — extends 03 §12's suite)

| Test | Guards |
|---|---|
| PCG32 vectors: implementation reproduces `PCG32_TEST_VECTOR` (seed 42 / stream 54, first 3 = published pcg32-demo prefix) | PG-2 reference fidelity |
| Golden scenes: params corpus (5 themes × 3 difficulties × {1,2,3} chains, fixed seeds) → committed byte hashes per (`procgenVersion`, `engineVersion`) | PG-3/PG-5 |
| Double-generate identity on every corpus entry | PG-1 |
| Gate fuzz: 200 param draws from a seeded meta-RNG → **100% G1** (any warning/error = release blocker), ≥ 90% `satisfied` (tracked, not blocking) | generator soundness |
| Calibration regression: §12 models re-measured on real SimCore within ±15% (else recalibrate constants = procgenVersion bump) | U16 |
| Library consistency: `STAGE_LIBRARY.uses` ∪ `PROCGEN_EXCLUDED_TYPES` covers the catalog (compile), port-graph closure per tier (runtime) | §2.1, §5 |
| Perf smoke: default-params generate wall time per commit (budget §8.4) | U17 |

---

## 12. Spike record (2026-07-20, Session 6)

Environment: darwin-arm64, Node 24, `@dimforge/rapier2d-deterministic-compat@0.19.3` (the D7 build), ajv 8 strict, scratchpad only (not committed — S3 precedent). Mini-expansion follows 03 §6 geometry for platform/ramp/domino/marble/sensors with catalog materials; calibration numbers are therefore *estimates to be re-measured on SimCore* (**U16**) — the self-check loop, not these constants, carries correctness.

| Experiment | Result |
|---|---|
| PCG32 (BigInt reference) | `0xa15c02b7 0x7b47f409 0xba1d3330 0x83d2f293 0xbfa4784b 0xcbed606e` — first three match the published pcg32-demo prefix ✓ |
| E1 exact seating, 60 steps | max \|v\| 9.5·10⁻⁸ m/s, max \|ω\| 2.4·10⁻⁶ rad/s — 6 orders under `V_ACT`/`W_ACT` ✓ (§7.2 claim) |
| E2 ramp exit (3 sizes) | `v / √(4gΔy/3)` = 0.950 / 0.918 / 0.905 → `K_RAMP_EXIT` 0.92 |
| E3 domino front speed | h 0.08, s/h 0.75: 0.706 m/s (85 ms/domino); sweep `K(s/h)`: 0.5→0.849, 0.6→0.830, 0.75→0.797, 0.9→0.717; √h scaling ±5% over h 0.05–0.12; **regime break at h 0.2** (K 2.31 — shoving, not toppling) → `DOMINO_RUN_MAX_H_M` 0.15 |
| E3 finding | center-spin starter (−300 °/s about center) **fails to tip** — the floor contact eats it (energy margin ~1.0×); corner-pivot-consistent kick (§6.2 formula, 350 °/s) is reliable → normative starter |
| E4 flat runout | rolling marble speed retention 100.0%/m → CT-8 |
| E5 determinism | double-run FNV hash identical ✓ |
| E6 headless perf | ~190–240 k steps/s at 27 bodies → §8.4 budget math |
| End-to-end | params {6 s, 46 obj, 1 chain, seed 421337} → plan (rampRoll → runout → 40-domino run → goalCatch) → 44 objects, 2 387 bytes, **G1 strict pass**, sim: success, goal at 5.72 s vs 6.00 s target (−4.7%), 40/40 dominoes, all sentinels, byte-identical regenerate ✓ |

The end-to-end run is the architecture's existence proof: plan-from-models landed within 5% of the requested duration on the first candidate, before any repair.

---

## 13. Decisions and question status

**Decided here — D13:** generator architecture: stage-grammar over baton hand-offs; serpentine gravity-frame layout with exact seating; verify-by-simulation self-check (headless SimCore in the procgen worker, shared with M6) gated G1–G6 with targeted repair and closest-candidate fallback; fully client-side, saved as ordinary documents; deterministic under PG-1…PG-6 (labeled PCG32 streams, canonical writer, procgenVersion-scoped byte reproducibility, chaos = width). Plus the v1 stage library (18 stages, gear excluded pending U10) and the calibrated estimate models.

**D14** (recorded in 00-PROGRESS; details 03 §15): sensor-entry attribution rule + `ActivationCause` `sensor` variant — prerequisite for G4.

**Opened:**
- **U16** — §12 constants calibrated on a mini-expansion, one platform; recalibrate on real SimCore across the full library (lever launch angles, spring ballistics, fan drift, conveyor hand-offs) at first implementation; drift > 15% bumps procgenVersion (§11).
- **U17** — generation wall-time budget on low-end devices (worst-case ~650 k steps); measure at implementation, revisit budget constants or add a "fast preview" preset in M8.

**Unchanged:** U10 (motor model — blocks gear stages, pistons carry the risk noted in §5), U2/U5/U9/U12–U15 as tracked in 00-PROGRESS.
