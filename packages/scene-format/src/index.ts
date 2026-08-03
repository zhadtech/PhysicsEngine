/**
 * @physics/scene-format — skeleton (P0 repo bring-up).
 *
 * P1 moves `scene.schema.json` + `types/scene.ts` in here and adds the migration runner (10 §5.2). No design work remains — P1 is packaging.
 *
 * Contract: docs/02-SCENE-FORMAT.md
 */
export const PACKAGE = {
  name: '@physics/scene-format',
  /** Roadmap phase that fills this package in (docs/12-ROADMAP.md §3). */
  phase: 'P1',
  /** The normative spec this package implements. */
  contract: 'docs/02-SCENE-FORMAT.md',
} as const;
