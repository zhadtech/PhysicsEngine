/**
 * schemaVersion migration runner (02 §9, 10 §5.2).
 *
 * A scene document carries its own `schemaVersion`. The runner chains
 * single-step forward migrations from a document's version up to the app's
 * current version; the caller then re-validates the result against the schema
 * (`validateScene` does both — 05 §5.3 step 4).
 *
 * Forward-only, on both axes named in 10 §5: there is no down-migration, and an
 * old app rejects a newer document by version rather than guessing at it.
 *
 * This is the implementation of the contract already proven executable in
 * `tools/verify-infra.mjs` §E (fixtures E1–E4: identity-at-current, synthetic
 * v0→v1 forward-migrate-and-revalidate, gap rejection, future-version
 * rejection). The registry below is what 10 §5.2 means by "the registry lives in
 * the scene-format package"; it is empty at schemaVersion 1 and stays empty
 * until the format releases a breaking change (02 §9 — additive changes never
 * bump the version).
 */

import { SCHEMA_VERSION } from './scene.js';

/**
 * A single-step forward migration of a scene document.
 *
 * `migrate` must be **pure**: return a new document rather than mutating its
 * input. The runner stamps `schemaVersion` on the value a step returns, so a
 * step that returns its argument would write through to the caller's document.
 */
export interface SchemaMigration {
  readonly from: number;
  readonly to: number;
  readonly describe: string;
  migrate(doc: Record<string, unknown>): Record<string, unknown>;
}

/**
 * The ordered, gap-free migration registry. Empty at schemaVersion 1 — the
 * format has never released a breaking change (02 §9).
 */
export const SCENE_MIGRATIONS: readonly SchemaMigration[] = [];

/** Why a migration could not be performed. The API boundary maps these to codes. */
export type MigrationFailure =
  /** The document has no numeric `schemaVersion` at all. */
  | 'no-version'
  /** The document is newer than this build — forward-only means we refuse it. */
  | 'newer-than-app'
  /** No migration is registered from the document's version. */
  | 'no-path'
  /** A registered migration skips a version (`to !== from + 1`). */
  | 'not-single-step';

/** Thrown by {@link runMigrations}. `E_MIGRATION` in 10 §5.2's terms. */
export class MigrationError extends Error {
  readonly code = 'E_MIGRATION' as const;
  readonly reason: MigrationFailure;
  /** The document's own version, when it had a readable one. */
  readonly from: number | null;

  constructor(reason: MigrationFailure, message: string, from: number | null) {
    super(message);
    this.name = 'MigrationError';
    this.reason = reason;
    this.from = from;
  }
}

/**
 * Chain migrations from `doc.schemaVersion` up to `target`.
 *
 * Returns the document at `target` (the input itself when it is already there).
 * Throws {@link MigrationError} rather than returning a partially migrated
 * document — a half-migrated scene must never reach validation or storage.
 */
export function runMigrations(
  doc: Record<string, unknown>,
  registry: readonly SchemaMigration[] = SCENE_MIGRATIONS,
  target: number = SCHEMA_VERSION,
): Record<string, unknown> {
  const start = doc['schemaVersion'];
  if (typeof start !== 'number' || !Number.isFinite(start)) {
    throw new MigrationError('no-version', 'document has no numeric schemaVersion', null);
  }
  if (start > target) {
    throw new MigrationError(
      'newer-than-app',
      `document schemaVersion ${start} is newer than this build (${target})`,
      start,
    );
  }

  let cur = start;
  let out = doc;
  while (cur < target) {
    const step = registry.find((m) => m.from === cur);
    if (!step) {
      throw new MigrationError('no-path', `no migration registered from schemaVersion ${cur}`, start);
    }
    if (step.to !== step.from + 1) {
      throw new MigrationError(
        'not-single-step',
        `migration ${step.from}→${step.to} skips a version; migrations must be single-step`,
        start,
      );
    }
    out = step.migrate(out);
    out['schemaVersion'] = step.to;
    cur = step.to;
  }
  return out;
}

/** The version this build migrates documents up to. */
export const CURRENT_SCHEMA_VERSION: number = SCHEMA_VERSION;
