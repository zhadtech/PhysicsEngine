# ADR-0003: Frontend Stack — TypeScript, React, Three.js, Worker-Isolated Simulation

- **Status:** Accepted
- **Date:** 2026-07-19 (Session 1)

## Context

The client is the product: builder, simulation player, and gallery all run in the browser. Needs: a 3D renderer (ADR-0001), a responsive tool-like UI, heavy compute isolated from the UI thread, and a codebase sharable with the backend (validation, types).

## Decision

| Layer | Choice |
|-------|--------|
| Language | TypeScript (strict) everywhere |
| UI framework | React (DOM UI only: toolbars, panels, gallery, dialogs) |
| Renderer | Three.js, driven imperatively (no react-three-fiber for the sim canvas) |
| Graphics API | WebGL2 baseline; WebGPU as a later opt-in flag |
| State | Zustand (scene store = editing source of truth) |
| Simulation host | Dedicated Web Worker running the Rapier2D WASM; `SharedArrayBuffer` transport when cross-origin isolated, double-buffered transferable `ArrayBuffer` fallback |
| Build tooling | Vite, pnpm workspaces, Turborepo |
| Testing | Vitest (unit; includes determinism replay tests), Playwright (e2e) |

## Rationale

- **React for DOM, imperative Three.js for the canvas:** the builder UI is classic panel/tool UI where React excels. The render loop, with thousands of instanced meshes updated from a shared buffer at display rate, wants a hand-tuned loop — react-three-fiber's reconciliation adds overhead and indirection exactly where we need control. The boundary is one component owning the canvas.
- **Zustand:** minimal, unopinionated, no boilerplate; store-outside-React fits the "worker writes / UI reads" pattern.
- **Worker isolation:** simulation stalls must never freeze tools; also gives determinism a clean, single-threaded home with a controlled step loop.
- **TypeScript everywhere:** the `scene-format` package (types + validation + migrations) is imported by client *and* server (ADR-0004) — one definition of "valid scene."

## Consequences

- Cross-origin isolation headers (COOP/COEP) needed for `SharedArrayBuffer`; fallback path is mandatory code, not an afterthought (Risk R5 — embed pages).
- One rendering discipline to document in M8: per-object-type `InstancedMesh`, transforms streamed from the worker buffer, interpolation between the last two physics states.
- Recharts/etc. can be used for analytics panels without new decisions (plain React land).

## Alternatives considered

- **react-three-fiber for everything:** great DX, but reconciler overhead and less predictable frame cost at our object counts; harder to reason about the interpolation loop.
- **PixiJS / flat canvas:** excluded by ADR-0001 (needs 3D look).
- **Svelte/Solid:** fine frameworks, but React's ecosystem (component libs, hiring, AI familiarity) wins for a long-multi-session project with no counterweighing need.
- **Physics on main thread:** simpler transport, but any heavy scene janks the entire UI — unacceptable for a tool.
