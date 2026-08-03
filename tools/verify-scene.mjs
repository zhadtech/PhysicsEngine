// M1 verification: schema compiles, doc examples validate, negatives fail.
// Run from anywhere: `pnpm verify:scene` (paths are repo-root anchored, P0).
import { readRepo, readRepoJson } from './repo.mjs';
import Ajv2020 from 'ajv/dist/2020.js';

const schema = readRepoJson('scene.schema.json');
const ajv = new Ajv2020.default({ strict: true, allErrors: true });
const validate = ajv.compile(schema);
console.log('schema compiled OK (ajv strict mode)');

// --- extract JSON blocks from the spec doc; full scenes have schemaVersion ---
const md = readRepo('docs/02-SCENE-FORMAT.md');
const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
let fullScenes = 0;
for (const [i, b] of blocks.entries()) {
  let parsed;
  try {
    parsed = JSON.parse(b);
  } catch {
    console.log(`block ${i}: not standalone JSON (sketch/fragment) — skipped`);
    continue;
  }
  if (parsed && typeof parsed === 'object' && 'schemaVersion' in parsed) {
    fullScenes++;
    const ok = validate(parsed);
    console.log(`block ${i} ("${parsed.meta?.title}"): ${ok ? 'VALID' : 'INVALID'}`);
    if (!ok) {
      console.log(JSON.stringify(validate.errors, null, 2));
      process.exitCode = 1;
    }
  } else {
    console.log(`block ${i}: fragment — skipped`);
  }
}
if (fullScenes < 2) {
  console.log('ERROR: expected 2 full example scenes in the doc');
  process.exitCode = 1;
}

// --- negative cases: every one of these MUST be rejected ---
const base = {
  schemaVersion: 1,
  engineVersion: '0.1.0',
  world: {},
  objects: [{ id: 'm1', type: 'marble', pos: [0, 0] }],
};
const negatives = [
  ['unknown object type', { ...base, objects: [{ id: 'x', type: 'teleporter', pos: [0, 0] }] }],
  ['missing schemaVersion', (() => { const { schemaVersion, ...r } = base; return r; })()],
  ['wrong schemaVersion', { ...base, schemaVersion: 2 }],
  ['extra top-level field', { ...base, results: [] }],
  ['unknown prop on domino', { ...base, objects: [{ id: 'd', type: 'domino', pos: [0, 0], props: { height: 0.1 } }] }],
  ['static platform with density', { ...base, objects: [{ id: 'p', type: 'platform', pos: [0, 0], props: { density: 5 } }] }],
  ['bad id chars', { ...base, objects: [{ id: 'a b!', type: 'marble', pos: [0, 0] }] }],
  ['marble r out of range', { ...base, objects: [{ id: 'm', type: 'marble', pos: [0, 0], props: { r: 3 } }] }],
  ['bad engineVersion', { ...base, engineVersion: 'v1' }],
  ['seed not integer', { ...base, world: { seed: 1.5 } }],
  ['rope segments = 1', { ...base, links: [{ id: 'l1', type: 'rope', a: { obj: 'm1' }, b: { obj: 'm1' }, props: { segments: 1 } }] }],
  ['endpoint with anchor AND at', { ...base, links: [{ id: 'l1', type: 'weld', a: { obj: 'm1', anchor: 'top', at: [0, 0] }, b: { obj: 'm1' } }] }],
  ['gearMesh ratio 0', { ...base, links: [{ id: 'l1', type: 'gearMesh', a: { obj: 'm1' }, b: { obj: 'm1' }, props: { ratio: 0 } }] }],
  ['unknown link type', { ...base, links: [{ id: 'l1', type: 'chain', a: { obj: 'm1' }, b: { obj: 'm1' } }] }],
  ['goal accepts empty list', { ...base, objects: [{ id: 'g', type: 'goal', pos: [0, 0], props: { accepts: [] } }] }],
];
let negFail = 0;
for (const [name, doc] of negatives) {
  if (validate(doc)) {
    console.log(`NEGATIVE NOT REJECTED: ${name}`);
    negFail++;
  }
}
console.log(negFail === 0 ? `all ${negatives.length} negative cases correctly rejected` : `${negFail} negative case(s) wrongly accepted`);
if (negFail > 0) process.exitCode = 1;

// --- positive edge cases ---
const positives = [
  ['defaults-only marble scene', base],
  ['triggered spring + cycle piston', { ...base, objects: [
    { id: 's', type: 'spring', pos: [0, 0], props: { mode: 'triggered' } },
    { id: 'p', type: 'piston', pos: [1, 0], rot: -90, props: { mode: 'cycle', period: 3, phase: 0.5 } },
    { id: 't', type: 'trigger', pos: [0.5, 0], props: { targets: ['s'] } },
  ] }],
  ['segmented rope via pulley', { ...base, objects: [
    { id: 'm1', type: 'marble', pos: [0, 0] },
    { id: 'c1', type: 'crate', pos: [1, 0] },
    { id: 'pu', type: 'pulley', pos: [0.5, 1] },
  ], links: [{ id: 'l1', type: 'rope', a: { obj: 'm1' }, b: { obj: 'c1', anchor: 'top' }, props: { via: ['pu'], length: 2.5 } }] }],
];
let posFail = 0;
for (const [name, doc] of positives) {
  if (!validate(doc)) {
    console.log(`POSITIVE REJECTED: ${name}`);
    console.log(JSON.stringify(validate.errors, null, 2));
    posFail++;
  }
}
console.log(posFail === 0 ? `all ${positives.length} positive edge cases accepted` : `${posFail} positive case(s) wrongly rejected`);
if (posFail > 0) process.exitCode = 1;
