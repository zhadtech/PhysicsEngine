// P1 companion check — the schemaVersion migration runner (02 §9, 10 §5.2).
//
// verify-infra.mjs §E proved this contract executable against a reference
// implementation while the package was still a skeleton. Now that the real
// runner exists, the same four fixtures (E1–E4) run against it, plus the
// registry invariants that only start to bite when SCENE_MIGRATIONS stops
// being empty — which is exactly when nobody will remember to check them.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CURRENT_SCHEMA_VERSION,
  MigrationError,
  SCENE_MIGRATIONS,
  SCHEMA_VERSION,
  runMigrations,
  validateScene,
} from '../dist/src/index.js';

const currentDoc = () => ({
  schemaVersion: SCHEMA_VERSION,
  engineVersion: '0.1.0',
  world: {},
  objects: [{ id: 'm1', type: 'marble', pos: [0, 0] }],
});

/** The synthetic v0→v1 step from verify-infra.mjs §E2. */
const synthetic = [
  {
    from: 0,
    to: 1,
    describe: 'add engineVersion default',
    migrate: (d) => ({ ...d, engineVersion: d.engineVersion ?? '0.1.0' }),
  },
];

test('E1 empty registry: a current-version document passes through and re-validates', () => {
  const doc = currentDoc();
  const migrated = runMigrations(doc);
  assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(validateScene(migrated).ok, true);
});

test('E2 synthetic v0→v1: a legacy document migrates forward and re-validates', () => {
  const legacy = { schemaVersion: 0, world: {}, objects: [{ id: 'm1', type: 'marble', pos: [0, 0] }] };
  const migrated = runMigrations(legacy, synthetic);
  assert.equal(migrated.schemaVersion, 1);
  assert.equal(migrated.engineVersion, '0.1.0');
  assert.equal(validateScene(migrated).ok, true);
});

test('E3 a gapped registry (0→2) is rejected rather than silently skipping a version', () => {
  const gapped = [{ from: 0, to: 2, describe: 'bad', migrate: (d) => d }];
  assert.throws(
    () => runMigrations({ schemaVersion: 0, world: {}, objects: [] }, gapped, 2),
    (err) => err instanceof MigrationError && err.reason === 'not-single-step',
  );
});

test('E4 a future-version document is rejected, not loaded', () => {
  assert.throws(
    () => runMigrations({ schemaVersion: 5, world: {}, objects: [] }),
    (err) => err instanceof MigrationError && err.reason === 'newer-than-app',
  );
});

test('a document with no version is rejected before anything is guessed at', () => {
  assert.throws(
    () => runMigrations({ world: {}, objects: [] }),
    (err) => err instanceof MigrationError && err.reason === 'no-version',
  );
});

test('a version with no registered path is rejected rather than passed through', () => {
  assert.throws(
    () => runMigrations({ schemaVersion: 0, world: {}, objects: [] }),
    (err) => err instanceof MigrationError && err.reason === 'no-path',
  );
});

test('a partially migrated document is never returned', () => {
  // 0→1 exists; 1→2 does not. Migrating toward 2 must throw, not hand back a v1.
  assert.throws(
    () => runMigrations({ schemaVersion: 0, world: {}, objects: [] }, synthetic, 2),
    (err) => err instanceof MigrationError && err.reason === 'no-path',
  );
});

test('the shipped registry is empty at schemaVersion 1 (02 §9 — no breaking change yet)', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(CURRENT_SCHEMA_VERSION, SCHEMA_VERSION);
  assert.deepEqual([...SCENE_MIGRATIONS], []);
});

test('the shipped registry is ordered, gap-free and total up to the current version', () => {
  // Vacuous today; the invariant is written now so the first real migration
  // cannot land unordered, duplicated, or with a hole in the chain.
  const steps = [...SCENE_MIGRATIONS];
  steps.forEach((m, i) => {
    assert.equal(m.to, m.from + 1, `migration ${m.from}→${m.to} is not single-step`);
    if (i > 0) assert.equal(m.from, steps[i - 1].to, 'registry is not contiguous');
  });
  if (steps.length > 0) {
    assert.equal(steps[steps.length - 1].to, CURRENT_SCHEMA_VERSION, 'registry does not reach the current version');
    const froms = new Set(steps.map((m) => m.from));
    assert.equal(froms.size, steps.length, 'two migrations start from the same version');
  }
});

test('the gate reports a version it cannot reach as a schema failure, never E_MIGRATION', () => {
  // 05 §5.2 declares no E_MIGRATION code; the gate may not invent one.
  const older = validateScene({ schemaVersion: 0, world: {}, objects: [] });
  assert.equal(older.ok, false);
  assert.equal(older.code, 'E_SCHEMA');

  const newer = validateScene({ schemaVersion: 99, world: {}, objects: [] });
  assert.equal(newer.ok, false);
  assert.equal(newer.code, 'E_SCHEMA_NEWER');
});
