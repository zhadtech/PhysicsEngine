/**
 * @physics/api — skeleton (P0 repo bring-up).
 *
 * P4 is the MVP/Beta line — the point at which the product is a platform rather than a local toy. `openapi.yaml`, `schema.sql` and `types/api.ts` move in here.
 *
 * Contract: docs/05-BACKEND.md
 */
export const PACKAGE = {
  name: '@physics/api',
  /** Roadmap phase that fills this package in (docs/12-ROADMAP.md §3). */
  phase: 'P4',
  /** The normative spec this package implements. */
  contract: 'docs/05-BACKEND.md',
} as const;
