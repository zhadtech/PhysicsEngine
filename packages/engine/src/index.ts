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
 * **What is not here yet (P2b, P2c).** The Rapier world and the §6 joints, the
 * §4 step pipeline, the §7 force layer, the §8 custom constraints, §10
 * analytics, §11 snapshot/reset, and the worker shell with its SAB transport
 * (§5). Until those land the matrix's golden jobs stay stubbed.
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

export const PACKAGE = {
  name: '@physics/engine',
  /** Roadmap phase that fills this package in (docs/12-ROADMAP.md §3). */
  phase: 'P2',
  /** The normative spec this package implements. */
  contract: 'docs/03-SIMULATION-CORE.md',
} as const;
