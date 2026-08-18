#!/usr/bin/env node
// golden-browser.mjs — the browser leg of determinism-matrix.yml (03 §12, P2c).
//
// The Node leg proved the corpus reproduces across ISAs. This one asks the
// harder half of U9: does the *same* engine, driven through the §5 worker
// protocol inside Chromium, Firefox and WebKit, produce the *same* numbers —
// and does the §5.4 shared buffer carry them faithfully? Those are the two
// things a Node run structurally cannot answer, and until they are answered P2
// is not done (12-ROADMAP §5).
//
// How it works, and why each piece is the way it is:
//
//   * **The page hashes what came out of the transport, not the world.** The
//     driver reads the published frame — the four floats per body §5.4 carries
//     — and runs the engine's own §12 hash over them. So a mismatch is either
//     physics or transport, and both are things the browser leg exists to test.
//     `packages/engine/test/transport.test.mjs` pins the other half of that
//     claim in Node: frame hash === live-body hash, over the whole corpus.
//   * **The run is driven by `stepN`, never `play`.** `play` advances by wall
//     clock (§5.5), so "how many steps happened" would be a property of the CI
//     runner's load. The command protocol has an exact-advance command for
//     exactly this reason.
//   * **Both transports are exercised.** The corpus runs cross-origin isolated
//     (COOP/COEP → SharedArrayBuffer, the primary path). A second, deliberately
//     un-isolated origin then re-runs a short subset over the postMessage
//     fallback, against the same goldens — §5.3 offers two transports, so two
//     transports have to agree.
//   * **The verdict is `tools/golden-compare.mjs`,** the same module the Node
//     leg uses. One rule for what agreement means.
//
// The one transformation between the two legs is the bundler: the browser half
// is bundled with esbuild because the shared validation gate depends on ajv,
// which is CommonJS, and module workers have no import maps. The WASM is not
// affected — D7 picked the `-compat` build precisely so the physics bytes are
// identical no matter what packs the JS around them, and the harness asserts
// the `ready` message reports the same build string the goldens are keyed to.
//
// Run:
//   pnpm run golden:browser                     all installed browsers
//   node tools/golden-browser.mjs --browser=webkit --scenes=minimal-chain

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { compareKey, compareScene } from './golden-compare.mjs';
import { readRepoJson, repoPath } from './repo.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const corpus = readRepoJson('packages/engine/goldens/corpus.json');
const golden = readRepoJson('packages/engine/goldens/state.golden.json');
const enginePkg = readRepoJson('packages/engine/package.json');
const PHYSICS_PACKAGE = '@dimforge/rapier2d-deterministic-compat';
const key = {
  engineVersion: enginePkg.version,
  physicsBuild: `${PHYSICS_PACKAGE}@${enginePkg.dependencies[PHYSICS_PACKAGE]}`,
};

const ALL_BROWSERS = ['chromium', 'firefox', 'webkit'];
const browsers = (flag('browser') ?? ALL_BROWSERS.join(',')).split(',').filter(Boolean);
const scenes = (flag('scenes') ?? corpus.scenes.map((s) => s.name).join(',')).split(',').filter(Boolean);
/** The fallback-transport subset: enough to prove agreement, short enough to be free. */
const FALLBACK_SCENES = ['minimal-chain', 'gear-chain'].filter((name) => scenes.includes(name));
const HEADED = args.includes('--headed');

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  console.error('esbuild is not installed — run `pnpm install`.');
  process.exit(2);
}

let playwright;
try {
  playwright = await import('playwright');
} catch {
  console.error('playwright is not installed — run `pnpm install`.');
  process.exit(2);
}

const OUT_DIR = repoPath('packages/engine/dist/browser');

/**
 * Bundle the worker entry and the package index for the page.
 *
 * No minification and no source transformation beyond module resolution: the
 * browser must run the same statements Node ran, and a mangled bundle would put
 * a transformation nobody reviewed between the two legs of the matrix.
 */
async function bundle() {
  await esbuild.build({
    entryPoints: {
      worker: repoPath('packages/engine/dist/src/worker.js'),
      engine: repoPath('packages/engine/dist/src/index.js'),
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: false,
    sourcemap: false,
    logLevel: 'warning',
    outdir: OUT_DIR,
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const SCENE_NAMES = new Set(corpus.scenes.map((s) => s.name));
const ROUTES = {
  '/': [repoPath('tools/browser/golden.html'), 'text/html; charset=utf-8'],
  '/driver.js': [repoPath('tools/browser/driver.js'), 'text/javascript; charset=utf-8'],
  '/worker.js': [`${OUT_DIR}/worker.js`, 'text/javascript; charset=utf-8'],
  '/engine.js': [`${OUT_DIR}/engine.js`, 'text/javascript; charset=utf-8'],
};

/**
 * A static server over an explicit route table — no path is ever derived from
 * the request, so there is no traversal to get wrong.
 *
 * `isolated` decides whether the document gets COOP/COEP, which is what decides
 * `crossOriginIsolated`, which is what decides whether the worker can build a
 * SharedArrayBuffer at all (§5.3). Two servers, two transports.
 */
function serve(isolated) {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const headers = { 'Cache-Control': 'no-store' };
    if (isolated) {
      headers['Cross-Origin-Opener-Policy'] = 'same-origin';
      headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
      headers['Cross-Origin-Resource-Policy'] = 'same-origin';
    }
    const scene = /^\/goldens\/scenes\/([a-z0-9-]+)\.json$/.exec(path);
    try {
      if (scene !== null && SCENE_NAMES.has(scene[1])) {
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
        res.end(readFileSync(repoPath(`packages/engine/goldens/scenes/${scene[1]}.json`)));
        return;
      }
      const route = ROUTES[path];
      if (route === undefined) {
        res.writeHead(404, headers).end('not found');
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Type': route[1] });
      res.end(readFileSync(route[0]));
    } catch (err) {
      res.writeHead(500, headers).end(String(err));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let fails = 0;
const A = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) fails++;
};

/** Drive one page through `__runGolden` and hand back what it measured. */
async function measure(browser, url, plan, label) {
  const page = await browser.newPage();
  page.on('console', (message) => console.log(`       · ${message.text()}`));
  page.on('pageerror', (err) => console.log(`       ! ${err.message}`));
  await page.goto(url, { waitUntil: 'load' });
  const started = Date.now();
  const measured = await page.evaluate((p) => window.__runGolden(p), plan);
  await page.close();
  console.log(`     ${label}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return measured;
}

await bundle();
const isolated = await serve(true);
const plain = await serve(false);

console.log(`golden-browser — ${key.engineVersion} / ${key.physicsBuild}`);
console.log(`  corpus: ${scenes.length} scene(s) × ${corpus.steps} steps, checkpoint every ${corpus.checkpointEvery}`);
console.log('');
for (const finding of compareKey(key, corpus, golden)) A(finding.ok, finding.msg);

for (const name of browsers) {
  const engine = playwright[name];
  if (engine === undefined) {
    A(false, `${name} is not a Playwright browser`);
    continue;
  }
  let browser;
  try {
    browser = await engine.launch({ headless: !HEADED });
  } catch (err) {
    console.error(`\n${name}: could not launch — ${String(err).split('\n')[0]}`);
    console.error('Install the browsers first: npx playwright install chromium firefox webkit');
    process.exit(2);
  }
  console.log(`\n=== ${name} ${browser.version()} ===`);

  const sab = await measure(
    browser,
    `http://127.0.0.1:${isolated.port}/`,
    { steps: corpus.steps, checkpointEvery: corpus.checkpointEvery, scenes },
    'shared-memory transport',
  );
  A(sab.crossOriginIsolated === true, `${name}: the page is cross-origin isolated`);
  A(sab.meta?.transport === 'sab', `${name}: the worker chose the shared-memory transport (${sab.meta?.transport})`);
  A(
    sab.meta?.engineVersion === key.engineVersion,
    `${name}: ready reports engineVersion ${sab.meta?.engineVersion}`,
  );
  A(sab.meta?.physicsBuild === key.physicsBuild, `${name}: ready reports ${sab.meta?.physicsBuild}`);
  for (const name2 of scenes) {
    console.log(`\n  ${name2}`);
    for (const finding of compareScene(sab.scenes[name2], golden.scenes[name2])) A(finding.ok, `  ${finding.msg}`);
  }

  if (FALLBACK_SCENES.length > 0) {
    const fallback = await measure(
      browser,
      `http://127.0.0.1:${plain.port}/`,
      { steps: corpus.steps, checkpointEvery: corpus.checkpointEvery, scenes: FALLBACK_SCENES },
      'postMessage fallback',
    );
    console.log(`\n  ${name}: postMessage fallback (no cross-origin isolation)`);
    A(fallback.crossOriginIsolated === false, `  the page is deliberately not isolated`);
    A(fallback.meta?.transport === 'postmessage', `  the worker fell back (${fallback.meta?.transport})`);
    for (const name2 of FALLBACK_SCENES) {
      for (const finding of compareScene(fallback.scenes[name2], golden.scenes[name2])) {
        A(finding.ok, `  ${name2}: ${finding.msg}`);
      }
    }
  }

  await browser.close();
}

isolated.server.close();
plain.server.close();

console.log(`\n${'-'.repeat(40)}`);
console.log(`browsers: ${browsers.join(', ')}`);
console.log(`failures: ${fails}`);
console.log(`golden-browser: ${fails === 0 ? 'GREEN' : 'RED'}`);
process.exitCode = fails === 0 ? 0 : 1;
