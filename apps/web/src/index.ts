/**
 * @physics/web — the builder, the renderer and play mode (12-ROADMAP §3, P3).
 *
 * **What is here (P3a — the headless half).** Everything in 04 that is a rule
 * rather than a pixel, written framework-free so it can be held to the spec by
 * `node:test` instead of by looking at it:
 *
 * - `editor/model` — the 04 companion table (constants, inspector descriptors,
 *   palette, keymap, command union), migrated from `types/editor.ts`;
 * - `editor/document` + `editor/commands` + `editor/store` — §9's command
 *   pattern, its exact inverses, the 200-command ring and the save pointer;
 * - `editor/ids` — §5.2's "smallest unused positive integer" allocator;
 * - `editor/refs` + `editor/edits` — the delete cascade, duplicate, copy/paste
 *   and rename of §5.5, which are what make 02 §8's *errors* unreachable from
 *   the UI;
 * - `editor/shapes` + `editor/snap` + `editor/place` — §6's snapping ladder, the
 *   §5.2 surface seat, the §6.4 gear snap and its auto-`gearMesh`, the domino
 *   run;
 * - `editor/write` — the 02 §2 strict writer, and `editor/gate` — §10.1's
 *   serialize→validate round trip into Test;
 * - `editor/budgets` and `editor/drafts` — §14's live limits and autosave ring.
 *
 * **What is here (P3b — the renderer).** The same treatment applied to the
 * picture: what to draw is decided as plain data and only then handed to a GPU.
 *
 * - `render/perf` — the render half of 09 (budget, tiers, `RENDER_CLASS`, the
 *   draw ceilings), migrated from `types/perf.ts`;
 * - `render/classify` — §4's partition into instanced groups, generated shapes
 *   and overlays, the draw-call count, and the registry binding;
 * - `render/camera` + `render/grid` — 04 §4's three-degree-of-freedom workshop
 *   camera, the `planeAngle` roll, and the grid whose pitch *is* the snap step;
 * - `render/generated` — §12's belts, rope sag and pulley routing;
 * - `render/frame` — 03 §5.5's interpolation applied to the plan (sleep dim,
 *   `Removed`, distance LOD);
 * - `render/quality` — §7.2's adaptive loop, whose whole output is a render
 *   envelope, so it structurally cannot throttle the worker (D20);
 * - `render/three` — the only file that imports Three.js.
 *
 * **What comes next.** P3c the React shell that wraps this store in Zustand per
 * ADR-0003; P3d the per-tier perf gate, which is P3's exit criterion
 * (12-ROADMAP §5) and the last echo left in `determinism-matrix.yml`.
 *
 * Nothing here imports the engine barrel: the geometry it shares with SimCore
 * comes from `@physics/engine/geometry` and the frame reader from
 * `@physics/engine/transport`, neither of which carries a physics build (03
 * §5.3). Edit mode has no world loaded, and the render thread must never have
 * one.
 *
 * Contract: docs/04-BUILDER-UX.md
 */

export * from './editor/model.js';
export * from './editor/ids.js';
export * from './editor/refs.js';
export * from './editor/document.js';
export * from './editor/commands.js';
export * from './editor/store.js';
export * from './editor/shapes.js';
export * from './editor/snap.js';
export * from './editor/place.js';
export * from './editor/edits.js';
export * from './editor/write.js';
export * from './editor/gate.js';
export * from './editor/budgets.js';
export * from './editor/drafts.js';

export * from './render/perf.js';
export * from './render/classify.js';
export * from './render/camera.js';
export * from './render/grid.js';
export * from './render/generated.js';
export * from './render/frame.js';
export * from './render/quality.js';
export * from './render/three.js';

export const PACKAGE = {
  name: '@physics/web',
  /** Roadmap phase that fills this package in (docs/12-ROADMAP.md §3). */
  phase: 'P3',
  /** The normative spec this package implements. */
  contract: 'docs/04-BUILDER-UX.md',
} as const;
