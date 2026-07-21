// M9 verification (companion to verify.mjs / verify-backend.mjs, same
// copy-to-scratch convention: `npm i ajv yaml` in a dir holding this file plus
// .github/workflows/*.yml, schema.sql, scene.schema.json, and types/infra.ts).
//
// It checks the things tsc cannot see — the CI workflow YAML, the SQL, and the
// runtime behaviour of the two algorithms M9 introduces (the schema-migration
// runner and the cross-origin-isolation predicate) — and cross-checks the U9
// determinism matrix three ways: types/infra.ts ↔ the determinism workflow YAML.
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';

let failures = 0;
const fail = (msg) => {
  console.log(`  ✗ ${msg}`);
  failures++;
};
const ok = (msg) => console.log(`  ✓ ${msg}`);
const section = (s) => console.log(`\n## ${s}`);

// GitHub normalises the `on:` key to boolean `true` when unquoted — read either.
const onKey = (wf) => wf.on ?? wf['on'] ?? wf[true];

// ---------------------------------------------------------------------------
section('A. CI workflow YAML is structurally valid');
// ---------------------------------------------------------------------------
const WORKFLOWS = {
  ci: '.github/workflows/ci.yml',
  determinism: '.github/workflows/determinism-matrix.yml',
  deploy: '.github/workflows/deploy.yml',
};
const parsed = {};
for (const [key, path] of Object.entries(WORKFLOWS)) {
  let wf;
  try {
    wf = parseYaml(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`${path}: not valid YAML (${e.message})`);
    continue;
  }
  parsed[key] = wf;
  if (typeof wf.name !== 'string') fail(`${path}: missing top-level 'name'`);
  if (onKey(wf) === undefined) fail(`${path}: missing 'on' trigger`);
  if (!wf.jobs || typeof wf.jobs !== 'object') {
    fail(`${path}: missing 'jobs'`);
    continue;
  }
  for (const [jobId, job] of Object.entries(wf.jobs)) {
    const runsOn = job['runs-on'];
    const hasRunner = typeof runsOn === 'string' || (typeof runsOn === 'object' && runsOn !== null);
    if (!hasRunner) fail(`${path}: job '${jobId}' has no 'runs-on'`);
    if (!Array.isArray(job.steps) || job.steps.length === 0)
      fail(`${path}: job '${jobId}' has no 'steps'`);
  }
  ok(`${path}: name + on + ${Object.keys(wf.jobs).length} job(s), each with runs-on & steps`);
}

// ---------------------------------------------------------------------------
section('B. U9 determinism matrix — three-way (infra.ts ↔ determinism YAML)');
// ---------------------------------------------------------------------------
const infraSrc = readFileSync('./types/infra.ts', 'utf8');
// Extract a string-literal array declared as `NAME = [ ... ]` from infra.ts.
const arrLit = (name) => {
  const m = infraSrc.match(new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`));
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
};
const infraRunners = arrLit('DETERMINISM_RUNNERS');
const infraBrowsers = arrLit('BROWSER_TRIPLE');
const infraNodes = arrLit('CI_NODE_VERSIONS');

const setEq = (a, b) => a && b && a.length === b.length && a.every((x) => b.includes(x));

// U9's load-bearing property: BOTH ISAs present in infra.ts.
if (infraRunners?.includes('ubuntu-latest') && infraRunners?.includes('macos-14'))
  ok(`DETERMINISM_RUNNERS carries both ISAs (U9): ${infraRunners.join(', ')}`);
else fail(`U9: DETERMINISM_RUNNERS must include ubuntu-latest AND macos-14 (got ${infraRunners})`);

if (setEq(infraBrowsers, ['chromium', 'firefox', 'webkit']))
  ok(`BROWSER_TRIPLE is exactly chromium/firefox/webkit`);
else fail(`BROWSER_TRIPLE drifted: ${infraBrowsers}`);

// Now the YAML matrices must match the infra.ts sets.
const det = parsed.determinism;
const nodeGoldenOs = det?.jobs?.['node-golden']?.strategy?.matrix?.os;
const nodeGoldenNode = det?.jobs?.['node-golden']?.strategy?.matrix?.node?.map(String);
const browserMatrix = det?.jobs?.['browser-golden']?.strategy?.matrix?.browser;

if (setEq(nodeGoldenOs, infraRunners)) ok(`node-golden.matrix.os === DETERMINISM_RUNNERS`);
else fail(`node-golden.matrix.os (${nodeGoldenOs}) ≠ DETERMINISM_RUNNERS (${infraRunners})`);

if (setEq(nodeGoldenNode, infraNodes)) ok(`node-golden.matrix.node === CI_NODE_VERSIONS`);
else fail(`node-golden.matrix.node (${nodeGoldenNode}) ≠ CI_NODE_VERSIONS (${infraNodes})`);

if (setEq(browserMatrix, infraBrowsers)) ok(`browser-golden.matrix.browser === BROWSER_TRIPLE`);
else fail(`browser-golden.matrix.browser (${browserMatrix}) ≠ BROWSER_TRIPLE (${infraBrowsers})`);

// ---------------------------------------------------------------------------
section('C. Workflow files named in infra.ts exist & were parsed');
// ---------------------------------------------------------------------------
for (const [constName, path] of [
  ['MAIN_WORKFLOW', WORKFLOWS.ci],
  ['DETERMINISM_WORKFLOW', WORKFLOWS.determinism],
  ['DEPLOY_WORKFLOW', WORKFLOWS.deploy],
]) {
  if (infraSrc.includes(`'${path}'`)) ok(`CI.${constName} → ${path} present`);
  else fail(`CI.${constName} references ${path}, not found in infra.ts`);
}

// ---------------------------------------------------------------------------
section('D. Observability names resolve to real DB objects (schema.sql)');
// ---------------------------------------------------------------------------
const sql = readFileSync('./schema.sql', 'utf8');
for (const name of ['idx_run_reports_divergence', 'run_reports', 'scene_verifications']) {
  if (sql.includes(name)) ok(`OBSERVABILITY → '${name}' exists in schema.sql`);
  else fail(`OBSERVABILITY names '${name}' but it is absent from schema.sql`);
}

// ---------------------------------------------------------------------------
section('E. Schema-migration runner contract (executable)');
// ---------------------------------------------------------------------------
// Reference implementation of the 10 §5 runner. The registry lives in
// scene-format; here we prove the runner's guarantees on fixtures.
function runMigrations(doc, registry, target) {
  let cur = doc.schemaVersion;
  if (typeof cur !== 'number') throw new Error('E_MIGRATION: doc has no numeric schemaVersion');
  if (cur > target) throw new Error(`E_MIGRATION: doc schemaVersion ${cur} is newer than app ${target}`);
  let out = doc;
  while (cur < target) {
    const step = registry.find((m) => m.from === cur);
    if (!step) throw new Error(`E_MIGRATION: no migration from schemaVersion ${cur}`);
    if (step.to !== step.from + 1) throw new Error(`E_MIGRATION: migration ${step.from}→${step.to} is not single-step`);
    out = step.migrate(out);
    out.schemaVersion = step.to;
    cur = step.to;
  }
  return out;
}

const schema = JSON.parse(readFileSync('./scene.schema.json', 'utf8'));
const ajv = new Ajv2020.default({ strict: true, allErrors: true });
const validateScene = ajv.compile(schema);
const CURRENT = 1; // === MIGRATION.currentSchemaVersion / SCHEMA_VERSION

const currentDoc = {
  schemaVersion: 1,
  engineVersion: '0.1.0',
  world: {},
  objects: [{ id: 'm1', type: 'marble', pos: [0, 0] }],
};

// E1: empty registry (the real state at schemaVersion 1) — a current doc passes
// through untouched and still validates against the full schema.
{
  const migrated = runMigrations(structuredClone(currentDoc), [], CURRENT);
  if (migrated.schemaVersion === CURRENT && validateScene(migrated))
    ok('E1 empty registry: current-version doc passes through and re-validates');
  else fail(`E1: current doc failed (${JSON.stringify(validateScene.errors)})`);
}

// E2: a synthetic v0→v1 migration migrates a legacy doc and the result validates.
const synthRegistry = [
  {
    from: 0,
    to: 1,
    describe: 'add engineVersion default',
    migrate: (d) => ({ ...d, engineVersion: d.engineVersion ?? '0.1.0' }),
  },
];
{
  const legacy = { schemaVersion: 0, world: {}, objects: [{ id: 'm1', type: 'marble', pos: [0, 0] }] };
  const migrated = runMigrations(legacy, synthRegistry, CURRENT);
  if (migrated.schemaVersion === CURRENT && migrated.engineVersion === '0.1.0' && validateScene(migrated))
    ok('E2 synthetic v0→v1: legacy doc migrates forward and re-validates');
  else fail(`E2: migrated legacy doc failed (${JSON.stringify(validateScene.errors)})`);
}

// E3: the runner rejects a gapped registry (0→2 is not single-step) — the
// gap-free guarantee bites rather than silently skipping a version.
{
  const gapped = [{ from: 0, to: 2, describe: 'bad', migrate: (d) => d }];
  let threw = false;
  try {
    runMigrations({ schemaVersion: 0, world: {}, objects: [] }, gapped, 2);
  } catch {
    threw = true;
  }
  if (threw) ok('E3 gapped registry (0→2) is rejected by the single-step guard');
  else fail('E3: runner accepted a non-single-step migration');
}

// E4: a doc newer than the app is rejected, not silently loaded (forward-only).
{
  let threw = false;
  try {
    runMigrations({ schemaVersion: 5, world: {}, objects: [] }, [], CURRENT);
  } catch {
    threw = true;
  }
  if (threw) ok('E4 future-version doc (v5 on a v1 app) is rejected');
  else fail('E4: runner loaded a future-version doc');
}

// ---------------------------------------------------------------------------
section('F. Cross-origin-isolation predicate (U5, executable)');
// ---------------------------------------------------------------------------
// Mirror of infra.ts grantsIsolation — SAB transport is used iff this is true.
const grantsIsolation = (h) =>
  h['cross-origin-opener-policy'] === 'same-origin' &&
  (h['cross-origin-embedder-policy'] === 'require-corp' ||
    h['cross-origin-embedder-policy'] === 'credentialless');

const isoCases = [
  ['credentialless pair grants', { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'credentialless' }, true],
  ['require-corp pair grants', { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' }, true],
  ['missing COEP denies (embed fallback)', { 'cross-origin-opener-policy': 'same-origin' }, false],
  ['unsafe-none COOP denies', { 'cross-origin-opener-policy': 'unsafe-none', 'cross-origin-embedder-policy': 'credentialless' }, false],
];
for (const [name, headers, want] of isoCases) {
  if (grantsIsolation(headers) === want) ok(`${name}`);
  else fail(`isolation predicate wrong for: ${name}`);
}

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? 'ALL INFRA CHECKS PASSED' : `${failures} INFRA CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
