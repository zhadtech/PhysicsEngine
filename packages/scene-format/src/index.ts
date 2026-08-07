/**
 * @physics/scene-format — the scene document contract.
 *
 * Filled in at P1 (12-ROADMAP §3) from artifacts authored and verified during
 * the design phase: the schema and the TypeScript mirror are the M1 deliverables
 * moved here unchanged, and the migration runner is the contract already proven
 * executable in `tools/verify-infra.mjs` §E. What P1 adds is the packaging and
 * the shared validation gate that ADR-0004/ADR-0005 assume.
 *
 * Contract: docs/02-SCENE-FORMAT.md
 *
 * ```ts
 * import { validateScene } from '@physics/scene-format';
 * const result = validateScene(doc, { bytes });
 * if (!result.ok) return reply.code(ERROR_STATUS[result.code]).send(envelope(result));
 * store(result.doc); // the migrated document, per 05 §5.3 step 4
 * ```
 */

/** Types, defaults, limits and classification tables (02 §2–§7). */
export * from './scene.js';
/** The finding vocabulary the gate speaks (02 §8, 05 §5.2). */
export * from './findings.js';
/** schemaVersion migrations (02 §9, 10 §5.2). */
export * from './migrate.js';
/** The 02 §8 semantic rules. */
export * from './semantic.js';
/** The gate itself (05 §5.3 steps 3–6) + the raw schema. */
export * from './validate.js';

export const PACKAGE = {
  name: '@physics/scene-format',
  /** Roadmap phase that filled this package in (docs/12-ROADMAP.md §3). */
  phase: 'P1',
  /** The normative spec this package implements. */
  contract: 'docs/02-SCENE-FORMAT.md',
} as const;
