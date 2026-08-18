/**
 * @physics/engine — the deterministic simulation core.
 *
 * P2 is the project's keystone phase (12-ROADMAP §3, D28): everything after it
 * — leaderboards, procgen's self-check, AI validation, production divergence
 * monitoring — assumes a run is a pure function of `(document, engineVersion)`
 * that replays byte-identically on every machine. The phase exits when
 * `determinism-matrix.yml` is green with *real* golden hashes across both ISAs
 * and the browser triple.
 *
 * **What is here (P2a — the Rapier-free half).** The determinism substrate and
 * everything derivable from a scene document without a physics engine:
 *
 * - `dmath` — DET-5's own `sin`/`cos`/`atan2`, because the platform's are not
 *   bit-identical across JS engines (measured: V8 and JSC disagree on 4.6 % of
 *   `sin` samples and 16.7 % of `atan2` samples over this engine's domain).
 * - `rng` — DET-6's single PCG32, snapshot-able.
 * - `hash` — §12's FNV-1a 32 state hash, the number the whole matrix compares.
 * - `canonical` — DET-3 ordering and DET-4 quantization: one shape for
 *   everything downstream, radians past the load boundary.
 * - `geometry` — the §6 prefab tables and the §6.3 anchors, shared with the
 *   renderer exactly as §5.3 requires.
 * - `protocol` — the worker contract (also its own entry point, `@physics/engine/protocol`).
 *
 * **What P2b added.** The Rapier world and the §6 joints, the §4 step pipeline,
 * the §7 force layer, the §8 custom constraints, §10 analytics and §11
 * snapshot/reset — with the first real golden hashes, reproduced across both
 * ISAs by `determinism-matrix.yml`'s `node-golden` job.
 *
 * **What P2c added.** The other half of the matrix: `transport.ts` (the §5.4
 * triple-buffered SharedArrayBuffer and its postMessage fallback) and
 * `worker.ts` (the §5 protocol, the §5.1 lifecycle, the §5.5 pacer). These two
 * files are the only ones that know a browser exists — everything under `sim/`
 * stays environment-free (03 §1 rule 1) — and they are what lets the same
 * hashes be read back out of a real Chromium, Firefox and WebKit.
 *
 * Contract: docs/03-SIMULATION-CORE.md
 */

/** The worker protocol, engine constants and SAB layout (03 §5, §10). */
export * from './protocol.js';
/** Deterministic transcendentals (DET-5). */
export * from './sim/dmath.js';
/** The single seeded PRNG (DET-6). */
export * from './sim/rng.js';
/** State hashing (§12). */
export * from './sim/hash.js';
/** Input canonicalization (DET-3, DET-4). */
export * from './sim/canonical.js';
/** Prefab geometry and anchors (§6, 02 §6.3). */
export * from './sim/geometry.js';
/** The pinned physics build (§2, D7) — values only; Rapier's types stay inside. */
export { initPhysics, PHYSICS_PACKAGE, PHYSICS_VERSION, physicsBuild } from './sim/rapier.js';
/** Prefab expansion into the Rapier world (§6). */
export * from './sim/expand.js';
/** Field and surface forces (§7). */
export * from './sim/forces.js';
/** Custom velocity constraints and capped motors (§8, U10). */
export * from './sim/constraints.js';
/** Analytics accumulators and the §10 report. */
export * from './sim/analytics.js';
/** Snapshot/reset state shapes (§11). */
export * from './sim/snapshot.js';
/** The step pipeline and run lifecycle (§4, §9) — `createSimCore()` starts here. */
export * from './sim/step.js';
/** The §5.4 shared-buffer transport and its fallback, plus §5.5 interpolation. */
export * from './transport.js';
/** The §5 worker shell: lifecycle, pacing, publishing (`attachToWorkerScope`). */
export * from './worker.js';

export const PACKAGE = {
  name: '@physics/engine',
  /** Roadmap phase that fills this package in (docs/12-ROADMAP.md §3). */
  phase: 'P2',
  /** The normative spec this package implements. */
  contract: 'docs/03-SIMULATION-CORE.md',
} as const;
