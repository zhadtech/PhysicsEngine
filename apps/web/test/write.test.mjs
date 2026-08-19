// P3a — the strict writer (02 §2, 04 §8.2, §10.1, §14).
//
// The headline case is the one 02 §2 spells out at length and that a writer
// built the obvious way gets wrong: quantization must be `Math.round(x·1e4)/1e4`
// and not `toFixed(4)`, because the two disagree on every negative value whose
// ×1e4 product lands on a .5 tie — and the *reader* (DET-4) uses Math.round. Get
// it backwards and `expand(scene) === expand(parse(serialize(scene)))`, the
// round-trip identity of 03 §12, quietly stops holding for negative
// coordinates, which is half the board.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SceneDoc, gateForTest, serializeScene, serializedBytes, writeScene } from '../dist/src/index.js';
import { canonicalize } from '@physics/engine/geometry';
import { fixtureScene } from './fixtures.mjs';

const write = (scene) => writeScene(SceneDoc.clone(scene));

test('quantization is Math.round, not toFixed — the negative-tie case', () => {
  const doc = SceneDoc.clone({
    schemaVersion: 1,
    engineVersion: '0.1.0',
    world: {},
    objects: [{ id: 'a', type: 'marble', pos: [-0.98765, 0.98765] }],
  });
  const out = writeScene(doc);
  assert.deepEqual(out.objects[0].pos, [-0.9876, 0.9877]);
  // toFixed would have produced -0.9877 for the same input.
  assert.notEqual(out.objects[0].pos[0], Number((-0.98765).toFixed(4)));
});

test('−0 is normalized to 0', () => {
  const doc = SceneDoc.clone({
    schemaVersion: 1,
    engineVersion: '0.1.0',
    world: {},
    objects: [{ id: 'a', type: 'marble', pos: [-0.000001, 0] }],
  });
  assert.equal(Object.is(writeScene(doc).objects[0].pos[0], 0), true);
});

test('defaults are omitted and non-defaults survive', () => {
  const out = write({
    schemaVersion: 1,
    engineVersion: '0.1.0',
    meta: { title: 'Untitled' },
    world: { gravity: 9.81, planeAngle: 0, seed: 1, bounds: [4, 2.4] },
    objects: [
      { id: 'p1', type: 'platform', pos: [0, 0], rot: 0, props: { w: 1, h: 0.05, friction: 0.5, restitution: 0 } },
      { id: 'p2', type: 'platform', pos: [0, 1], props: { w: 2, friction: 0 } },
      { id: 'd1', type: 'domino', pos: [0, 0], props: { h: 0.08, density: 6, anchored: true } },
    ],
  });
  assert.equal(out.meta, undefined, 'the default title is not written');
  assert.deepEqual(out.world, {}, 'a world of defaults writes as {}');
  assert.equal(out.objects[0].props, undefined, 'a platform of pure defaults writes no props');
  assert.equal(out.objects[0].rot, undefined);
  assert.deepEqual(out.objects[1].props, { w: 2, friction: 0 }, 'friction 0 differs from the 0.5 default and stays');
  assert.deepEqual(out.objects[2].props, { anchored: true }, 'h and density are defaults; anchored is not');
});

test('empty targets and via lists are the default and are dropped', () => {
  const out = write({
    schemaVersion: 1,
    engineVersion: '0.1.0',
    world: {},
    objects: [
      { id: 't1', type: 'trigger', pos: [0, 0], props: { targets: [] } },
      { id: 'g1', type: 'goal', pos: [1, 0], props: { accepts: 'any' } },
      { id: 'm1', type: 'marble', pos: [0, 1] },
    ],
    links: [{ id: 'r1', type: 'rope', a: { obj: 'm1' }, b: { obj: 't1' }, props: { via: [], segments: 0 } }],
  });
  assert.equal(out.objects[0].props, undefined);
  assert.equal(out.objects[1].props, undefined, 'accepts "any" is the default');
  assert.equal(out.links[0].props, undefined);
});

test('an empty accepts list is not the same as "any" and is kept', () => {
  const out = write({
    schemaVersion: 1,
    engineVersion: '0.1.0',
    world: {},
    objects: [{ id: 'g1', type: 'goal', pos: [0, 0], props: { accepts: [] } }],
  });
  assert.deepEqual(out.objects[0].props, { accepts: [] });
});

test('skin is never dropped — 02 §5.1 gives it no default', () => {
  const out = write({
    schemaVersion: 1,
    engineVersion: '0.1.0',
    world: {},
    objects: [{ id: 'd1', type: 'domino', pos: [0, 0], skin: 'wood' }],
  });
  assert.equal(out.objects[0].skin, 'wood');
});

test('"center" and unknown fields never reach the file', () => {
  const out = write({
    schemaVersion: 1,
    engineVersion: '0.1.0',
    world: {},
    objects: [
      { id: 'a', type: 'marble', pos: [0, 0], mystery: 42 },
      { id: 'b', type: 'crate', pos: [1, 0] },
    ],
    links: [{ id: 'w1', type: 'weld', a: { obj: 'a', anchor: 'center' }, b: { obj: 'b', at: [0.001, 0] }, extra: true }],
  });
  assert.equal('mystery' in out.objects[0], false);
  assert.equal('extra' in out.links[0], false);
  assert.deepEqual(out.links[0].a, { obj: 'a' }, '"center" is the default spelling of the local origin');
  assert.deepEqual(out.links[0].b, { obj: 'b', at: [0.001, 0] });
});

test('key order follows 02 §1', () => {
  const out = write(fixtureScene());
  assert.deepEqual(Object.keys(out), ['schemaVersion', 'engineVersion', 'meta', 'world', 'objects', 'links']);
  assert.deepEqual(Object.keys(out.objects[0]), ['id', 'type', 'pos', 'props']);
  assert.deepEqual(Object.keys(out.links[0]), ['id', 'type', 'a', 'b']);
});

test('writing is idempotent', () => {
  const once = serializeScene(SceneDoc.clone(fixtureScene()));
  const twice = serializeScene(SceneDoc.clone(JSON.parse(once)));
  assert.equal(twice, once);
});

test('writing cannot change what simulates (04 §15 decision 5)', () => {
  const source = fixtureScene();
  const written = JSON.parse(serializeScene(SceneDoc.clone(source)));
  const strip = (c) => ({
    world: c.world,
    objects: c.objects.map((o) => ({ id: o.id, type: o.type, pos: o.pos, rot: o.rot, props: o.props, material: o.material, motion: o.motion })),
    links: c.links.map((l) => ({ id: l.id, type: l.type, a: l.a, b: l.b, props: l.props })),
  });
  assert.deepEqual(strip(canonicalize(written)), strip(canonicalize(source)));
});

test('the serialized document is what the byte budget measures', () => {
  const doc = SceneDoc.clone(fixtureScene());
  assert.equal(serializedBytes(doc), new TextEncoder().encode(serializeScene(doc)).length);
});

test('the test-mode gate accepts the fixture and reports its warnings', () => {
  const outcome = gateForTest(SceneDoc.clone(fixtureScene()));
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.errors, []);
  assert.ok(Array.isArray(outcome.warnings));
});

test('the gate blocks a document with a dangling reference', () => {
  const broken = fixtureScene();
  broken.links.push({ id: 'bad1', type: 'weld', a: { obj: 'dom1' }, b: { obj: 'ghost' } });
  const outcome = gateForTest(SceneDoc.clone(broken));
  assert.equal(outcome.ok, false);
  assert.ok(outcome.errors.some((f) => f.rule === 'E2'));
});
