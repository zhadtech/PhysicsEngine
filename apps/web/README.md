# @physics/web

React builder (place/move/rotate/link, snap, anchors), Three.js InstancedMesh renderer, play-mode UI over the 03 §5 worker protocol, analytics panel, IndexedDB local drafts.

- **Contract:** `docs/04-BUILDER-UX.md` — the normative spec this package implements.
- **Roadmap phase:** **P3** (`docs/12-ROADMAP.md` §3), in four slices.

## Status — P3a landed: the headless editor core

Everything in 04 that is a *rule* rather than a pixel, written framework-free so
it is held to the spec by `node:test` rather than by looking at it:

| Module | Spec |
|---|---|
| `editor/model.ts` | the 04 companion table — constants, inspector descriptors, palette, keymap, command union (moved from `types/editor.ts`, now a stub) |
| `editor/document.ts`, `editor/commands.ts`, `editor/store.ts` | §9 command pattern with exact inverses, the 200-command ring, the save pointer, test-mode rejection |
| `editor/ids.ts` | §5.2 `<prefix><n>`, smallest unused positive integer, one namespace (02 §2.1) |
| `editor/refs.ts`, `editor/edits.ts` | §5.5 delete cascade, duplicate, copy/paste, rename — what makes 02 §8's *errors* unreachable from the UI |
| `editor/shapes.ts`, `editor/snap.ts`, `editor/place.ts` | §6's snapping ladder, the §5.2 surface seat, §6.4's gear snap and auto-`gearMesh`, the domino run |
| `editor/write.ts`, `editor/gate.ts` | the 02 §2 strict writer and §10.1's serialize→validate round trip into Test |
| `editor/budgets.ts`, `editor/drafts.ts` | §14's live limits and the autosave ring |

## Status — P3b landed: the renderer

The same treatment applied to the picture: everything the renderer *decides* is
plain data, computed and tested without a GPU, and the Three.js binding only
uploads it.

| Module | Spec |
|---|---|
| `render/perf.ts` | the render half of 09 — frame budget, device tiers, `RENDER_CLASS`, the draw ceilings (moved from `types/perf.ts`, now a partial stub) |
| `render/classify.ts` | 09 §4's instanced/generated/overlay partition, the (type, skin) groups and the meshes under them, draw-call accounting, registry binding |
| `render/camera.ts` | 04 §4's workshop-table rig — three degrees of freedom, the tilt clamp, zoom-to-cursor, framing, the `planeAngle` roll and gravity compass |
| `render/grid.ts` | the grid whose pitch *is* the snap step, the table edge, the W10 out-of-bounds test, unit formatting |
| `render/generated.ts` | 04 §12's belts (D9's four cases), rope sag and pulley routing, ribbons |
| `render/frame.ts` | 03 §5.5 interpolation applied to the plan: sleep dim, `Removed`, distance LOD |
| `render/quality.ts` | 09 §7.2's adaptive loop — a render envelope and nothing that can reach the worker |
| `render/three.ts` | the binding: one `InstancedMesh` per plan mesh, per-instance matrices and colors, the camera |

Still to come: **P3c** the React shell that wraps the store in Zustand
(ADR-0003), **P3d** the per-tier perf gate — which is P3's definition of done
(`docs/12-ROADMAP.md` §5) and the last `echo` left in
`determinism-matrix.yml`.

## Layering

Nothing here imports `@physics/engine` itself. `sim/rapier.ts` loads the physics
WASM at module scope, and edit mode has no world; the geometry the builder
shares with SimCore (03 §5.3 — "static geometry is not sent") comes from the
Rapier-free `@physics/engine/geometry` entry point, and the §5.5 frame reader
from `@physics/engine/transport` — the render thread is the one thread that must
never load a physics build. `three` is imported by exactly one file, so every
render *rule* is reachable from `node:test`. `tools/verify-web.mjs` enforces all
of it, along with the correspondence between this code and 04/09.

## Build

`tsc` → `dist/`, suites are `node:test` over the emitted JS (D30 — `ci.yml`'s
`unit` job spans Node 20, which cannot strip TypeScript).
