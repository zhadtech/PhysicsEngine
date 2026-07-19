# ADR-0001: 2.5D Hybrid — 2D Physics, 3D Rendering

- **Status:** Accepted
- **Date:** 2026-07-19 (Session 1)
- **Decider:** Project owner (Zhad), option chosen explicitly

## Context

The platform simulates chain-reaction machines (dominoes, marbles, gears, levers, springs, pendulums, pistons, conveyors, fans, magnets, rope/pulleys). Dimensionality is the single most consequential decision: it drives the physics engine, renderer, builder UX, determinism difficulty, performance ceiling, procgen, and AI generation.

## Decision

**2.5D hybrid:** physics is simulated strictly in 2D (one X/Y plane, Rapier2D), while rendering is full 3D (Three.js). Objects get visual depth (extrusion or 3D meshes) that never affects simulation. The camera is a tilted 3D perspective ("workshop table" look); builder input raycasts onto the physics plane so editing behaves like a 2D tool.

The brief's *plane angle* generation parameter maps to the 2D gravity vector (direction/magnitude), with a matching cosmetic camera/board tilt.

## Consequences

**Positive**

- All object types in the brief work naturally in 2D (this is the classic *The Incredible Machine* genre).
- Determinism is far easier: fewer degrees of freedom, cheaper solver, smaller state.
- Thousands of objects are realistic on mid-range hardware.
- Builder UX stays simple (no 3D camera wrestling, no 3D snapping/gizmo complexity).
- Procgen and AI generation produce 2D layouts — a dramatically smaller search space, much higher success rate.
- Still *looks* modern and dimensional, unlike a flat 2D canvas.

**Negative / accepted costs**

- No true 3D contraptions (no marble runs that cross over themselves in depth). If ever needed, "layers" (multiple parallel planes with defined transfer points) is the escape hatch — noted as a possible post-production feature, not designed now.
- Rendering is more expensive than flat 2D (mitigated by instancing; see M8).
- Some visual/physical mismatch is inherent (a sphere rendered in 3D collides as a 2D circle). Art direction must keep depth shallow so this never looks wrong.

## Alternatives considered

- **Pure 2D (flat canvas):** cheapest and fastest to ship, but visually dated for a community platform whose appeal is "satisfying to watch and share."
- **Full 3D:** most impressive (Besiege, Marble World), but builder UX, determinism, performance with thousands of bodies, procgen, and AI generation all become drastically harder. Wrong risk profile for a browser-first MVP.
