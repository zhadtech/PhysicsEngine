// P1 companion check — the validation gate (05 §5.3) and the 02 §8 rules.
//
// Every phase in this project ships a machine check whose negative battery must
// all bite; for a package, that check is its unit suite. So the corpus below is
// built the same way the verify-*.mjs suites are: a table of documents with the
// exact rule ids each must produce, positives included, plus a proof that no
// rule can be declared in RULES and then never implemented.
//
// Runs on emitted JS (`pnpm --filter @physics/scene-format build`) because
// ci.yml's `unit` job spans Node 20, which cannot strip TypeScript.

import test from 'node:test';
import assert from 'node:assert/strict';

import { RULES, LIMITS, checkSemantics, validateScene, validateSceneJson } from '../dist/src/index.js';

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/** Minimal valid document; cases spread over it. */
const base = {
  schemaVersion: 1,
  engineVersion: '0.1.0',
  world: {},
  objects: [{ id: 'm1', type: 'marble', pos: [0, 0] }],
};

const scene = (over) => ({ ...base, ...over });

/**
 * `via` says which lane a case exercises:
 *  - 'gate'     — the whole 05 §5.3 order, as the API and builder call it.
 *  - 'semantic' — checkSemantics directly. Used for rules the JSON Schema also
 *                 catches (id pattern, list caps) and for E6, which JSON cannot
 *                 even express — 02 §8 rule 6 exists precisely for non-JSON
 *                 ingestion paths like AI repair that build objects in memory.
 */
const CASES = [
  // -- positives ----------------------------------------------------------
  { name: 'defaults-only marble scene', via: 'gate', doc: base, ok: true, rules: [] },
  {
    name: 'triggered spring + cycle piston',
    via: 'gate',
    ok: true,
    rules: [],
    doc: scene({
      objects: [
        { id: 's', type: 'spring', pos: [0, 0], props: { mode: 'triggered' } },
        { id: 'p', type: 'piston', pos: [1, 0], rot: -90, props: { mode: 'cycle', period: 3, phase: 0.5 } },
        { id: 't', type: 'trigger', pos: [0.5, 0], props: { targets: ['s'] } },
      ],
    }),
  },
  {
    name: 'segmented rope via pulley',
    via: 'gate',
    ok: true,
    rules: [],
    doc: scene({
      objects: [
        { id: 'm1', type: 'marble', pos: [0, 0] },
        { id: 'c1', type: 'crate', pos: [1, 0] },
        { id: 'pu', type: 'pulley', pos: [0.5, 1] },
      ],
      links: [{ id: 'l1', type: 'rope', a: { obj: 'm1' }, b: { obj: 'c1', anchor: 'top' }, props: { via: ['pu'], length: 2.5 } }],
    }),
  },

  // -- schema (step 5) ----------------------------------------------------
  {
    name: 'unknown object type is a schema failure',
    via: 'gate',
    ok: false,
    code: 'E_SCHEMA',
    rules: ['schema'],
    doc: scene({ objects: [{ id: 'x', type: 'teleporter', pos: [0, 0] }] }),
  },

  // -- E1: one id namespace ------------------------------------------------
  {
    name: 'E1 duplicate id across the shared namespace',
    via: 'gate',
    ok: false,
    code: 'E_SEMANTIC',
    rules: ['E1'],
    doc: scene({
      objects: [
        { id: 'm1', type: 'marble', pos: [0, 0] },
        { id: 'c1', type: 'crate', pos: [1, 0] },
      ],
      links: [{ id: 'm1', type: 'weld', a: { obj: 'm1' }, b: { obj: 'c1' } }],
    }),
  },
  {
    name: 'E1 id that does not match the pattern',
    via: 'semantic',
    rules: ['E1'],
    doc: scene({ objects: [{ id: 'a b!', type: 'marble', pos: [0, 0] }] }),
  },

  // -- E2: references resolve ----------------------------------------------
  {
    name: 'E2 link endpoint names a missing object',
    via: 'gate',
    ok: false,
    code: 'E_SEMANTIC',
    rules: ['E2'],
    doc: scene({ links: [{ id: 'l1', type: 'weld', a: { obj: 'm1' }, b: { obj: 'ghost' } }] }),
  },
  {
    name: 'E2 trigger targets a missing object',
    via: 'gate',
    ok: false,
    code: 'E_SEMANTIC',
    rules: ['E2'],
    doc: scene({
      objects: [
        { id: 'm1', type: 'marble', pos: [0, 0] },
        { id: 't', type: 'trigger', pos: [0.5, 0], props: { targets: ['ghost'] } },
      ],
    }),
  },
  {
    name: 'E2 goal accepts a missing object',
    via: 'gate',
    ok: false,
    code: 'E_SEMANTIC',
    rules: ['E2'],
    doc: scene({
      objects: [
        { id: 'm1', type: 'marble', pos: [0, 0] },
        { id: 'g', type: 'goal', pos: [0.5, 0], props: { accepts: ['ghost'] } },
      ],
    }),
  },
  {
    name: 'E2 rope routes via a missing object',
    via: 'gate',
    ok: false,
    code: 'E_SEMANTIC',
    rules: ['E2'],
    doc: scene({
      objects: [
        { id: 'm1', type: 'marble', pos: [0, 0] },
        { id: 'c1', type: 'crate', pos: [1, 0] },
      ],
      links: [{ id: 'l1', type: 'rope', a: { obj: 'm1' }, b: { obj: 'c1' }, props: { via: ['ghost'] } }],
    }),
  },

  // -- E3: endpoint types --------------------------------------------------
  {
    name: 'E3 gearMesh between non-gears',
    via: 'gate',
    ok: false,
    code: 'E_SEMANTIC',
    rules: ['E3'],
    doc: scene({
      objects: [
        { id: 'm1', type: 'marble', pos: [0, 0] },
        { id: 'c1', type: 'crate', pos: [1, 0] },
      ],
      links: [{ id: 'l1', type: 'gearMesh', a: { obj: 'm1' }, b: { obj: 'c1' } }],
    }),
  },
  {
    name: 'E3 axle onto a static platform',
    via: 'gate',
    ok: false,
    code: 'E_SEMANTIC',
    rules: ['E3'],
    doc: scene({
      objects: [
        { id: 'm1', type: 'marble', pos: [0, 0] },
        { id: 'pl', type: 'platform', pos: [1, 0] },
      ],
      links: [{ id: 'l1', type: 'axle', a: { obj: 'm1' }, b: { obj: 'pl' } }],
    }),
  },
  {
    name: 'E3 rope routes via a non-pulley',
    via: 'gate',
    ok: false,
    code: 'E_SEMANTIC',
    rules: ['E3'],
    doc: scene({
      objects: [
        { id: 'm1', type: 'marble', pos: [0, 0] },
        { id: 'c1', type: 'crate', pos: [1, 0] },
        { id: 'pl', type: 'platform', pos: [0.5, 1] },
      ],
      links: [{ id: 'l1', type: 'rope', a: { obj: 'm1' }, b: { obj: 'c1' }, props: { via: ['pl'] } }],
    }),
  },

  // -- E4 / E5 / E7 --------------------------------------------------------
  {
    name: 'E4 link connects an object to itself',
    via: 'gate',
    ok: false,
    code: 'E_SEMANTIC',
    rules: ['E4'],
    doc: scene({ links: [{ id: 'l1', type: 'weld', a: { obj: 'm1' }, b: { obj: 'm1' } }] }),
  },
  {
    name: 'E5 anchor that does not exist on the endpoint type',
    via: 'gate',
    ok: false,
    code: 'E_SEMANTIC',
    rules: ['E5'],
    doc: scene({
      objects: [
        { id: 'm1', type: 'marble', pos: [0, 0] },
        { id: 'c1', type: 'crate', pos: [1, 0] },
      ],
      // "bob" is a pendulum anchor; a marble has none at all.
      links: [{ id: 'l1', type: 'weld', a: { obj: 'm1', anchor: 'bob' }, b: { obj: 'c1' } }],
    }),
  },
  {
    name: 'E5 accepts "center" on every type',
    via: 'gate',
    ok: true,
    rules: [],
    doc: scene({
      objects: [
        { id: 'm1', type: 'marble', pos: [0, 0] },
        { id: 'c1', type: 'crate', pos: [1, 0] },
      ],
      links: [{ id: 'l1', type: 'weld', a: { obj: 'm1', anchor: 'center' }, b: { obj: 'c1', anchor: 'top' } }],
    }),
  },
  {
    name: 'E7 lever minAngle >= maxAngle',
    via: 'gate',
    ok: false,
    code: 'E_SEMANTIC',
    rules: ['E7'],
    doc: scene({ objects: [{ id: 'lv', type: 'lever', pos: [0, 0], props: { minAngle: 30, maxAngle: 30 } }] }),
  },

  // -- E6: non-finite numbers (02 §8 rule 6 — non-JSON ingestion) ----------
  {
    name: 'E6 NaN reaching the gate from an in-memory document',
    via: 'semantic',
    rules: ['E6'],
    doc: scene({ objects: [{ id: 'm1', type: 'marble', pos: [Number.NaN, 0] }] }),
  },
  {
    name: 'E6 Infinity in a prop',
    via: 'semantic',
    rules: ['E6'],
    doc: scene({ objects: [{ id: 'm1', type: 'marble', pos: [0, 0], props: { r: Number.POSITIVE_INFINITY } }] }),
  },

  // -- E8: the 02 §7 size limits -------------------------------------------
  {
    name: 'E8 trigger with more targets than the limit',
    via: 'semantic',
    // The filler ids name nothing, so every one of them is also an E2; W9 is
    // absent by design — an unresolved target cannot have a wrong type yet.
    rules: ['E8', 'E2'],
    doc: scene({
      objects: [
        { id: 'm1', type: 'marble', pos: [0, 0] },
        {
          id: 't',
          type: 'trigger',
          pos: [0.5, 0],
          props: { targets: Array.from({ length: LIMITS.maxTargets + 1 }, (_, i) => `t${i}`) },
        },
      ],
    }),
  },
  {
    name: 'E8 rope with more via waypoints than the limit',
    via: 'semantic',
    rules: ['E8', 'E2'],
    doc: scene({
      objects: [
        { id: 'm1', type: 'marble', pos: [0, 0] },
        { id: 'c1', type: 'crate', pos: [1, 0] },
      ],
      links: [
        {
          id: 'l1',
          type: 'rope',
          a: { obj: 'm1' },
          b: { obj: 'c1' },
          props: { via: Array.from({ length: LIMITS.maxRopeVia + 1 }, (_, i) => `p${i}`) },
        },
      ],
    }),
  },

  // -- W-rules -------------------------------------------------------------
  {
    name: 'W9 trigger targets something with no activation effect',
    via: 'gate',
    ok: true,
    rules: ['W9'],
    doc: scene({
      objects: [
        { id: 'm1', type: 'marble', pos: [0, 0] },
        { id: 't', type: 'trigger', pos: [0.5, 0], props: { targets: ['m1'] } },
      ],
    }),
  },
  {
    name: 'W10 object parked outside bounds plus the removal margin',
    via: 'gate',
    ok: true,
    rules: ['W10'],
    doc: scene({ objects: [{ id: 'm1', type: 'marble', pos: [50, 0] }] }),
  },
  {
    name: 'W11 duplicate gearMesh between the same pair',
    via: 'gate',
    ok: true,
    rules: ['W11'],
    doc: scene({
      objects: [
        { id: 'g1', type: 'gear', pos: [0, 0] },
        { id: 'g2', type: 'gear', pos: [0.2, 0] },
      ],
      links: [
        { id: 'l1', type: 'gearMesh', a: { obj: 'g1' }, b: { obj: 'g2' } },
        { id: 'l2', type: 'gearMesh', a: { obj: 'g2' }, b: { obj: 'g1' } },
      ],
    }),
  },
  {
    name: 'W11 rope shorter than its endpoint distance starts taut',
    via: 'gate',
    ok: true,
    rules: ['W11'],
    doc: scene({
      objects: [
        { id: 'm1', type: 'marble', pos: [0, 0] },
        { id: 'c1', type: 'crate', pos: [1, 0] },
      ],
      links: [{ id: 'l1', type: 'rope', a: { obj: 'm1' }, b: { obj: 'c1' }, props: { length: 0.5 } }],
    }),
  },
  {
    name: 'W12 number beyond the writer quantization limit',
    via: 'gate',
    ok: true,
    rules: ['W12'],
    doc: scene({ objects: [{ id: 'm1', type: 'marble', pos: [0.123456, 0] }] }),
  },
];

// ---------------------------------------------------------------------------
// Run the corpus eagerly, so the reachability proof below sees every result
// regardless of how the runner schedules the tests.
// ---------------------------------------------------------------------------

const ruleSet = (findings) => [...new Set(findings.map((f) => f.rule))].sort();

const results = CASES.map((c) => {
  if (c.via === 'semantic') {
    const findings = checkSemantics(c.doc);
    return { case: c, findings, produced: ruleSet(findings) };
  }
  const r = validateScene(c.doc);
  const findings = [...r.findings, ...r.warnings];
  return { case: c, result: r, findings, produced: ruleSet(findings) };
});

for (const { case: c, result, produced, findings } of results) {
  test(`${c.via}: ${c.name}`, () => {
    if (c.via === 'gate') {
      assert.equal(result.ok, c.ok, `expected ok=${c.ok}, got ${result.ok}: ${JSON.stringify(findings)}`);
      if (c.ok) {
        assert.notEqual(result.doc, null, 'an accepted document must be returned');
      } else {
        assert.equal(result.code, c.code);
        assert.equal(result.doc, null, 'a rejected document must not be returned');
        assert.ok(result.findings.length > 0, 'a rejection must carry findings');
      }
    }
    assert.deepEqual(produced, [...c.rules].sort(), `findings: ${JSON.stringify(findings, null, 1)}`);
  });
}

// ---------------------------------------------------------------------------
// The proofs that make the corpus a check rather than a demo
// ---------------------------------------------------------------------------

test('every rule declared in RULES is produced by at least one corpus case', () => {
  const produced = new Set(results.flatMap((r) => r.produced));
  const missing = Object.keys(RULES).filter((r) => !produced.has(r));
  assert.deepEqual(missing, [], `declared but never produced: ${missing.join(', ')}`);
});

test('every finding carries the severity its rule declares', () => {
  for (const { findings } of results) {
    for (const f of findings) {
      assert.equal(f.severity, RULES[f.rule].severity, `rule ${f.rule} emitted severity ${f.severity}`);
    }
  }
});

test('findings locate the offender: paths are JSON pointers, ids name real entries', () => {
  for (const { case: c, findings } of results) {
    for (const f of findings) {
      if (f.path !== undefined) {
        assert.match(f.path, /^\/(?:[^/]*(?:\/[^/]*)*)?$/, `${f.rule} path is not a JSON pointer: ${f.path}`);
      }
      for (const id of f.ids ?? []) {
        const known = [...(c.doc.objects ?? []), ...(c.doc.links ?? [])].some((e) => e.id === id);
        assert.ok(known, `${f.rule} names id "${id}", which is not in the document`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Gate order (05 §5.3) — the steps are normative, so their precedence is too
// ---------------------------------------------------------------------------

test('step 3 precedes step 5: an oversized document diagnoses as E_LIMITS, not E_SCHEMA', () => {
  const broken = scene({ objects: [{ id: 'x', type: 'teleporter', pos: [0, 0] }] });
  const r = validateScene(broken, { bytes: LIMITS.maxJsonBytes + 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_LIMITS');
  assert.equal(r.findings[0].rule, 'E8');
});

test('step 4 precedes step 5: a newer document is E_SCHEMA_NEWER, not E_SCHEMA', () => {
  const r = validateScene({ ...base, schemaVersion: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_SCHEMA_NEWER');
});

test('step 5 precedes step 6: a structurally broken document never reaches the semantic rules', () => {
  // Both wrong: unknown type (schema) *and* a self-link (E4).
  const r = validateScene(
    scene({
      objects: [{ id: 'x', type: 'teleporter', pos: [0, 0] }],
      links: [{ id: 'l1', type: 'weld', a: { obj: 'x' }, b: { obj: 'x' } }],
    }),
  );
  assert.equal(r.code, 'E_SCHEMA');
  assert.deepEqual(ruleSet(r.findings), ['schema']);
});

test('warnings survive a semantic rejection so the panel can show everything at once', () => {
  const r = validateScene(
    scene({
      objects: [
        { id: 'm1', type: 'marble', pos: [50, 0] }, // W10
        { id: 'c1', type: 'crate', pos: [1, 0] },
      ],
      links: [{ id: 'l1', type: 'weld', a: { obj: 'm1' }, b: { obj: 'm1' } }], // E4
    }),
  );
  assert.equal(r.code, 'E_SEMANTIC');
  assert.deepEqual(ruleSet(r.findings), ['E4']);
  assert.deepEqual(ruleSet(r.warnings), ['W10']);
});

test('the accepted document is the migrated one, and the input is not mutated', () => {
  const input = scene({});
  const snapshot = structuredClone(input);
  const r = validateScene(input);
  assert.equal(r.ok, true);
  assert.deepEqual(input, snapshot, 'the gate must not write through to its caller');
});

// ---------------------------------------------------------------------------
// The serialized entry point
// ---------------------------------------------------------------------------

test('validateSceneJson measures the byte cap itself', () => {
  const ok = validateSceneJson(JSON.stringify(base));
  assert.equal(ok.ok, true);

  const padded = JSON.stringify({ ...base, meta: { description: 'x'.repeat(LIMITS.maxJsonBytes) } });
  const tooBig = validateSceneJson(padded);
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.code, 'E_LIMITS');
});

test('validateSceneJson reports malformed JSON as a schema failure, not a throw', () => {
  const r = validateSceneJson('{"schemaVersion":1,');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_SCHEMA');
});

test('multi-byte characters count as bytes, not as characters', () => {
  // A UTF-8 char is up to 4 bytes; measuring with .length would under-count and
  // let an over-cap document through the check the server enforces in bytes.
  const text = JSON.stringify({ ...base, meta: { title: '🧱' } });
  assert.ok(new TextEncoder().encode(text).length > text.length);
  assert.equal(validateSceneJson(text).ok, true);
});
