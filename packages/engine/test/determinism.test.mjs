// P2b companion check — the 03 §12 determinism properties, in-process.
//
// The golden matrix (tools/golden-node.mjs) proves that *these* hashes are the
// same on another machine. It cannot prove that they are the same on the same
// machine for the right reasons — a run that is nondeterministic in a way that
// happens to be stable within one process would pass the matrix and fail in
// production. The four properties below are the ones §12 names for that job:
// double-run identity, snapshot equivalence, the DET-4 round trip, and the
// command-boundary invariant that pacing never leaks into state.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createSimCore } from '../dist/src/index.js';

const CORPUS = JSON.parse(readFileSync(new URL('../goldens/corpus.json', import.meta.url), 'utf8'));

/** The quick half of the corpus. The heavy scenes are the golden runner's job. */
const QUICK = ['minimal-chain', 'mechanism-showcase', 'catalog', 'pulley-lift', 'gear-chain', 'all-fields'];

function scene(name) {
  return JSON.parse(readFileSync(new URL(`../goldens/scenes/${name}.json`, import.meta.url), 'utf8'));
}

/** Run a scene, sampling the state hash every `every` steps. */
async function trace(doc, steps, every = 60) {
  const sim = await createSimCore();
  sim.load(doc);
  const out = [];
  while (sim.stepIndex < steps && sim.finished === null) {
    sim.advance(Math.min(every, steps - sim.stepIndex));
    out.push(`${sim.stepIndex}:${sim.hash()}`);
  }
  return out;
}

test('every corpus scene is in the run plan and loads', async () => {
  assert.equal(CORPUS.scenes.length, 8);
  for (const entry of CORPUS.scenes) {
    const sim = await createSimCore();
    const load = sim.load(scene(entry.name));
    assert.ok(load.bodyCount > 0, `${entry.name} expands to at least one dynamic body`);
    assert.equal(load.registry.length, load.bodyCount, `${entry.name} registry covers every slot`);
  }
});

test('double-run identity: two runs of the same scene agree at every checkpoint', async () => {
  for (const name of QUICK) {
    const doc = scene(name);
    const a = await trace(doc, 1200);
    const b = await trace(doc, 1200);
    assert.deepEqual(a, b, `${name} is not reproducible within one process`);
  }
});

test('snapshot equivalence: 600 + snapshot + 600 equals a straight 1200 (§11)', async () => {
  for (const name of QUICK) {
    const doc = scene(name);

    const split = await createSimCore();
    split.load(doc);
    split.advance(600);
    split.restore(split.snapshot());
    split.advance(600);

    const straight = await createSimCore();
    straight.load(doc);
    straight.advance(1200);

    assert.equal(split.stepIndex, straight.stepIndex, `${name} step index diverged across a snapshot`);
    assert.equal(split.hash(), straight.hash(), `${name} state diverged across a snapshot`);
    // The report is state too: an accumulator left out of ExtraState shows up
    // here and nowhere in the position hash.
    assert.deepEqual(split.report(), straight.report(), `${name} analytics diverged across a snapshot`);
  }
});

test('reset restores the step-0 bundle, and the rerun is identical (§5.2, §11)', async () => {
  for (const name of QUICK) {
    const doc = scene(name);
    const sim = await createSimCore();
    sim.load(doc);
    const atLoad = sim.hash();

    sim.advance(400);
    sim.reset();
    assert.equal(sim.stepIndex, 0, `${name} reset did not rewind the step index`);
    assert.equal(sim.hash(), atLoad, `${name} reset did not restore the step-0 state`);

    sim.advance(600);
    const fresh = await createSimCore();
    fresh.load(doc);
    fresh.advance(600);
    assert.equal(sim.hash(), fresh.hash(), `${name} diverged after a reset`);
    assert.deepEqual(sim.report(), fresh.report(), `${name} analytics diverged after a reset`);
  }
});

test('DET-4 round trip: serialize + parse changes nothing', async () => {
  for (const name of QUICK) {
    const doc = scene(name);
    const round = JSON.parse(JSON.stringify(doc));
    assert.deepEqual(await trace(doc, 900), await trace(round, 900), `${name} is not round-trip stable`);
  }
});

test('DET-4 round trip survives a writer that re-emits at 4 digits', async () => {
  // The property §12 actually needs: a document that has been through a writer
  // obeying 02 §2's 4-digit rule expands to the same run. Simulated here by
  // rounding every number in the document, which is what `quantize` does on the
  // way in — so if the reader ever stopped quantizing, this test fails while the
  // plain JSON round trip above still passes.
  const round4 = (v) =>
    typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : Array.isArray(v) ? v.map(round4) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round4(x)])) : v;
  for (const name of QUICK) {
    const doc = scene(name);
    assert.deepEqual(await trace(doc, 900), await trace(round4(doc), 900), `${name} is not 4-digit stable`);
  }
});

test('DET-1/DET-8: how a run is chopped into advance() calls never changes it', async () => {
  // The command-boundary test from §12. Pacing decides *when* steps happen — a
  // slow frame runs five at once, a fast one runs zero — and DET-1 says that can
  // never change *what* they compute. Chopping the same 900 steps into ragged
  // batches is that property, minus the wall clock the worker shell owns.
  const chops = [
    [900],
    [1, 899],
    [5, 5, 5, 5, 880],
    [300, 1, 299, 1, 299],
    Array.from({ length: 180 }, () => 5),
  ];
  for (const name of QUICK) {
    const doc = scene(name);
    let expected = null;
    for (const chop of chops) {
      const sim = await createSimCore();
      sim.load(doc);
      for (const n of chop) sim.advance(n);
      const got = `${sim.stepIndex}:${sim.hash()}:${sim.finished}`;
      if (expected === null) expected = got;
      else assert.equal(got, expected, `${name} depends on how its steps were batched`);
    }
  }
});

test('the run is a pure function of the document, not of load order', async () => {
  // Two cores built from the same document in the same process must not share
  // anything. Interleaving their steps is the sharpest form of that: any module
  // state — a cached world, a stray accumulator — shows up immediately.
  const doc = scene('catalog');
  const a = await createSimCore();
  const b = await createSimCore();
  a.load(doc);
  b.load(doc);
  for (let i = 0; i < 20; i++) {
    a.advance(30);
    b.advance(30);
    assert.equal(a.hash(), b.hash(), `interleaved cores diverged at step ${a.stepIndex}`);
  }
});
