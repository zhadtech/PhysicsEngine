# 02 — Scene Format Specification (v1)

**Status:** Accepted (Session 2, 2026-07-19) — normative for schemaVersion 1
**Implements:** ADR-0005 (scene format principles)
**Companion files:** `packages/scene-format/scene.schema.json` (normative JSON Schema), `packages/scene-format/src/scene.ts` (TypeScript interfaces) — both moved into the package at P1; `tools/verify-scene.mjs` part T holds this document, the schema and the types to one catalog.
**Consumed by:** M2 (simulation core), M3 (builder), M4 (backend validation), M5 (procgen), M6 (AI generation)

---

## 1. Overview

A scene is one JSON document that describes the *inputs* of a simulation: world settings, objects, and the links between them. It never stores simulation results (ADR-0005). Every producer — human builder, procgen, AI, API upload — must pass the same validation gate:

1. **Schema validation** against `scene.schema.json` (structure, types, ranges).
2. **Semantic validation** (rules the schema cannot express — section 8).

Top-level shape:

```json
{
  "schemaVersion": 1,
  "engineVersion": "0.1.0",
  "meta":    { "title": "Marble spiral" },
  "world":   { "gravity": 9.81, "planeAngle": 0, "seed": 421337 },
  "objects": [ ... ],
  "links":   [ ... ]
}
```

`schemaVersion`, `engineVersion`, `world`, and `objects` are required. `meta` and `links` are optional (`links` defaults to empty).

**Design note (diverges from the ADR-0005 sketch):** the sketch showed gravity as a vector `[0, -9.81]` *and* a `planeAngle`. That is two sources of truth for one thing. v1 stores gravity as a scalar magnitude plus `planeAngle`; the engine computes the vector as `rotate((0, -gravity), planeAngle)`. One knob, no conflict.

---

## 2. Conventions

| Concern | Rule |
|---|---|
| Units | SI. Length in meters, mass-related values in kg-based units, time in seconds, force in newtons. |
| Angles | **Degrees in the file** (readable for humans and AI). Counter-clockwise positive. Engine converts to radians once at load. Angular speeds in deg/s. |
| Coordinates | X right, Y up. Origin at the center of the board. Physics is on this single X/Y plane (ADR-0001). |
| Scale | Desk scale ("workshop table"): default domino is 8 cm tall, default marble radius 2.5 cm, default board 4 × 2.4 m. Defaults are just defaults; bounds may grow to 200 m for big machines. |
| Rotation `rot` | Rotation of the object around its own reference point (defined per type in the catalog), in degrees. |
| 2D density | `density` is mass per **area** (kg/m²), because physics is 2D. Catalog defaults are tuned so relative masses feel right (marble ≈ 5 g, domino ≈ 8 g). A global tuning pass happens in M2. |
| Number precision | Writers emit at most **4 fractional digits** on every number (positions: 0.1 mm; angles: within 0.0001°). Readers accept any precision (tolerant reader). Quantization is a writer rule, *not* schema-enforced, because `multipleOf` on decimals is unreliable in floating point. |
| Defaults | Defaults are defined by this spec and the schema, and are **omitted from files** (strict writer). A value equal to the default should not be written. |
| Unknown fields | Readers preserve unknown fields where safe and ignore them for simulation; writers never emit fields outside this spec (ADR-0005 rule 6). |

### 2.1 IDs

- Pattern: `^[A-Za-z0-9_-]{1,24}$`.
- **One namespace** for objects and links together: no id may repeat anywhere in the document. (Keeps `trigger.targets` and link references unambiguous.)
- IDs are opaque; no meaning is derived from their text.
- **Determinism rule:** the engine inserts bodies into the physics world sorted by id (lexicographic byte order). Editors may generate ids however they like (`o1`, `dom_017`, nanoid) — sorting makes insertion order stable regardless.

---

## 3. `meta` — descriptive metadata

All optional. Identity and lineage (author, scene id, remix source, likes…) live in the backend, never in the document (ADR-0005 rule 8).

| Field | Type | Default | Notes |
|---|---|---|---|
| `title` | string 1–80 | `"Untitled"` | |
| `description` | string ≤ 500 | — | |
| `tags` | string[] ≤ 10, each 1–24 | `[]` | lowercase recommended |
| `durationHint` | number 1–600 (s) | — | Target run length. Used by procgen/AI as a goal and by the player UI as a timeline hint. Not a hard stop; the engine hard cap is defined in M2. |

---

## 4. `world` — global settings

| Field | Type | Default | Range | Notes |
|---|---|---|---|---|
| `gravity` | number | `9.81` | 0–100 | Magnitude, m/s². |
| `planeAngle` | number | `0` | −180–180 | Degrees. Rotates the gravity vector; renderer tilts the board to match (visual only). |
| `seed` | integer | `1` | 0–4294967295 | Feeds the worker's single PCG32 PRNG. Physics itself uses no randomness; the seed exists for procgen reproducibility and any future random elements. |
| `bounds` | `[w, h]` | `[4, 2.4]` | each 0.5–200 | Play area, centered on origin. Bodies leaving a margin around bounds are deactivated ("fell off the table") — exact margin and behavior defined in M2. |

---

## 5. Objects

### 5.1 Common shape

```json
{ "id": "o1", "type": "domino", "pos": [0.35, 0.04], "rot": 0, "skin": "wood", "props": { } }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | id | yes | Section 2.1. |
| `type` | string | yes | One of the 18 catalog types. |
| `pos` | `[x, y]` | yes | Position of the type's reference point, meters. |
| `rot` | number | no (default 0) | Degrees, CCW. |
| `skin` | string 1–32 | no | Visual preset name (`"wood"`, `"steel"`, `"neon"`, …). **Rendering only — never affects simulation.** Unknown skins fall back to the type default. Skin catalog is an M3/M8 concern. |
| `props` | object | no | Type-specific properties, listed per type below. Omitted props take catalog defaults. |

### 5.2 Common `props` for dynamic objects

These apply to every object whose body is dynamic (marked **[dyn]** in the catalog):

| Prop | Type | Default | Range | Notes |
|---|---|---|---|---|
| `density` | number | per type | 0.1–100 | kg/m² (2D). |
| `friction` | number | per type | 0–2 | Coulomb friction coefficient. |
| `restitution` | number | per type | 0–1 | Bounciness. |
| `magnetic` | boolean | `false` | | Only magnetic bodies feel magnets. |
| `anchored` | boolean | `false` | | `true` freezes the body in place (becomes static). Lets any part double as scenery. |
| `vel` | `[vx, vy]` | `[0, 0]` | each −50–50 | Initial linear velocity, m/s. An *input*, allowed by ADR-0005. |
| `angVel` | number | `0` | −3600–3600 | Initial angular velocity, deg/s. |

Static objects (**[static]**) expose only `friction` and `restitution` from this table.

### 5.3 Object catalog (18 types)

Physics realizations name the Rapier building blocks; the exact force formulas, joint parameters, and event semantics are the M2 spec's job. "Activation" = the moment an object first moves or fires, used by analytics (M2).

**Structural (static)**

| Type | Purpose | Reference point / `rot` | Props (beyond 5.2) |
|---|---|---|---|
| `platform` | Floors, walls, shelves. Static box. | Center; `rot` tilts it. | `w` (def 1, 0.02–200), `h` (def 0.05, 0.02–200) |
| `ramp` | Right-triangle wedge for rolling/sliding. | Center of bounding box; slope descends left→right by default. | `w` (def 0.5, 0.05–10), `h` (def 0.3, 0.05–10), `flip` (bool, def false — mirrors horizontally) |
| `curve` | Quarter-pipe arc channel (marble runs). Static arc collider. | Arc center. | `r` (def 0.4, 0.05–5), `thickness` (def 0.03, 0.01–0.2), `sweep` (def 90°, 15–180), `flip` (bool, def false) |

**Simple dynamic bodies [dyn]**

| Type | Purpose | Reference point / `rot` | Props (beyond 5.2) |
|---|---|---|---|
| `domino` | The classic. Dynamic box, proportions fixed: width = h/5 (visual depth = h/2.6). | Center of base edge (sits on floors naturally). | `h` (def 0.08, 0.02–1). Defaults: density 6, friction 0.5, restitution 0.05 |
| `marble` | Dynamic ball. | Center. | `r` (def 0.025, 0.005–0.5). Defaults: density 2.5, friction 0.3, restitution 0.3 |
| `crate` | Generic dynamic box. | Center. | `w` (def 0.08, 0.02–2), `h` (def 0.08, 0.02–2). Defaults: density 4, friction 0.5, restitution 0.1 |
| `plank` | Long thin dynamic box (bridges, seesaw arms, falling beams). | Center. | `w` (def 0.4, 0.05–4), `h` (def 0.02, 0.005–0.2). Defaults: density 5, friction 0.5, restitution 0.1 |

**Mechanisms (compound prefabs — one catalog entry expands to bodies + joints inside the engine)**

| Type | Purpose | Realization sketch (detail: M2) | Reference point / `rot` | Props (beyond 5.2) |
|---|---|---|---|---|
| `gear` [dyn] | Rotating disc, optionally motorized. Pinned to the background at its center. | Dynamic disc + revolute joint to world; optional motor. Tooth geometry is visual in v1 — gear coupling uses `gearMesh` links. | Center; `rot` sets tooth phase (visual). | `r` (def 0.1, 0.02–1), `motorSpeed` (def 0 = free-spinning, −3600–3600 deg/s), `maxTorque` (def 0.5 N·m, 0–100). Defaults: density 6, friction 0.6, restitution 0.05 |
| `lever` [dyn] | Plank on a fulcrum (seesaw = pivot 0.5). | Plank body + revolute joint to world at the pivot point. | Pivot point; `rot` = arm angle. | `len` (def 0.4, 0.05–4), `h` (def 0.02), `pivot` (def 0.5, 0–1, fraction from left end), `minAngle`/`maxAngle` (deg, optional rotation limits). Defaults: density 5, friction 0.5, restitution 0.1 |
| `spring` [dyn] | Compressible launcher pad (springboard/kicker). | Static base + plate on a prismatic joint with spring stiffness and damping. | Base center; `rot` = launch direction (0 = up). | `w` (def 0.1, 0.02–1), `travel` (def 0.08, 0.01–0.5), `stiffness` (def 25 N/m, 1–5000), `damping` (def 0.5, 0–100), `mode`: `"passive"` (def — compresses on impact and bounces back) or `"triggered"` (starts compressed and latched; releases when activated) |
| `pendulum` [dyn] | Anchor + arm + bob. | Revolute joint at anchor; arm either rigid rod (fixed link) or rope (max-distance). | Anchor point; `rot` = arm displacement from straight down. | `len` (def 0.3, 0.05–5), `bobR` (def 0.04, 0.01–0.5), `arm`: `"rod"` (def) or `"rope"`. Bob defaults: density 6, friction 0.4, restitution 0.2 |
| `piston` [dyn] | Motorized pusher that extends and retracts. | Static base + head on a motorized prismatic joint. | Base center; `rot` = push direction (0 = up). | `stroke` (def 0.15, 0.02–2), `w` (def 0.06, 0.02–0.5), `speed` (def 0.2 m/s, 0.01–5), `force` (def 5 N, 0.1–500), `mode`: `"cycle"` (def, auto loop), or `"triggered"` (starts retracted; extends once when activated and stays), `period` (def 2 s, 0.2–60, cycle mode), `phase` (def 0, 0–1, cycle offset) |
| `conveyor` [static] | Belt surface that drags whatever rests on it. | Static box whose contacts get a surface velocity (Rapier contact modification — M2). | Center; `rot` tilts it. | `w` (def 0.5, 0.05–10), `h` (def 0.05, 0.02–0.5), `speed` (def 0.3 m/s, −5–5, sign = direction), `active` (bool, def true) |
| `pulley` [static] | Free-spinning wheel that `rope` links can route through. | Static anchor + visual wheel; the ideal-rope constraint through it is a custom constraint (M2 — see U6). | Wheel center. | `r` (def 0.06, 0.02–0.5) |

**Fields (static emitters — apply forces at a distance, no contact)**

| Type | Purpose | Force model sketch (formulas: M2) | Reference point / `rot` | Props |
|---|---|---|---|---|
| `fan` | Directional push (air stream). | Cone-shaped field along `rot` direction; strength falls linearly to 0 at `range`. Affects dynamic bodies in the cone. | Fan center; `rot` = blow direction (0 = right). | `strength` (def 0.4 N, 0.1–100), `range` (def 0.5, 0.05–10), `spread` (def 25°, 5–90 cone half-angle), `active` (bool, def true) |
| `magnet` | Radial pull/push on `magnetic` bodies only. | Inverse-square falloff, clamped near the magnet, cut at `range`. | Magnet center. | `strength` (def 3, −100–100; newtons at the 5 cm reference distance, 03 §7.2; positive attracts, negative repels), `range` (def 0.4, 0.05–10), `active` (bool, def true) |

**Logic (static sensor zones — no collision response)**

| Type | Purpose | Behavior | Props |
|---|---|---|---|
| `trigger` | Fires when a dynamic body enters; activates targets. | Sends one "activate" signal to each id in `targets` (effects table in 5.4). | `w` (def 0.1, 0.02–5), `h` (def 0.1, 0.02–5), `targets` (id[] ≤ 32, def `[]`), `once` (bool, def true — fire only on first entry) |
| `goal` | Defines success for analytics. | Scene counts as **success** when an accepted body enters any goal (metric detail: M2). | `w` (def 0.1), `h` (def 0.1), `accepts`: `"any"` (def) or id[] ≤ 32 |

### 5.4 Trigger activation effects

| Target type | Effect of one "activate" signal |
|---|---|
| `fan`, `magnet`, `conveyor` | Toggle `active`. |
| `piston` (mode `triggered`) | Extend (and stay extended). |
| `spring` (mode `triggered`) | Release the latch (fires once). |
| `gear` | Toggle motor: `motorSpeed` ↔ 0. |
| anything else | No effect — semantic validation **warns** (not an error, so remixes don't break when a target is swapped). |

All signal processing happens inside the worker at fixed steps, so it is deterministic.

---

## 6. Links

Links connect two objects. They live in the top-level `links` array.

### 6.1 Common shape

```json
{ "id": "l1", "type": "rope", "a": { "obj": "crateA", "anchor": "top" }, "b": { "obj": "lev1", "anchor": "endB" }, "props": { } }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | id | yes | Same namespace as objects. |
| `type` | string | yes | One of 5 link types. |
| `a`, `b` | endpoint | yes | `{ "obj": id }` plus either `"anchor": name` (named point, section 6.3) or `"at": [x, y]` (offset in the object's local frame, meters). Neither given = `"center"`. |
| `props` | object | no | Per type, below. |

### 6.2 Link catalog

| Type | Purpose | Realization sketch (M2) | Props |
|---|---|---|---|
| `rope` | Flexible connection; can route over pulleys. | `segments: 0` (def) = ideal rope (max-distance constraint, no collision, cheap). `segments` 2–64 = chain of capsule bodies + joints (collidable, heavier). Routing through `via` pulleys uses the ideal model regardless (constant-total-length constraint — custom, see U6). | `length` (optional; default = distance between endpoints at load — deterministic since the initial layout is fixed), `segments` (def 0), `via` (pulley id[], ≤ 4, def `[]`, ordered from `a` to `b`) |
| `springLink` | Coil spring between two bodies. | Spring-damper constraint. | `stiffness` (def 50 N/m, 1–5000), `damping` (def 0.5, 0–100), `restLength` (optional; default = initial distance) |
| `weld` | Rigid attachment — compose modular structures from parts. | Fixed joint. | — |
| `axle` | Free or motorized hinge between two *dynamic* bodies (wheels on a chassis, articulated arms). | Revolute joint between bodies (not to the world — that's what `gear`/`lever` prefabs are for). | `motorSpeed` (def 0 deg/s, −3600–3600), `maxTorque` (def 0.5 N·m, 0–100) |
| `gearMesh` | Couples two `gear` objects' rotation. | Ratio constraint (no tooth collision in v1). Default ratio = −rA/rB (meshed gears counter-rotate). A **positive** ratio models a belt/chain drive (visual belt: later). | `ratio` (optional; default derived from radii) |

### 6.3 Named anchors

Available names per type (all types also accept `"center"` and `at` local coordinates):

| Type family | Anchors |
|---|---|
| Boxes (`platform`, `ramp`*, `crate`, `plank`, `conveyor`, `trigger`, `goal`, `domino`) | `top`, `bottom`, `left`, `right` (edge midpoints) |
| `marble`, `gear`, `pulley`, `magnet`, `fan` | `center` only |
| `lever` | `endA` (left end), `endB` (right end), `pivot` |
| `pendulum` | `pivot`, `bob` |
| `piston` | `base`, `head` |
| `spring` | `base`, `plate` |
| `curve` | `endA`, `endB` (arc endpoints) |

*`ramp` anchors are the bounding-box edge midpoints.

Anchors are resolved against the object's **current props** (e.g., `lever.endB` moves if `len` changes), which keeps links stable when objects are resized in the builder.

---

## 7. Size limits

| Limit | Value | Why |
|---|---|---|
| Objects | ≤ 5000 | Perf promise "thousands of objects" (R4); procgen ceiling. |
| Links | ≤ 1000 | |
| Raw JSON size | ≤ 1 MB | Matches backend cap (R6); ~5k objects fits with compact encoding. |
| `trigger.targets`, `goal.accepts` lists | ≤ 32 each | |
| Rope `via` list | ≤ 4 | |

---

## 8. Semantic validation (beyond the schema)

The `scene-format` package enforces these after schema validation. **E** = error (reject), **W** = warning (accept, surface in builder).

1. **E** Every `id` (objects + links) unique in one namespace; matches the id pattern.
2. **E** Every reference resolves: link `a.obj`/`b.obj`, `rope.via[]`, `trigger.targets[]`, `goal.accepts[]` (when a list) must name existing objects.
3. **E** `gearMesh` endpoints must both be `gear` objects; `rope.via` entries must be `pulley` objects; `axle` endpoints must both be dynamic-bodied types (not `platform`/`ramp`/`curve`/`conveyor`/`fan`/`magnet`/`trigger`/`goal`/`pulley`).
4. **E** A link may not connect an object to itself (`a.obj ≠ b.obj`).
5. **E** Named anchors must exist for the endpoint's type (table 6.3).
6. **E** All numbers finite (no NaN/Infinity — JSON forbids them, but re-check after any non-JSON ingestion path, e.g. AI repair).
7. **E** `lever.minAngle < maxAngle` when both present.
8. **E** Limits of section 7.
9. **W** `trigger.targets` entries whose type has no activation effect (table 5.4).
10. **W** Objects whose `pos` lies outside `world.bounds` plus margin.
11. **W** Duplicate `gearMesh` between the same pair; a `rope` with `length` shorter than the initial endpoint distance (starts taut/violated).
12. **W** Writer-side only: numbers exceeding 4 fractional digits (readers accept them; the builder's save path re-quantizes).

---

## 9. Versioning & migrations

Rules fixed by ADR-0005; made concrete here.

- `schemaVersion` is an integer; v1 is this document. `engineVersion` is the semver of the deterministic engine build the scene was authored against; determinism and leaderboards are scoped to it (ADR-0005 rule 4).
- **What requires a version bump:** any change that can alter simulation results or that an older reader cannot safely ignore — new object/link type, new prop with a non-neutral default, changed default, changed unit or range, removed field. **No bump needed:** purely visual additions (new `skin` values), doc clarifications.
- Migrations are pure functions `migrate_v{n}_to_v{n+1}(scene) → scene` in `scene-format`, applied in sequence on load until current. Forward-only; old scenes never break; there are no backward migrations.
- A reader given `schemaVersion` **newer** than it understands must refuse cleanly ("made with a newer version"), never guess.
- Unknown object `type` at the *current* version = validation error (a scene can't be simulated with missing pieces).
- CI keeps a corpus of historical scenes (one per version, plus the examples in this doc) and runs migration + full validation on every change (ADR-0005 consequence).

---

## 10. Examples

### 10.1 Minimal chain: marble → ramp → dominoes → goal

```json
{
  "schemaVersion": 1,
  "engineVersion": "0.1.0",
  "meta": { "title": "First chain", "tags": ["tutorial"], "durationHint": 10 },
  "world": { "seed": 42 },
  "objects": [
    { "id": "floor", "type": "platform", "pos": [0, -0.025], "props": { "w": 3 } },
    { "id": "rmp", "type": "ramp", "pos": [-1.1, 0.15], "props": { "w": 0.6, "h": 0.3 } },
    { "id": "m1", "type": "marble", "pos": [-1.35, 0.34] },
    { "id": "d1", "type": "domino", "pos": [-0.6, 0] },
    { "id": "d2", "type": "domino", "pos": [-0.54, 0] },
    { "id": "d3", "type": "domino", "pos": [-0.48, 0] },
    { "id": "d4", "type": "domino", "pos": [-0.42, 0] },
    { "id": "g1", "type": "goal", "pos": [-0.2, 0.05], "props": { "accepts": ["d4"] } }
  ]
}
```

Defaults do the rest: gravity 9.81, board 4 × 2.4 m, marble r 2.5 cm, dominoes 8 cm tall at 6 cm spacing.

### 10.2 Mechanism showcase: motor-driven gears, lever, pulley lift, fan, trigger → piston

```json
{
  "schemaVersion": 1,
  "engineVersion": "0.1.0",
  "meta": { "title": "Mechanism showcase", "durationHint": 30 },
  "world": { "seed": 7, "bounds": [6, 3] },
  "objects": [
    { "id": "floor", "type": "platform", "pos": [0, -0.025], "props": { "w": 6 } },
    { "id": "gearA", "type": "gear", "pos": [-2, 0.6], "props": { "r": 0.15, "motorSpeed": 90 } },
    { "id": "gearB", "type": "gear", "pos": [-1.75, 0.6], "props": { "r": 0.1 } },
    { "id": "lev", "type": "lever", "pos": [-1, 0.3], "props": { "len": 0.6, "pivot": 0.4 } },
    { "id": "pul", "type": "pulley", "pos": [0.5, 1.2] },
    { "id": "box", "type": "crate", "pos": [0.5, 0.04], "props": { "magnetic": true } },
    { "id": "mag", "type": "magnet", "pos": [1.6, 0.5], "props": { "strength": -4, "active": false } },
    { "id": "fan1", "type": "fan", "pos": [-0.2, 0.1], "rot": 45, "props": { "strength": 3, "range": 1 } },
    { "id": "tr1", "type": "trigger", "pos": [1.2, 0.05], "props": { "targets": ["pis", "mag"] } },
    { "id": "pis", "type": "piston", "pos": [2.2, 0.03], "rot": -90, "props": { "mode": "triggered", "stroke": 0.3 } },
    { "id": "g1", "type": "goal", "pos": [2.8, 0.1], "props": { "accepts": ["box"] } }
  ],
  "links": [
    { "id": "mesh1", "type": "gearMesh", "a": { "obj": "gearA" }, "b": { "obj": "gearB" } },
    { "id": "r1", "type": "rope", "a": { "obj": "lev", "anchor": "endB" }, "b": { "obj": "box", "anchor": "top" }, "props": { "via": ["pul"] } }
  ]
}
```

---

## 11. Decisions made in this milestone (with rationale)

1. **Prefab-style catalog, not raw bodies+joints.** Users, procgen, and AI all think in "gear", "lever", "pendulum" — not in revolute joints. Each catalog type expands to bodies+joints inside the engine. Raw composition is still possible via `weld`/`axle`/`springLink` links. Keeps files small, the builder simple, and the AI output space well-shaped.
2. **Links as a separate top-level array** rather than nested inside objects: connections are between equals, and one object can have many links; nesting would force an owner.
3. **Explicit `gearMesh` instead of proximity magic.** Gears couple only when a link says so — deterministic, remix-safe, and the builder can still auto-create the link on snap (M3).
4. **Pulleys = wheel object + `via` on ropes.** One rope with waypoints reads naturally and matches how people build; the constant-length constraint is a contained M2 problem (U6).
5. **Degrees in the file.** Humans and LLMs handle degrees far better than radians; conversion at load is a single deterministic multiply.
6. **Scalar gravity + planeAngle** (see Design note, section 1).
7. **`trigger`/`goal` sensors included in v1.** The brief's analytics need success/failure, and pistons/springs need a "when" — a data-only trigger system (no scripts, ADR-0005 rule 7) covers both.
8. **Initial velocities allowed.** They are inputs, not results; procgen and AI need them ("marble launched at…").
9. **Deferred, recorded as future candidates (need their own ADR if added):** emitter/spawner objects, balloons/buoyancy, tooth-collision gears, decorative text objects, per-object visual z-offsets.

---

## 12. Open questions raised here (carried in 00-PROGRESS.md)

- **U6** Ideal rope-over-pulley (constant total length through `via` points) is not a native Rapier constraint — custom constraint design in M2. *(Resolved in M2: 03 §8.2.)*
- **U7** Density/force default values are provisional; M2 does a feel/tuning pass with real simulation (may change defaults → schemaVersion 2 with migration). *(M2 did the analytic pass — see Changelog below; empirical confirmation at first implementation.)*
- **U8** Belt/chain drives are representable (`gearMesh` positive ratio) but have no visual; decide belt rendering in M3/M8. *(Resolved in M3: D9, 04 §12.1.)*

---

## 13. Changelog

- **2026-07-19 (Session 3, M2 tuning pass — D8):** pre-release amendment of v1 defaults after the analytic tuning pass (03 §13): `spring.stiffness` default 80 → **25** N/m; `fan.strength` default 2 → **0.4** N; `magnet.strength` unit anchored as newtons at the 5 cm reference distance (03 §7.2 formula; value unchanged). Ranges, schema, and everything else unchanged. schemaVersion stays 1 — the format is unreleased and no scenes exist outside this repository; after release the same change would have required schemaVersion 2 + migration (§9).
