#!/usr/bin/env node
// verify-workspace.mjs — the P0 check.
//
// P0's only deliverable is *structure*, so its quality bar is correspondence:
// the monorepo skeleton must match the canonical layout (00-PROGRESS "planned
// repo layout"), the roadmap's phase table (12-ROADMAP §3), and the secrets
// inventory (types/infra.ts SECRETS / 10 §4) — and the CI gate must actually
// run every verify suite that exists, rather than a subset someone forgot to
// re-wire. All four of those are things a human eye slides straight past.
//
// This does NOT introduce a phase exit criterion: P0's definition of done is
// still "ci.yml green" (12-ROADMAP §5). It is a check *inside* that gate, in
// the same role verify-infra.mjs plays for the workflow YAML.
//
// Deps: yaml (root devDependency). Run: `pnpm run verify:workspace`.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ROOT, repoPath, readRepo } from './repo.mjs';

// ---------------------------------------------------------------------------
// Load the world once. Every check reads from this object so the negative
// battery can re-run the whole suite against a mutated copy (verify-roadmap.mjs
// idiom — a check that cannot be made to fail is not a check).
// ---------------------------------------------------------------------------

const WORKSPACE_ROOTS = ['packages', 'apps'];
/** Non-secret configuration keys .env.example is allowed to carry beyond SECRETS. */
const NON_SECRET_ENV = new Set(['APP_ENV', 'WEB_ORIGIN', 'PORT']);

function discoverMembers() {
  const out = {};
  for (const base of WORKSPACE_ROOTS) {
    const dir = repoPath(base);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = `${base}/${entry.name}`;
      if (!existsSync(repoPath(rel, 'package.json'))) continue;
      out[rel] = JSON.parse(readRepo(`${rel}/package.json`));
    }
  }
  return out;
}

/** Repo-relative paths whose existence the checks depend on. */
function existenceOracle(members) {
  const paths = new Set(['tsconfig.base.json', 'tsconfig.json', 'turbo.json', 'pnpm-workspace.yaml', '.env.example']);
  for (const [dir, pkg] of Object.entries(members)) {
    paths.add(`${dir}/README.md`);
    paths.add(`${dir}/src/index.ts`);
    paths.add(`${dir}/tsconfig.json`);
    if (pkg.physics?.contract) paths.add(pkg.physics.contract);
  }
  return new Set([...paths].filter((p) => existsSync(repoPath(p))));
}

function loadWorld() {
  const members = discoverMembers();
  const toolFiles = readdirSync(repoPath('tools'))
    .filter((f) => /^verify-.*\.mjs$/.test(f))
    .sort();
  return {
    rootPkg: JSON.parse(readRepo('package.json')),
    globs: parseYaml(readRepo('pnpm-workspace.yaml'))?.packages ?? [],
    turbo: JSON.parse(readRepo('turbo.json')),
    members,
    tsconfigs: Object.fromEntries(
      Object.keys(members).map((d) => [d, JSON.parse(readRepo(`${d}/tsconfig.json`))]),
    ),
    exists: existenceOracle(members),
    envExample: readRepo('.env.example'),
    infraSrc: readRepo('types/infra.ts'),
    ci: readRepo('.github/workflows/ci.yml'),
    roadmap: readRepo('docs/12-ROADMAP.md'),
    gitignore: readRepo('.gitignore'),
    toolFiles,
  };
}

// ---------------------------------------------------------------------------
// Parsers over the source-of-truth documents.
// ---------------------------------------------------------------------------

/** Slice a markdown section by its `## N.` heading up to the next `## `. */
function section(md, headingRe) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break; }
  return lines.slice(start, end).join('\n');
}

/**
 * 12-ROADMAP §3 phase table → { 'packages/engine': 'P2', ... }.
 * A package belongs to the *first* phase row that names it (later rows extend
 * an existing package: P6 adds /ai routes to apps/api, P7 adds community to it).
 */
function roadmapPhases(roadmap) {
  const sec = section(roadmap, /^## 3\. /);
  const phases = {};
  const noted = new Set();
  for (const line of sec.split('\n')) {
    const paths = [...new Set([...line.matchAll(/(?:packages|apps)\/[a-z][a-z-]*/g)].map((m) => m[0]))];
    if (!paths.length) continue;
    const row = line.match(/^\|\s*\*\*(P\d)\*\*/);
    for (const p of paths) {
      if (row) { if (!(p in phases)) phases[p] = row[1]; }
      else noted.add(p);
    }
  }
  return { phases, noted };
}

/** types/infra.ts `export const SECRETS = { ... }` → the key names. */
function secretNames(infraSrc) {
  const m = infraSrc.match(/export const SECRETS = \{([\s\S]*?)\n\} as const/);
  if (!m) return null;
  return new Set([...m[1].matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)].map((x) => x[1]));
}

/** `.env.example` → [{ key, value }] for every KEY=VALUE line. */
function envEntries(text) {
  return text
    .split('\n')
    .map((l) => l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/))
    .filter(Boolean)
    .map((m) => ({ key: m[1], value: m[2].trim() }));
}

/**
 * Every command a workflow actually runs, with `${{ matrix.key }}` expanded
 * against each job's strategy matrix — the check has to read the workflow the
 * way GitHub does, or a matrixed job looks like it runs nothing.
 */
function workflowCommands(workflowText) {
  const wf = parseYaml(workflowText);
  const out = [];
  for (const job of Object.values(wf?.jobs ?? {})) {
    const matrix = job.strategy?.matrix ?? {};
    for (const step of job.steps ?? []) {
      const run = typeof step.run === 'string' ? step.run : null;
      if (!run) continue;
      let variants = [run];
      for (const [key, values] of Object.entries(matrix)) {
        if (!Array.isArray(values)) continue;
        const re = new RegExp(`\\$\\{\\{\\s*matrix\\.${key}\\s*\\}\\}`, 'g');
        variants = variants.flatMap((v) => (re.test(v) ? values.map((val) => v.replace(re, String(val))) : [v]));
      }
      out.push(...variants);
    }
  }
  return out.join('\n');
}

/**
 * npm scripts a workflow reaches, following `pnpm run X` through the root
 * package.json transitively — so wiring the aggregate `pnpm run ci` counts as
 * running everything it calls, and nothing has to be listed twice.
 */
function reachableScripts(workflowText, scripts) {
  const named = (t) => [...t.matchAll(/pnpm (?:run )?([a-z][a-z0-9:-]*)/g)].map((m) => m[1]);
  const seen = new Set();
  const queue = named(workflowCommands(workflowText)).filter((s) => s in scripts);
  while (queue.length) {
    const s = queue.shift();
    if (seen.has(s)) continue;
    seen.add(s);
    for (const next of named(scripts[s] ?? '')) if (next in scripts && !seen.has(next)) queue.push(next);
  }
  return seen;
}

// ---------------------------------------------------------------------------
// The checks.
// ---------------------------------------------------------------------------

function runChecks(w, log) {
  let fails = 0;
  const A = (cond, msg) => {
    if (cond) { if (log) console.log(`  ok   ${msg}`); }
    else { if (log) console.log(`  FAIL ${msg}`); fails++; }
  };
  const H = (h) => { if (log) console.log(`\n${h}`); };
  const has = (p) => w.exists.has(p);

  // -- A. Workspace shape ---------------------------------------------------
  H('A. Workspace shape');
  const memberDirs = Object.keys(w.members).sort();
  const globMatches = (glob, dir) => {
    const [gBase, gLeaf] = glob.split('/');
    const [dBase] = dir.split('/');
    return gBase === dBase && gLeaf === '*';
  };
  const uncovered = memberDirs.filter((d) => !w.globs.some((g) => globMatches(g, d)));
  A(uncovered.length === 0, `every workspace member is covered by a pnpm-workspace glob (uncovered: ${uncovered.join(', ') || 'none'})`);
  const emptyGlobs = w.globs.filter((g) => !memberDirs.some((d) => globMatches(g, d)));
  A(emptyGlobs.length === 0, `every pnpm-workspace glob matches at least one member (empty: ${emptyGlobs.join(', ') || 'none'})`);
  A(w.rootPkg.private === true, 'root package.json is private (never publishable)');
  A(/^pnpm@\d+\.\d+\.\d+$/.test(w.rootPkg.packageManager ?? ''), `root pins a pnpm version (packageManager: ${w.rootPkg.packageManager})`);

  // The CI matrix runs the oldest supported Node; engines must not exclude it.
  const ciNodes = [...(w.infraSrc.match(/CI_NODE_VERSIONS\s*=\s*\[([^\]]*)\]/)?.[1] ?? '').matchAll(/'(\d+)'/g)].map((m) => Number(m[1]));
  const engineMin = Number((w.rootPkg.engines?.node ?? '').match(/>=\s*(\d+)/)?.[1] ?? NaN);
  A(ciNodes.length > 0 && engineMin <= Math.min(...ciNodes), `engines.node (${w.rootPkg.engines?.node}) admits every CI_NODE_VERSIONS entry (${ciNodes.join(', ')})`);

  // -- B. Members match the roadmap phase table -----------------------------
  H('B. Skeleton ↔ 12-ROADMAP §3 phase table');
  const { phases, noted } = roadmapPhases(w.roadmap);
  const wanted = [...new Set([...Object.keys(phases), ...noted])].sort();
  const missing = wanted.filter((p) => !memberDirs.includes(p));
  const extra = memberDirs.filter((p) => !wanted.includes(p));
  A(wanted.length > 0, `§3 names ${wanted.length} package(s)/app(s)`);
  A(missing.length === 0, `every package the roadmap names exists in the workspace (missing: ${missing.join(', ') || 'none'})`);
  A(extra.length === 0, `no workspace member is absent from the roadmap (extra: ${extra.join(', ') || 'none'})`);

  for (const dir of memberDirs) {
    const pkg = w.members[dir];
    const leaf = dir.split('/')[1];
    A(pkg.name === `@physics/${leaf}`, `${dir}: name is @physics/${leaf} (got ${pkg.name})`);
    A(pkg.private === true, `${dir}: private`);
    const declared = pkg.physics?.phase;
    if (dir in phases) {
      A(declared === phases[dir], `${dir}: declares phase ${phases[dir]} (got ${declared})`);
    } else {
      // The one documented exception: shared owns no surface and is not a phase.
      A(declared === 'P0', `${dir}: not a §3 phase row, declares P0 (got ${declared})`);
      A(/is not a phase/.test(section(w.roadmap, /^## 3\. /)), `${dir}: §3 notes explain why it is not a phase`);
    }
    A(!!pkg.physics?.contract && has(pkg.physics.contract), `${dir}: contract ${pkg.physics?.contract} exists`);
    A(has(`${dir}/README.md`), `${dir}: has a README naming its spec + phase`);
    A(has(`${dir}/src/index.ts`), `${dir}: has src/index.ts (tsc needs an input)`);
    const ext = w.tsconfigs[dir]?.extends ?? '';
    A(/tsconfig\.base\.json$/.test(ext) && has('tsconfig.base.json'), `${dir}: tsconfig extends the shared base (got ${ext || 'nothing'})`);
    A(typeof pkg.scripts?.typecheck === 'string', `${dir}: declares a typecheck script for turbo`);
  }
  A(typeof w.turbo.tasks?.typecheck === 'object', 'turbo.json defines the typecheck task the members implement');

  // -- C. Secrets / env plumbing (10 §4) ------------------------------------
  H('C. Secrets & env plumbing');
  const secrets = secretNames(w.infraSrc);
  const entries = envEntries(w.envExample);
  const envKeys = new Set(entries.map((e) => e.key));
  A(secrets !== null && secrets.size > 0, `types/infra.ts SECRETS parsed (${secrets ? [...secrets].length : 0} names)`);
  if (secrets) {
    const notInEnv = [...secrets].filter((k) => !envKeys.has(k));
    const notInSecrets = [...envKeys].filter((k) => !secrets.has(k) && !NON_SECRET_ENV.has(k));
    A(notInEnv.length === 0, `every SECRETS name is in .env.example (missing: ${notInEnv.join(', ') || 'none'})`);
    A(notInSecrets.length === 0, `.env.example declares no unknown secret (stray: ${notInSecrets.join(', ') || 'none'})`);
  }
  const withValues = entries.filter((e) => e.value !== '');
  A(withValues.length === 0, `no value is committed in .env.example (non-empty: ${withValues.map((e) => e.key).join(', ') || 'none'})`);
  A(/^\.env$/m.test(w.gitignore) && /^!\.env\.example$/m.test(w.gitignore), '.gitignore ignores .env but keeps .env.example');
  A(/^node_modules\/?$/m.test(w.gitignore), '.gitignore ignores node_modules');

  // -- D. The gate actually runs every suite --------------------------------
  H('D. ci.yml runs every verify suite that exists');
  const scripts = w.rootPkg.scripts ?? {};
  const reached = reachableScripts(w.ci, scripts);
  for (const file of w.toolFiles) {
    const scriptName = `verify:${file.replace(/^verify-|\.mjs$/g, '')}`;
    const declared = typeof scripts[scriptName] === 'string' && scripts[scriptName].includes(`tools/${file}`);
    A(declared, `tools/${file} has a root script (${scriptName})`);
    A(declared && reached.has(scriptName), `ci.yml reaches ${scriptName}`);
  }
  A(reached.has('typecheck'), 'ci.yml reaches the typecheck script');
  // P0 regression guard: the shipped M9 ci.yml called bare `tsc --strict ...`
  // with no target/lib, which fails on ES2016+ builtins. Typechecking must go
  // through a tsconfig so every surface inherits the same compiler options.
  const bareTsc = /tsc(?![\w-])(?![^\n]*(?:-p |--project|-b ))[^\n]*--strict/.test(workflowCommands(w.ci));
  A(!bareTsc, 'ci.yml never invokes tsc without a project (target/lib come from tsconfig.base.json)');

  return fails;
}

// ---------------------------------------------------------------------------
// Run: positives, then a negative battery that must all bite.
// ---------------------------------------------------------------------------

const world = loadWorld();
console.log(`verify-workspace — ${Object.keys(world.members).length} workspace members under ${ROOT}`);
const positiveFails = runChecks(world, true);

const clone = (w) => ({
  ...structuredClone({ ...w, exists: [...w.exists] }),
  exists: new Set(w.exists),
});
const NEGATIVES = [
  ['drop apps/* from the workspace globs', (w) => { w.globs = w.globs.filter((g) => !g.startsWith('apps/')); }],
  ['point a package at a contract doc that does not exist', (w) => { w.members['packages/ai'].physics.contract = 'docs/99-PHANTOM.md'; }],
  ['claim the engine lands in a different phase', (w) => { w.members['packages/engine'].physics.phase = 'P7'; }],
  ['add a secret to infra.ts but not to .env.example', (w) => { w.infraSrc = w.infraSrc.replace('export const SECRETS = {', 'export const SECRETS = {\n  STRIPE_SECRET_KEY: { scope: \'server-only\', rotationDays: 90, by: \'D27\' },'); }],
  ['commit a value into .env.example', (w) => { w.envExample = w.envExample.replace('SESSION_SECRET=', 'SESSION_SECRET=hunter2'); }],
  ['unwire the verify suites from ci.yml', (w) => { w.ci = w.ci.replace(/pnpm (?:run )?(?:ci|verify)[a-z:-]*/g, 'true'); }],
  ['regress ci.yml to a bare `tsc --strict` typecheck', (w) => { w.ci = w.ci.replace(/pnpm run typecheck/, 'npx tsc --strict --noEmit types/*.ts'); }],
];

console.log('\nnegative battery (each mutation must be caught):');
let bit = 0;
for (const [name, mutate] of NEGATIVES) {
  const w = clone(world);
  mutate(w);
  const f = runChecks(w, false);
  if (f > 0) { bit++; console.log(`  ok   bites: ${name} (${f} failure(s))`); }
  else console.log(`  FAIL silent: ${name}`);
}

console.log('\n' + '-'.repeat(40));
console.log(`positive failures: ${positiveFails}`);
console.log(`negative battery : ${bit}/${NEGATIVES.length} bit`);
const green = positiveFails === 0 && bit === NEGATIVES.length;
console.log(`verify-workspace: ${green ? 'GREEN' : 'RED'}`);
process.exitCode = green ? 0 : 1;
