// M1 verification: schema compiles, doc examples validate, negatives fail.
// Run from anywhere: `pnpm verify:scene` (paths are repo-root anchored, P0).
//
// P1 added part T. The format now has three descriptions of itself — the spec
// prose (02), the JSON Schema, and the TypeScript mirror — living in two
// directories, and only the schema was ever machine-checked. Part T asserts the
// correspondence directly, with a mutation battery, so a type added to one and
// forgotten in the others fails the build instead of failing a user.
import { readRepo, readRepoJson } from './repo.mjs';
import Ajv2020 from 'ajv/dist/2020.js';

const schema = readRepoJson('packages/scene-format/scene.schema.json');
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

// ===========================================================================
// Part T — three-way correspondence (P1)
//
//   docs/02-SCENE-FORMAT.md  ↔  scene.schema.json  ↔  src/scene.ts
//
// The catalog is written out three times. Until P1 they sat in three different
// directories with nothing but review holding them together, and the schema was
// the only one under a check. These are the ties that a human eye slides past:
// a 19th object type, a limit raised in one place, an anchor renamed.
// ===========================================================================

import { readdirSync } from 'node:fs';
import { repoPath } from './repo.mjs';

const PKG = 'packages/scene-format';

// ---- parsers over src/scene.ts -------------------------------------------

const tsList = (src, name) => {
  const m = src.match(new RegExp(`const ${name}\\s*:[^=]*=\\s*\\[([\\s\\S]*?)\\]`));
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null;
};

const tsLimit = (src, key) => {
  const block = src.match(/export const LIMITS = \{([\s\S]*?)\n\} as const/)?.[1] ?? '';
  const m = block.match(new RegExp(`${key}:\\s*([\\d_]+)`));
  return m ? Number(m[1].replace(/_/g, '')) : null;
};

const tsIdPattern = (src) => src.match(/export const ID_PATTERN = \/(.+?)\/;/)?.[1] ?? null;

const tsAnchors = (src) => {
  const block = src.match(/export const NAMED_ANCHORS[^=]*=\s*\{([\s\S]*?)\n\} as const/)?.[1];
  if (!block) return null;
  const out = {};
  for (const row of block.matchAll(/^\s{2}(\w+):\s*\[([^\]]*)\]/gm)) {
    out[row[1]] = [...row[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  return out;
};

// ---- parsers over the spec ------------------------------------------------

/** Slice a markdown section by heading, up to the next heading of any level. */
const docSection = (md, headingRe) => {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^#{2,4} /.test(lines[i])) { end = i; break; }
  return lines.slice(start, end).join('\n');
};

/**
 * Table rows whose first cell opens with a backticked name. The catalog tables
 * annotate the cell (`` `gear` [dyn] ``), so the name is a prefix, not the cell.
 */
const docFirstColumnNames = (section) =>
  [...section.matchAll(/^\|\s*`([A-Za-z][A-Za-z0-9]*)`[^|]*\|/gm)].map((m) => m[1]);

/** 02 §6.3 → { type: [anchor, ...] }, with the universal "center" removed. */
const docAnchors = (md) => {
  const sec = docSection(md, /^### 6\.3 /);
  const out = {};
  for (const line of sec.split('\n')) {
    if (!/^\|/.test(line) || /^\|\s*-+/.test(line) || /Type family/.test(line)) continue;
    const cells = line.split('|').slice(1, -1);
    if (cells.length < 2) continue;
    const types = [...cells[0].matchAll(/`([a-z]+)`/g)].map((m) => m[1]);
    const anchors = [...cells[1].matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]).filter((a) => a !== 'center');
    for (const t of types) out[t] = anchors;
  }
  return out;
};

const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

// ---- the checks -----------------------------------------------------------

function runTieChecks(w, log) {
  let fails = 0;
  const A = (cond, msg) => {
    if (cond) { if (log) console.log(`  ok   ${msg}`); }
    else { if (log) console.log(`  FAIL ${msg}`); fails++; }
  };

  const defs = Object.keys(w.schema.$defs ?? {});
  const schemaObjTypes = defs.filter((k) => k.startsWith('obj_')).map((k) => k.slice(4));
  const schemaLinkTypes = defs.filter((k) => k.startsWith('link_')).map((k) => k.slice(5));
  const tsObjTypes = tsList(w.sceneTs, 'OBJECT_TYPES') ?? [];
  const tsLinkTypes = tsList(w.sceneTs, 'LINK_TYPES') ?? [];
  const docObjTypes = docFirstColumnNames(docSection(w.doc02, /^### 5\.3 /));
  const docLinkTypes = docFirstColumnNames(docSection(w.doc02, /^### 6\.2 /));

  // T1 — the catalog is the same catalog in all three descriptions.
  A(tsObjTypes.length === 18, `src/scene.ts lists 18 object types (got ${tsObjTypes.length})`);
  A(sameSet(schemaObjTypes, tsObjTypes),
    `schema obj_* variants === OBJECT_TYPES (schema-only: ${schemaObjTypes.filter((t) => !tsObjTypes.includes(t)).join(', ') || 'none'}; ts-only: ${tsObjTypes.filter((t) => !schemaObjTypes.includes(t)).join(', ') || 'none'})`);
  A(sameSet(docObjTypes, tsObjTypes),
    `02 §5.3 catalog === OBJECT_TYPES (doc-only: ${docObjTypes.filter((t) => !tsObjTypes.includes(t)).join(', ') || 'none'}; ts-only: ${tsObjTypes.filter((t) => !docObjTypes.includes(t)).join(', ') || 'none'})`);
  A(tsLinkTypes.length === 5, `src/scene.ts lists 5 link types (got ${tsLinkTypes.length})`);
  A(sameSet(schemaLinkTypes, tsLinkTypes), `schema link_* variants === LINK_TYPES`);
  A(sameSet(docLinkTypes, tsLinkTypes), `02 §6.2 catalog === LINK_TYPES`);

  // T2 — the 02 §7 size limits are one set of numbers, not three.
  const caps = [
    ['maxObjects', w.schema.properties?.objects?.maxItems, 'properties.objects.maxItems'],
    ['maxLinks', w.schema.properties?.links?.maxItems, 'properties.links.maxItems'],
    ['maxTargets', w.schema.$defs?.obj_trigger?.properties?.props?.properties?.targets?.maxItems, 'trigger.targets.maxItems'],
    ['maxRopeVia', w.schema.$defs?.link_rope?.properties?.props?.properties?.via?.maxItems, 'rope.via.maxItems'],
  ];
  for (const [key, schemaValue, where] of caps) {
    A(tsLimit(w.sceneTs, key) === schemaValue, `LIMITS.${key} (${tsLimit(w.sceneTs, key)}) === schema ${where} (${schemaValue})`);
  }
  const acceptsCap = (w.schema.$defs?.obj_goal?.properties?.props?.properties?.accepts?.oneOf ?? [])
    .map((v) => v.maxItems).find((v) => v !== undefined);
  A(tsLimit(w.sceneTs, 'maxTargets') === acceptsCap, `LIMITS.maxTargets === schema goal.accepts.maxItems (${acceptsCap})`);

  // T3 — one id grammar (02 §2.1).
  A(tsIdPattern(w.sceneTs) === w.schema.$defs?.id?.pattern,
    `ID_PATTERN === schema $defs.id.pattern (${w.schema.$defs?.id?.pattern})`);

  // T4 — the anchor tables agree; E5 rejects against NAMED_ANCHORS, so a name
  // that drifts from the spec is a link the builder can draw and the gate bans.
  const tsA = tsAnchors(w.sceneTs) ?? {};
  const docA = docAnchors(w.doc02);
  A(Object.keys(tsA).length === 18, `NAMED_ANCHORS covers 18 types (got ${Object.keys(tsA).length})`);
  A(sameSet(Object.keys(tsA), Object.keys(docA)), `02 §6.3 names every type NAMED_ANCHORS does`);
  for (const type of Object.keys(tsA).sort()) {
    A(docA[type] !== undefined && sameSet(tsA[type], docA[type]),
      `${type}: anchors [${tsA[type].join(', ') || '—'}] === 02 §6.3 [${(docA[type] ?? ['(absent)']).join(', ') || '—'}]`);
  }

  // T5 — every module in src/ is reachable from the package entry point.
  // The gate is only "shared code" (ADR-0004) if consumers can actually import it.
  for (const mod of w.srcModules) {
    A(new RegExp(`from '\\./${mod}\\.js'`).test(w.indexTs), `src/index.ts re-exports ./${mod}.js`);
  }

  return fails;
}

const world = {
  schema,
  sceneTs: readRepo(`${PKG}/src/scene.ts`),
  indexTs: readRepo(`${PKG}/src/index.ts`),
  doc02: md,
  srcModules: readdirSync(repoPath(PKG, 'src'))
    .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
    .map((f) => f.replace(/\.ts$/, ''))
    .sort(),
};

console.log('\npart T — 02 spec ↔ scene.schema.json ↔ src/scene.ts');
const tieFails = runTieChecks(world, true);

const cloneWorld = () => ({ ...world, schema: structuredClone(world.schema) });
const TIE_NEGATIVES = [
  ['add a 19th object type to the schema only', (w) => { w.schema.$defs.obj_teleporter = { type: 'object' }; }],
  ['drop a link type from src/scene.ts', (w) => { w.sceneTs = w.sceneTs.replace("'gearMesh'] as const", "] as const"); }],
  ['raise LIMITS.maxObjects without touching the schema', (w) => { w.sceneTs = w.sceneTs.replace('maxObjects: 5000', 'maxObjects: 9000'); }],
  ['change the schema id pattern', (w) => { w.schema.$defs.id.pattern = '^[a-z]+$'; }],
  ['drop a type row from the 02 §5.3 catalog', (w) => { w.doc02 = w.doc02.replace(/^\| `pendulum` \|.*$/m, ''); }],
  ['rename an anchor in 02 §6.3', (w) => { w.doc02 = w.doc02.replace('| `pendulum` | `pivot`, `bob` |', '| `pendulum` | `pivot`, `weight` |'); }],
  ['stop re-exporting the gate from src/index.ts', (w) => { w.indexTs = w.indexTs.replace("from './validate.js'", "from './scene.js'"); }],
];

console.log('\nnegative battery (each mutation must be caught):');
let tieBit = 0;
for (const [name, mutate] of TIE_NEGATIVES) {
  const w = cloneWorld();
  mutate(w);
  const f = runTieChecks(w, false);
  if (f > 0) { tieBit++; console.log(`  ok   bites: ${name} (${f} failure(s))`); }
  else console.log(`  FAIL silent: ${name}`);
}

console.log('\n' + '-'.repeat(40));
console.log(`part T failures : ${tieFails}`);
console.log(`negative battery: ${tieBit}/${TIE_NEGATIVES.length} bit`);
if (tieFails > 0 || tieBit !== TIE_NEGATIVES.length) process.exitCode = 1;
console.log(`verify-scene: ${process.exitCode ? 'RED' : 'GREEN'}`);
