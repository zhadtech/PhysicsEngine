/**
 * `@physics/engine/geometry` — the Rapier-free half of the core, as its own
 * entry point.
 *
 * 03 §5.3 says static geometry is *not* sent over the worker boundary: the
 * renderer derives every static placement — ramp vertices, curve tessellation,
 * spring and piston seated poses, anchor points — from the scene document
 * through the same code SimCore expands with. That only works if a consumer can
 * import that code *without* importing a physics build: `sim/rapier.ts` imports
 * the WASM module at module scope, so the package barrel pulls several megabytes
 * of engine into anything that touches it, and the builder needs geometry while
 * standing in edit mode with no world loaded at all.
 *
 * So this is a second door onto modules that were already environment-free and
 * already tested — the same arrangement `./protocol` got at P2, and for the same
 * reason. It adds no code and no behaviour; re-exporting is the whole file.
 *
 * ```ts
 * import { canonicalize, sceneGeometry, resolveAnchor } from '@physics/engine/geometry';
 * ```
 *
 * Contract: docs/03-SIMULATION-CORE.md §5.3, §6; docs/02-SCENE-FORMAT.md §6.3.
 */

/** Deterministic transcendentals (DET-5) — geometry is computed with these. */
export * from './sim/dmath.js';
/** DET-3 ordering and DET-4 quantization: the shape geometry is computed over. */
export * from './sim/canonical.js';
/** The §6 prefab tables, the §6.3 anchors, and the expanded-body count (04 §14). */
export * from './sim/geometry.js';
