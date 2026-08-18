/**
 * The pinned physics build (03 §2, decision D7).
 *
 * One module owns the import, so the exact-pinned package name and version live
 * in exactly one place and `ready.physicsBuild` (§5.3) reports what actually
 * loaded rather than what someone believed was installed. 03 §1 rule 2 —
 * "Rapier types never leak out of `packages/engine`" — is why this file is
 * imported only by `expand`, `forces`, `constraints` and `step`, never by
 * anything the protocol exposes.
 *
 * The `-compat` variant embeds the WASM as base64 (D7): identical bytes in the
 * browser and in Node, with no loader or bundler in the path that could serve a
 * different module to the two halves of the determinism matrix.
 *
 * Contract: docs/03-SIMULATION-CORE.md §2.
 */

import RAPIER from '@dimforge/rapier2d-deterministic-compat';

/** The Rapier namespace. Deliberately not re-exported from the package index. */
export type Rapier = typeof RAPIER;

/** Exact pin from D7 — `engineVersion` maps permanently to this build (03 §2). */
export const PHYSICS_PACKAGE = '@dimforge/rapier2d-deterministic-compat';
export const PHYSICS_VERSION = '0.19.3';

let ready: Promise<Rapier> | null = null;

/**
 * Load the WASM module. Idempotent, and the returned promise is shared: two
 * SimCores in one worker must not initialise the module twice.
 *
 * Everything downstream is synchronous — this is the one `await` in the engine,
 * which is what lets the step pipeline (§4) be a plain function and therefore
 * trivially reproducible.
 */
export function initPhysics(): Promise<Rapier> {
  ready ??= RAPIER.init().then(() => RAPIER);
  return ready;
}

/**
 * The build string reported in `ready` (§5.3), read back from the module rather
 * than from `PHYSICS_VERSION`: if a lockfile drift ever installed a different
 * Rapier, the golden hashes would move and this string is the evidence of why.
 */
export function physicsBuild(rapier: Rapier): string {
  return `${PHYSICS_PACKAGE}@${rapier.version()}`;
}
