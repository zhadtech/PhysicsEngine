# ADR-0002: Physics Engine — Rapier2D (Rust → WASM)

- **Status:** Accepted
- **Date:** 2026-07-19 (Session 1)

## Context

Requirements from the brief: client-side only, deterministic given scene + seed, fast enough for thousands of bodies, rich joint/motor support (gears, levers, pistons, pulleys), and a WASM-friendly footprint. ADR-0001 fixed the simulation to 2D.

## Decision

Use **Rapier2D** (dimforge, Rust compiled to WebAssembly) as the physics engine, in a build with the **`enhanced-determinism`** feature enabled (strict IEEE 754 semantics for cross-platform determinism).

Wrap it behind our own `engine` package interface so the rest of the codebase never touches Rapier types directly (keeps a future engine swap or version upgrade contained).

## Rationale

- **Performance:** Rust→WASM with SIMD-capable builds; comfortably handles thousands of 2D bodies — the strongest browser-available option.
- **Determinism:** `enhanced-determinism` is an explicit, supported feature targeting bit-identical results across platforms — exactly our leaderboard/replay requirement. No mainstream JS engine offers this credibly.
- **Feature coverage:** revolute/prismatic joints with motors and limits (levers, gears via motorized revolute + our gear-ratio constraint layer, pistons), springs (spring-damper joints), sensors (triggers), CCD (fast marbles vs thin ramps), and **full world snapshot/restore** — which gives us Reset for free and enables future server-side replay verification (Risk R2).
- **Maintenance:** actively developed, permissive license (Apache-2.0), widely used.

## Consequences

- We must produce and pin a **custom WASM build** (the standard npm package likely doesn't enable `enhanced-determinism`). This adds a Rust toolchain step to CI. → Spike scheduled at the start of M2 (carried as U1/R1).
- Non-native concepts — **fans (force fields), magnets (attraction fields), conveyors (surface velocity), rope/pulleys** — are implemented in our own layer on top of Rapier (custom forces applied in fixed order each step; rope as segmented bodies or distance-joint compositions). Designed in M2, cataloged in M1.
- `engineVersion` (our wrapper + pinned Rapier build) is recorded in every scene; determinism is only guaranteed within one engineVersion. Leaderboards are keyed accordingly (ADR-0005).
- f32 numerics (Rapier default). Scene coordinates use meters with a documented world scale to stay in f32's sweet spot.

## Alternatives considered

- **Box2D (box2d-wasm):** mature and capable, but the WASM packaging story is weaker, no supported cross-platform determinism story, slower pace of maintenance.
- **Planck.js (Box2D port in pure JS):** JS-level determinism is attractive, but performance ceiling is far too low for "thousands of objects."
- **Matter.js:** easy but neither deterministic nor accurate enough (solver quality) for chain-reaction fidelity.
- **Custom engine:** total control over determinism, but months of work and a permanent correctness burden — unjustifiable given Rapier exists.
