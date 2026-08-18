#!/usr/bin/env node
// verify-engine.mjs — the P2 check.
//
// P2's deliverable is *determinism*, so its quality bar is that the properties
// determinism rests on are machine-checked rather than reviewed. The package's
// node:test suites cover behaviour inside one process; this covers the four
// things a unit test structurally cannot:
//
//   A. **Discipline.** DET-5 bans the unspecified `Math` transcendentals in
//      this package and 03 §1 bans the environment. A test cannot notice that
//      someone added `Math.sin` to a new file — only a scan of the source can.
//   B. **Cross-engine identity.** The whole point of dmath is producing the
//      same bits on a *different* engine, which is unobservable from inside
//      one. This runs tools/dmath-digest.mjs under Node (V8) and, when the
//      binary is there, under JavaScriptCore — the WebKit leg of the browser
//      triple — and holds both to the committed golden.
//   C. **Correspondence with 03.** Every engine constant is normative prose
//      somewhere in the spec, and the two drift silently.
//   D. **Vocabulary closure.** The pieces geometry emits must be the pieces the
//      protocol declares, or the renderer indexes a body slot that is not there.
//   G. **Golden integrity** (P2b). The corpus on disk, the run plan and the
//      committed hashes have to describe the same eight scenes, every one of
//      them has to pass the *shared* validation gate, and the whole lot has to
//      be keyed to the physics build that is actually installed. A golden the
//      matrix compares against a scene nobody runs is worse than no golden.
//   H. **The U10 assumption** (P2b). `gear.maxTorque` and `piston.force` are
//      enforced by our own P4 solver because rapier.js exposes no motor force
//      cap. That is a fact about a pinned dependency, and pinned dependencies
//      get bumped — so it is asserted rather than remembered.
//   I. **The browser leg** (P2c). The §5.4 buffer layout is a wire format shared
//      by two threads and pinned by prose, so it gets the same constants-↔-spec
//      treatment as §6's dimensions. And the leg itself has to stay wired:
//      `determinism-matrix.yml` shipped for two phases with `echo` where its
//      golden runs belong (U26), which is precisely the failure mode a green
//      build cannot show you. The harness must also keep driving the browser by
//      `stepN` — driving by `play` would make the number of steps a property of
//      the CI runner's load rather than of the run plan.
//
// This does NOT introduce a phase exit criterion: P2's definition of done is
// still `determinism-matrix.yml` green with real golden hashes (12-ROADMAP §5).
// It is a check *inside* ci.yml, the role verify-scene.mjs plays for the format.
//
// Zero dependencies. Run: `pnpm run verify:engine` (builds the package first —
// the digest probe runs the emitted JS, because that is what ships).

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { ROOT, readRepo, readRepoJson, repoPath } from './repo.mjs';

const DIST = repoPath('packages/engine/dist/src/index.js');
if (!existsSync(DIST)) {
  console.error(
    'packages/engine is not built — the cross-engine probe runs the emitted JS.\n' +
      'Run: pnpm run build   (or pnpm run verify:engine, which builds first)',
  );
  process.exit(2);
}
const engine = await import(new URL(`file://${DIST}`).href);
// The catalog itself belongs to the format package — the engine must expand
// exactly the types the format defines, not a list of its own.
const format = await import(new URL(`file://${repoPath('packages/scene-format/dist/src/index.js')}`).href);

/**
 * The pinned build's joint typings. Read as text rather than probed at runtime:
 * the question is what the *binding* offers, and a `.d.ts` answers it without
 * instantiating a world.
 */
const RAPIER_JOINT_DTS =
  'packages/engine/node_modules/@dimforge/rapier2d-deterministic-compat/dynamics/impulse_joint.d.ts';

/** macOS ships the JavaScriptCore shell; Linux CI does not. Absence is not a failure. */
const JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc';

// ---------------------------------------------------------------------------
// Source scanning
// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Strip comments and string bodies so the lint reads code, not prose.
 *
 * dmath.ts's own header discusses `Math.sin` at length — that is documentation
 * of why the ban exists, and a lint that cannot tell the difference would force
 * the explanation out of the file that needs it most.
 */
function stripNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
      i++;
      out += '""';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * The `Math` members ECMA-262 pins to an exact result. Everything else is
 * "implementation-approximated" and therefore banned here (DET-5). This is an
 * allow-list on purpose: a member added to the language later is banned until
 * someone establishes that it is exact.
 */
const EXACT_MATH = new Set([
  'abs', 'ceil', 'clz32', 'floor', 'fround', 'imul', 'max', 'min', 'round', 'sign', 'sqrt', 'trunc', 'PI',
]);

/** Ambient state a deterministic core may not read (03 §1 rule 1). */
const BANNED_GLOBALS = [
  'Date', 'performance', 'setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame',
  'document', 'window', 'localStorage', 'sessionStorage', 'fetch', 'XMLHttpRequest', 'navigator', 'process',
];

/**
 * Locale-sensitive APIs, banned across the whole package. DET-3 orders by byte;
 * `localeCompare` orders by locale, which is the same answer on the developer's
 * machine and a different one on a CI runner with a different ICU build.
 */
const BANNED_LOCALE = ['localeCompare', 'toLocaleString', 'toLocaleDateString', 'Intl'];

/**
 * 03 §1: "Only worker.ts/transport.ts know about the browser." Those two files
 * are the shell; everything else — all of sim/ — is environment-free.
 */
const SHELL_FILES = new Set(['src/worker.ts', 'src/transport.ts']);

function lintFindings(srcFiles) {
  const findings = [];
  for (const [rel, text] of Object.entries(srcFiles)) {
    const code = stripNonCode(text);
    for (const m of code.matchAll(/\bMath\.([A-Za-z0-9_]+)/g)) {
      if (!EXACT_MATH.has(m[1])) findings.push({ rel, what: `Math.${m[1]}`, why: 'DET-5: not an exactly-specified operation' });
    }
    for (const name of BANNED_LOCALE) {
      if (new RegExp(`\\b${name}\\b`).test(code)) findings.push({ rel, what: name, why: 'DET-3: locale-sensitive' });
    }
    if (SHELL_FILES.has(rel)) continue;
    for (const name of BANNED_GLOBALS) {
      if (new RegExp(`\\b${name}\\b`).test(code)) findings.push({ rel, what: name, why: '03 §1: SimCore is environment-free' });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Constant ↔ spec correspondence
// ---------------------------------------------------------------------------

/** Escape a number for a regex, tolerating the doc's Unicode minus. */
const numRe = (v) => String(v).replace('-', '[-−]').replace('.', '\\.');

/**
 * Each engine constant, and the prose in 03 that fixes it. The pattern is built
 * from the *code's* value, so changing one side without the other fails — which
 * is the only reason a table like this earns its keep.
 */
const SIM_IN_SPEC = {
  DT: (v) => (v === 1 / 60 ? /dt = 1\/60/ : null),
  HARD_CAP_S: (v) => new RegExp(`HARD_CAP_S = ${numRe(v)}`),
  MAX_CATCHUP_STEPS: (v) => new RegExp(`MAX_CATCHUP = ${numRe(v)}`),
  REMOVAL_SWEEP_STEPS: (v) => new RegExp(`Every ${numRe(v)} steps`),
  REMOVAL_MARGIN_M: (v) => new RegExp(`inflated by ${numRe(v)} m`),
  MAX_DYNAMIC_BODIES: (v) => new RegExp(`MAX_DYNAMIC_BODIES = ${numRe(v)}`),
  CUSTOM_SOLVER_ITERATIONS: (v) => new RegExp(`CUSTOM_SOLVER_ITERATIONS = ${numRe(v)}`),
  FIELD_WAKE_FACTOR: (v) => new RegExp(`FIELD_WAKE_FACTOR = ${numRe(v)}`),
  MAGNET_REF_DIST: (v) => new RegExp(`MAGNET_REF_DIST = ${numRe(v)} m`),
  CONVEYOR_MAX_ACCEL: (v) => new RegExp(`CONVEYOR_MAX_ACCEL = ${numRe(v)}`),
  ROPE_BIAS_BETA: (v) => new RegExp(`ROPE_BIAS_BETA = ${numRe(v)}`),
  ROPE_SLOP: (v) => new RegExp(`ROPE_SLOP = ${numRe(v)}`),
  V_ACT: (v) => new RegExp(`V_ACT = ${numRe(v)} m/s`),
  // Stored in radians, specified in degrees — the conversion is the check.
  W_ACT: (v) => (Math.abs(v - (10 * Math.PI) / 180) < 1e-18 ? /W_ACT = 10 °\/s/ : null),
  CHAIN_WINDOW_STEPS: (v) => new RegExp(`CHAIN_WINDOW = ${numRe(v)}`),
  IDLE_WINDOW_S: (v) => new RegExp(`IDLE_WINDOW_S = ${numRe(v)}`),
  MAX_SFX_EVENTS_PER_BATCH: (v) => new RegExp(`capped at ${numRe(v)} per batch`),
};

/**
 * The §5.4 shared-buffer layout. This one is a *wire format*: the worker writes
 * it and the renderer reads it, in two threads that were compiled at different
 * times in the future (a cached page against a new worker). Every number below
 * is therefore prose first and code second.
 */
const SAB_IN_SPEC = {
  MAGIC: (v) => (String.fromCharCode((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff) === 'SIM1' ? /MAGIC "SIM1"/ : null),
  LAYOUT_VERSION: (v) => new RegExp(`layoutVersion = ${numRe(v)}`),
  HEADER_WORDS: (v) => new RegExp(`Int32Array header \\(${numRe(v)} words`),
  SLOTS: (v) => new RegExp(`${numRe(v)} slots × bodyCount`),
  FLOATS_PER_BODY: (v) => new RegExp(`bodyCount × ${numRe(v)} floats`),
};

/**
 * Header word ↔ the label 03 §5.4's diagram gives it. Moving a word without
 * moving the prose is how one thread starts reading another's field.
 */
const SAB_HEADER_LABELS = {
  Magic: 'MAGIC',
  LayoutVersion: 'layoutVersion',
  BodyCount: 'bodyCount',
  WriteCounter: 'writeCounter',
  LatestStepIndex: 'latestStepIndex',
  SimStatus: 'simStatus',
  Flags: 'flags',
};

/** The §6 expansion table's fixed dimensions. Same construction. */
const EXPAND_IN_SPEC = {
  DOMINO_W_OVER_H: (v) => (v === 1 / 5 ? /\(h\/5\) × h/ : null),
  SPRING_BASE_H: (v) => new RegExp(`Fixed base cuboid \`w × ${numRe(v)}\``),
  SPRING_PLATE_H: (v) => new RegExp(`dynamic plate cuboid \`w × ${numRe(v)}\``),
  PISTON_BASE_H: (v) => new RegExp(`Fixed base cuboid \`w × ${numRe(v)}\``),
  PISTON_HEAD_H: (v) => new RegExp(`dynamic head cuboid \`w × ${numRe(v)}\``),
  PENDULUM_ARM_W: (v) => new RegExp(`arm cuboid \`${numRe(v)} × len\``),
  PENDULUM_ARM_DENSITY: (v) => new RegExp(`fixed density ${numRe(v)}`),
  ROPE_SEGMENT_RADIUS: (v) => new RegExp(`radius ${numRe(v)}`),
  ROPE_SEGMENT_DENSITY: (v) => new RegExp(`density ${numRe(v)}`),
  CURVE_DEG_PER_SEGMENT: (v) => new RegExp(`ceil\\(sweep_deg / ${numRe(v)}\\)`),
  CURVE_MIN_SEGMENTS: (v) => new RegExp(`N = max\\(${numRe(v)},`),
  CURVE_START_DEG: (v) => new RegExp(`start angle \\*\\*${numRe(v)}°\\*\\*`),
};

// ---------------------------------------------------------------------------
// Load the world once, so the negative battery can mutate a copy of it.
// ---------------------------------------------------------------------------

function runDigest(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    return `ERROR: ${err.message?.split('\n')[0] ?? String(err)}`;
  }
}

/** Every piece name the geometry table can emit, across the whole catalog. */
function producedPieces() {
  const pieces = new Set();
  for (const type of format.OBJECT_TYPES) {
    for (const props of [undefined, { arm: 'rope' }, { mode: 'triggered' }]) {
      let obj;
      try {
        obj = engine.canonicalize({
          schemaVersion: 1,
          engineVersion: '0.0.0',
          world: {},
          objects: [{ id: 'x', type, pos: [0, 0], ...(props ? { props } : {}) }],
        }).objects[0];
      } catch {
        continue; // props that do not apply to this type
      }
      try {
        for (const p of engine.objectGeometry(obj).pieces) pieces.add(p.piece);
      } catch {
        /* a type that rejects these props keeps its default expansion */
      }
    }
  }
  return pieces;
}

function loadWorld() {
  const srcDir = repoPath('packages/engine/src');
  const srcFiles = {};
  for (const abs of walk(srcDir)) srcFiles[abs.slice(repoPath('packages/engine').length + 1)] = readRepo(abs.slice(ROOT.length + 1));

  const rng = new engine.Pcg32(42, 54);

  // The corpus, the run plan and the committed hashes, plus whether each scene
  // survives the shared gate. Running the gate here — not a private copy of the
  // rules — is the point: a corpus scene the server would reject is not a
  // corpus scene.
  const corpus = readRepoJson('packages/engine/goldens/corpus.json');
  const sceneDir = repoPath('packages/engine/goldens/scenes');
  const sceneFiles = readdirSync(sceneDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
  const gate = {};
  for (const name of sceneFiles) {
    const text = readRepo(`packages/engine/goldens/scenes/${name}.json`);
    const result = format.validateScene(JSON.parse(text), { bytes: Buffer.byteLength(text) });
    gate[name] = result.ok ? 'ok' : result.code;
  }

  const enginePkg = readRepoJson('packages/engine/package.json');
  return {
    srcFiles,
    corpus,
    sceneFiles,
    gate,
    goldenState: readRepoJson('packages/engine/goldens/state.golden.json'),
    enginePkg,
    pinnedBuild: `${engine.PHYSICS_PACKAGE}@${enginePkg.dependencies[engine.PHYSICS_PACKAGE]}`,
    infraSrc: readRepo('types/infra.ts'),
    jointDts: readRepo(RAPIER_JOINT_DTS),
    doc03: readRepo('docs/03-SIMULATION-CORE.md'),
    procgenSrc: readRepo('types/procgen.ts'),
    golden: readRepoJson('packages/engine/goldens/dmath.golden.json'),
    digests: {
      v8: runDigest(process.execPath, ['tools/dmath-digest.mjs']),
      jsc: existsSync(JSC) ? runDigest(JSC, ['-m', 'tools/dmath-digest.mjs']) : null,
    },
    sim: { ...engine.SIM },
    sab: { ...engine.SAB },
    expand: { ...engine.EXPAND },
    engineVersionConst: engine.ENGINE_VERSION,
    matrixYml: readRepo('.github/workflows/determinism-matrix.yml'),
    driverSrc: readRepo('tools/browser/driver.js'),
    rootPkg: readRepoJson('package.json'),
    pieces: producedPieces(),
    pieceUnion: srcFiles['src/protocol.ts'] ?? '',
    indexSrc: srcFiles['src/index.ts'] ?? '',
    pcg: Array.from({ length: 6 }, () => rng.next()),
    goldenFileExists: existsSync(repoPath('packages/engine/goldens/dmath.golden.json')),
  };
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

  // -- A. DET-5 / environment discipline ------------------------------------
  H('A. Determinism discipline (DET-5, 03 §1)');
  const findings = lintFindings(w.srcFiles);
  A(
    findings.length === 0,
    `no banned API in packages/engine/src (${findings.map((f) => `${f.rel}: ${f.what} — ${f.why}`).join('; ') || 'clean'})`,
  );
  A(Object.keys(w.srcFiles).length > 0, `scanned ${Object.keys(w.srcFiles).length} source file(s)`);
  // The ban is only meaningful if the replacement is actually exported.
  for (const name of ['dsin', 'dcos', 'datan2', 'rotate']) {
    A(new RegExp(`export function ${name}\\b`).test(w.srcFiles['src/sim/dmath.ts'] ?? ''), `dmath exports ${name}`);
  }

  // -- B. Cross-engine identity ---------------------------------------------
  H('B. Cross-engine dmath golden (the DET-5 payoff)');
  A(w.goldenFileExists, 'packages/engine/goldens/dmath.golden.json is committed');
  A(/^[0-9a-f]{8}$/.test(w.golden.digest ?? ''), `golden digest is a 32-bit hex value (${w.golden.digest})`);
  A(w.digests.v8 === w.golden.digest, `V8 reproduces the golden digest (got ${w.digests.v8})`);
  if (w.digests.jsc === null) {
    if (log) {
      console.log('  --   JavaScriptCore not present on this host; the browser triple covers WebKit in CI at P2c');
    }
  } else {
    A(w.digests.jsc === w.golden.digest, `JavaScriptCore reproduces the golden digest (got ${w.digests.jsc})`);
    A(
      w.digests.jsc === w.digests.v8,
      `V8 and JavaScriptCore agree bit-for-bit across ${w.golden.sweep?.samples ?? '?'} samples`,
    );
  }

  // -- C. Constants ↔ 03 ----------------------------------------------------
  H('C. Engine constants ↔ 03 prose');
  const checkTable = (label, values, table) => {
    const undocumented = Object.keys(values).filter((k) => !(k in table));
    A(undocumented.length === 0, `${label}: every constant is mapped to spec prose (unmapped: ${undocumented.join(', ') || 'none'})`);
    for (const [key, pattern] of Object.entries(table)) {
      if (!(key in values)) { A(false, `${label}.${key} is mapped but no longer exists in the code`); continue; }
      const re = pattern(values[key]);
      A(re !== null && re.test(w.doc03), `${label}.${key} = ${values[key]} matches 03 (${re ?? 'value rejected'})`);
    }
  };
  checkTable('SIM', w.sim, SIM_IN_SPEC);
  checkTable('SAB', w.sab, SAB_IN_SPEC);
  checkTable('EXPAND', w.expand, EXPAND_IN_SPEC);

  // -- D. Piece vocabulary --------------------------------------------------
  H('D. Body pieces ↔ the protocol union');
  const declared = new Set(
    [...(w.pieceUnion.match(/export type BodyPiece =([\s\S]*?);/)?.[1] ?? '').matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]),
  );
  const undeclaredPieces = [...w.pieces].filter((p) => !declared.has(p));
  const unusedPieces = [...declared].filter((p) => !w.pieces.has(p));
  A(declared.size > 0, `protocol declares ${declared.size} named piece(s): ${[...declared].join(', ')}`);
  A(undeclaredPieces.length === 0, `every piece geometry emits is declared (stray: ${undeclaredPieces.join(', ') || 'none'})`);
  A(unusedPieces.length === 0, `every declared piece is emitted by some prefab (orphan: ${unusedPieces.join(', ') || 'none'})`);

  // -- E. Package surface ---------------------------------------------------
  H('E. Package surface');
  const modules = Object.keys(w.srcFiles).filter((f) => f !== 'src/index.ts');
  const unreachable = modules.filter((f) => {
    const spec = f.replace(/^src\//, './').replace(/\.ts$/, '.js');
    return !w.indexSrc.includes(spec);
  });
  A(unreachable.length === 0, `every src module is exported from index.ts (unreachable: ${unreachable.join(', ') || 'none'})`);

  // -- G. Golden corpus integrity (P2b) --------------------------------------
  H('G. Golden corpus (03 §12)');
  const planned = w.corpus.scenes.map((e) => e.name).sort();
  const goldened = Object.keys(w.goldenState.scenes ?? {}).sort();
  A(planned.length > 0, `the run plan names ${planned.length} scene(s)`);
  A(
    JSON.stringify(planned) === JSON.stringify(w.sceneFiles),
    `every planned scene exists on disk and vice versa (plan ${planned.join(', ')} / disk ${w.sceneFiles.join(', ')})`,
  );
  A(
    JSON.stringify(planned) === JSON.stringify(goldened),
    `every planned scene has a committed golden (goldens: ${goldened.join(', ')})`,
  );
  for (const name of w.sceneFiles) {
    A(w.gate[name] === 'ok', `${name} passes the shared validation gate (${w.gate[name]})`);
  }
  A(
    w.goldenState.steps === w.corpus.steps && w.goldenState.checkpointEvery === w.corpus.checkpointEvery,
    `the goldens were taken under the committed run plan (${w.goldenState.steps} steps, every ${w.goldenState.checkpointEvery})`,
  );
  A(
    w.goldenState.key?.engineVersion === w.enginePkg.version,
    `goldens are keyed to this engineVersion (${w.goldenState.key?.engineVersion} vs package ${w.enginePkg.version})`,
  );
  // The three-way pin, in the same spirit as D23's matrix pin: the version the
  // goldens were taken under, the version the lockfile installs, and the
  // ENGINE_BUILD constant the rest of the system keys caches and reports by.
  A(
    w.goldenState.key?.physicsBuild === w.pinnedBuild,
    `goldens are keyed to the installed physics build (${w.goldenState.key?.physicsBuild} vs ${w.pinnedBuild})`,
  );
  A(
    w.infraSrc.includes(`ENGINE_BUILD = '${w.pinnedBuild}'`),
    `types/infra.ts ENGINE_BUILD names the same build (${w.pinnedBuild})`,
  );
  A(
    !/[\^~]/.test(w.enginePkg.dependencies[engine.PHYSICS_PACKAGE] ?? '^'),
    `the physics build is exact-pinned, no range (D7: "${w.enginePkg.dependencies[engine.PHYSICS_PACKAGE]}")`,
  );

  // -- H. The U10 assumption (P2b) -------------------------------------------
  H('H. Motor force caps are still ours to enforce (U10)');
  const jointCode = stripNonCode(w.jointDts);
  const motorApi = [...jointCode.matchAll(/\bconfigureMotor[A-Za-z]*\b/g)].map((m) => m[0]);
  A(motorApi.length > 0, `the binding exposes a motor API (${[...new Set(motorApi)].join(', ')})`);
  A(
    !/maxForce|max_force|MaxForce|maxImpulse/.test(jointCode),
    'rapier.js still has no motor force cap, so 03 §14\'s fallback is still required ' +
      '(if this fails, the pinned build gained one: revisit U10 and constraints.ts)',
  );

  // -- I. The browser leg (P2c) ----------------------------------------------
  H('I. The browser leg of the matrix (P2c)');
  // The §5.4 header, word by word, against the diagram in the spec.
  const enumBlock = (w.pieceUnion.match(/export const enum SabHeader \{([\s\S]*?)\n\}/) ?? [])[1] ?? '';
  const headerWords = Object.fromEntries(
    [...enumBlock.matchAll(/(\w+) = (\d+)/g)].map((m) => [m[1], Number(m[2])]),
  );
  const specWords = Object.fromEntries(
    [...w.doc03.matchAll(/\[(\d+)\] ([A-Za-z]+)/g)].map((m) => [m[2], Number(m[1])]),
  );
  A(Object.keys(headerWords).length >= 7, `parsed the SabHeader enum (${Object.keys(headerWords).length} words)`);
  for (const [name, label] of Object.entries(SAB_HEADER_LABELS)) {
    A(
      headerWords[name] !== undefined && headerWords[name] === specWords[label],
      `SabHeader.${name} = ${headerWords[name]} is word [${specWords[label]}] "${label}" in 03 §5.4`,
    );
  }
  // The engine's own version, in the three places it is spelled.
  A(
    w.engineVersionConst === w.enginePkg.version,
    `ENGINE_VERSION (${w.engineVersionConst}) matches package.json (${w.enginePkg.version}) — the worker reports it in \`ready\``,
  );
  A(
    w.goldenState.key?.engineVersion === w.engineVersionConst,
    `the goldens are keyed to that same version (${w.goldenState.key?.engineVersion})`,
  );
  // 03 §1's package shape: exactly two files may know about the browser.
  for (const shell of SHELL_FILES) {
    A(shell in w.srcFiles, `${shell} exists (03 §1 names it as part of the package shape)`);
    A(new RegExp(`${shell.replace('src/', '')}`).test(w.doc03), `03 §1's tree still lists ${shell.replace('src/', '')}`);
  }
  // U26: the matrix legs must run something, and `echo` is not something.
  A(/run: pnpm run golden$/m.test(w.matrixYml), 'determinism-matrix runs the Node golden (node-golden)');
  A(/run: pnpm run golden:browser/.test(w.matrixYml), 'determinism-matrix runs the browser golden (browser-golden)');
  A(
    !/golden hashes[^\n]*\n\s*run: echo/.test(w.matrixYml),
    'no golden-hash step in the matrix is still an echo stub (U26)',
  );
  A(
    typeof w.rootPkg.scripts?.['golden:browser'] === 'string' &&
      w.rootPkg.scripts['golden:browser'].includes('tools/golden-browser.mjs'),
    'the golden:browser script the workflow calls exists',
  );
  // The browser leg must advance by command, not by clock.
  A(/cmd: 'stepN'/.test(w.driverSrc), 'the browser driver advances the run with stepN');
  A(
    !/cmd: 'play'/.test(w.driverSrc),
    'the browser driver never uses `play` — wall-clock pacing would make the step count a property of the runner (§5.5)',
  );

  // -- F. One PRNG across packages ------------------------------------------
  H('F. PCG32 ↔ types/procgen.ts (06 PG-2: "the same algorithm as DET-6")');
  const vector = [...(w.procgenSrc.match(/PCG32_TEST_VECTOR = \[([\s\S]*?)\]/)?.[1] ?? '').matchAll(/0x([0-9a-f]{8})/g)]
    .map((m) => parseInt(m[1], 16));
  A(vector.length === 6, `parsed the published test vector from types/procgen.ts (${vector.length} values)`);
  A(
    vector.length === 6 && vector.every((v, i) => v === w.pcg[i]),
    `the engine's PCG32 reproduces it (got ${w.pcg.map((v) => v.toString(16)).join(' ')})`,
  );

  return fails;
}

// ---------------------------------------------------------------------------
// Run: positives, then a negative battery that must all bite.
// ---------------------------------------------------------------------------

const world = loadWorld();
console.log(`verify-engine — packages/engine under ${ROOT}`);
console.log(`  engines probed: V8 ${process.version}${world.digests.jsc === null ? '' : ' + JavaScriptCore'}`);
const positiveFails = runChecks(world, true);

const clone = (w) => ({
  ...w,
  srcFiles: { ...w.srcFiles },
  sim: { ...w.sim },
  sab: { ...w.sab },
  rootPkg: { ...w.rootPkg, scripts: { ...w.rootPkg.scripts } },
  expand: { ...w.expand },
  golden: { ...w.golden },
  pieces: new Set(w.pieces),
  corpus: { ...w.corpus, scenes: [...w.corpus.scenes] },
  sceneFiles: [...w.sceneFiles],
  gate: { ...w.gate },
  goldenState: { ...w.goldenState },
  enginePkg: { ...w.enginePkg },
});

const NEGATIVES = [
  ['call Math.sin inside the simulation core', (w) => { w.srcFiles['src/sim/geometry.ts'] += '\nconst leak = Math.sin(1);\n'; }],
  ['read the clock inside the simulation core', (w) => { w.srcFiles['src/sim/canonical.ts'] += '\nconst t = Date.now();\n'; }],
  ['sort ids with localeCompare', (w) => { w.srcFiles['src/sim/canonical.ts'] += '\nconst c = "a".localeCompare("b");\n'; }],
  ['change the committed cross-engine digest', (w) => { w.golden = { ...w.golden, digest: 'deadbeef' }; }],
  ['move the spring plate without touching 03 §6', (w) => { w.expand.SPRING_PLATE_H = 0.017; }],
  ['shorten the hard run cap without touching 03 §9.2', (w) => { w.sim.HARD_CAP_S = 300; }],
  ['add an engine constant that no spec prose fixes', (w) => { w.sim.MYSTERY_FUDGE = 0.42; }],
  ['rename a body piece in the geometry table', (w) => { w.pieces = new Set([...w.pieces].map((p) => (p === 'plate' ? 'pad' : p))); }],
  ['stop exporting the geometry module from index.ts', (w) => { w.indexSrc = w.indexSrc.replace("export * from './sim/geometry.js';", ''); }],
  ['break the PRNG that procgen shares', (w) => { w.pcg = [...w.pcg.slice(0, 5), 0]; }],
  ['add a corpus scene with no committed golden', (w) => { w.sceneFiles = [...w.sceneFiles, 'zz-new'].sort(); w.gate = { ...w.gate, 'zz-new': 'ok' }; }],
  ['commit a corpus scene the shared validation gate rejects', (w) => { w.gate = { ...w.gate, catalog: 'E_SEMANTIC' }; }],
  ['upgrade the physics build without re-taking the goldens', (w) => { w.pinnedBuild = '@dimforge/rapier2d-deterministic-compat@0.20.0'; }],
  ['loosen the exact pin to a caret range', (w) => { w.enginePkg = { ...w.enginePkg, dependencies: { ...w.enginePkg.dependencies, '@dimforge/rapier2d-deterministic-compat': '^0.19.3' } }; w.pinnedBuild = '@dimforge/rapier2d-deterministic-compat@^0.19.3'; }],
  ['bump engineVersion while leaving the goldens keyed to the old one', (w) => { w.enginePkg = { ...w.enginePkg, version: '0.2.0' }; }],
  ['shorten the golden run without re-taking the hashes', (w) => { w.corpus = { ...w.corpus, steps: 600 }; }],
  ['let a Rapier upgrade quietly add a motor force cap', (w) => { w.jointDts += '\n  setMotorMaxForce(maxForce: number): void;\n'; }],
  ['shrink the triple buffer to two slots', (w) => { w.sab.SLOTS = 2; }],
  ['move the SAB write counter to another header word', (w) => { w.pieceUnion = w.pieceUnion.replace('WriteCounter = 3', 'WriteCounter = 7'); }],
  ['report an engineVersion the goldens are not keyed to', (w) => { w.engineVersionConst = '9.9.9'; }],
  ['leave the browser golden job stubbed with an echo', (w) => { w.matrixYml = w.matrixYml.replace('run: pnpm run golden:browser --browser=${{ matrix.browser }}', 'run: echo "same golden scenes in-browser"'); }],
  ['re-stub the node golden job', (w) => { w.matrixYml = w.matrixYml.replace(/run: pnpm run golden$/m, 'run: echo golden'); }],
  ['drive the browser leg by wall clock instead of by stepN', (w) => { w.driverSrc = w.driverSrc.replace("cmd: 'stepN', n: want", "cmd: 'play'"); }],
  ['delete the transport without telling 03 §1', (w) => { delete w.srcFiles['src/transport.ts']; }],
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
console.log(`verify-engine: ${green ? 'GREEN' : 'RED'}`);
process.exitCode = green ? 0 : 1;
