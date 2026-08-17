// P2a companion check — input canonicalization (03 §3, DET-3 and DET-4).
//
// The round-trip property in §12 ("expand(scene) equals expand(parse(serialize(
// scene))) after 600 steps") is the one this file makes true in advance: if
// canonicalization is idempotent under a 4-digit serializer and independent of
// the order objects happen to appear in the file, the property holds for every
// scene rather than for the corpus that happens to be tested.

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEG2RAD, canonicalize, compareIds, quantize, quantizeAngle } from '../dist/src/index.js';
import { PROP_DEFAULTS, WORLD_DEFAULTS } from '@physics/scene-format';

const scene = (objects, links = [], world = {}) => ({
  schemaVersion: 1,
  engineVersion: '0.1.0',
  world,
  objects,
  links,
});

test('DET-3: objects and links come out in id order regardless of file order', () => {
  const c = canonicalize(
    scene(
      [
        { id: 'zz', type: 'marble', pos: [0, 0] },
        { id: 'aa', type: 'marble', pos: [1, 1] },
        { id: 'Ab', type: 'marble', pos: [2, 2] },
        { id: 'a0', type: 'marble', pos: [3, 3] },
      ],
      [
        { id: 'l2', type: 'weld', a: { obj: 'aa' }, b: { obj: 'zz' } },
        { id: 'l1', type: 'weld', a: { obj: 'aa' }, b: { obj: 'Ab' } },
      ],
    ),
  );
  // Byte order, not locale order: uppercase sorts before lowercase, and a
  // locale-aware comparison would put 'Ab' after 'aa' on some systems.
  assert.deepEqual(c.objects.map((o) => o.id), ['Ab', 'a0', 'aa', 'zz']);
  assert.deepEqual(c.links.map((l) => l.id), ['l1', 'l2']);
  assert.ok(compareIds('Ab', 'aa') < 0);
  assert.equal(compareIds('x', 'x'), 0);
});

test('DET-4: every number is quantized to the writer grid', () => {
  assert.equal(quantize(0.123456789), 0.1235);
  assert.equal(quantize(1 / 3), 0.3333);
  assert.equal(quantize(2), 2);
  const c = canonicalize(scene([{ id: 'm', type: 'marble', pos: [0.123456, -0.000049], props: { r: 0.0250004 } }]));
  const [m] = c.objects;
  assert.deepEqual(m.pos, [0.1235, 0]);
  assert.equal(m.props.r, 0.025);
});

test('DET-4: −0 is normalized away before anything can read its sign', () => {
  const c = canonicalize(scene([{ id: 'm', type: 'marble', pos: [-0, -0.000001], rot: -0 }]));
  const [m] = c.objects;
  assert.ok(Object.is(m.pos[0], 0), 'literal −0 in the document');
  assert.ok(Object.is(m.pos[1], 0), '−0 produced by rounding');
  assert.ok(Object.is(m.rot, 0));
  assert.ok(Object.is(quantizeAngle(-0), 0));
});

test('canonicalization is idempotent under a JSON round-trip (§12)', () => {
  const doc = scene(
    [
      { id: 'p1', type: 'platform', pos: [0.12345, -0.98765], rot: 33.333333, props: { w: 1.23456 } },
      { id: 'd1', type: 'domino', pos: [1 / 3, 2 / 7], props: { h: 0.0812345, density: 6.00004 } },
      { id: 'c1', type: 'curve', pos: [-1.11111, 0.5], props: { r: 0.4001, sweep: 91.7 } },
    ],
    [
      {
        id: 'l1',
        type: 'springLink',
        a: { obj: 'p1', at: [0.123456, 0] },
        b: { obj: 'd1' },
        props: { stiffness: 50.00004 },
      },
    ],
  );
  const direct = canonicalize(doc);
  // The writer emits quantized numbers (02 §2 / 06 PG-3) — i.e. it applies the
  // *same* DET-4 formula — and `JSON.stringify` then prints each one with the
  // shortest representation that reads back identically.
  const written = JSON.parse(JSON.stringify(doc, (_k, v) => (typeof v === 'number' ? quantize(v) : v)));
  assert.deepEqual(stripMaps(canonicalize(written)), stripMaps(direct));
});

test('the writer must use the DET-4 formula, not a decimal formatter', () => {
  // `Math.round` breaks ties toward +∞; `toFixed` breaks them away from zero.
  // They therefore disagree on every *negative* value whose ×1e4 product lands
  // exactly on a .5 tie — 17 712 of the 35 424 such 5-decimal values in
  // [−2, 2] m, which is squarely inside the play area.
  //
  // That is not an academic difference: it is the §12 round-trip test. A writer
  // built the obvious way (`x.toFixed(4)`) would emit −0.9877 where the reader
  // quantizes to −0.9876, so `expand(scene)` and `expand(parse(serialize(scene)))`
  // would start one tenth of a millimetre apart and diverge from there. 02 §2
  // states the formula for this reason.
  assert.equal(quantize(-0.98765), -0.9876);
  assert.equal(Number((-0.98765).toFixed(4)), -0.9877);
  assert.notEqual(quantize(-0.98765), Number((-0.98765).toFixed(4)));
  // Positive ties agree, which is what makes the trap easy to miss.
  assert.equal(quantize(0.98765), Number((0.98765).toFixed(4)));

  // The property the round-trip actually needs: quantize is idempotent, and a
  // quantized value survives JSON exactly.
  for (let i = 0; i < 20000; i++) {
    const x = (i - 10000) / 997;
    const a = quantize(x);
    assert.equal(quantize(a), a, `not idempotent at ${x}`);
    assert.equal(JSON.parse(JSON.stringify(a)), a, `lost by JSON at ${x}`);
  }
});

const stripMaps = (c) => ({ world: c.world, objects: c.objects, links: c.links });

test('defaults come from the format tables, not from the engine', () => {
  const c = canonicalize(scene([{ id: 'f1', type: 'fan', pos: [0, 0] }, { id: 'g1', type: 'goal', pos: [1, 0] }]));
  const [fan, goal] = c.objects;
  assert.equal(fan.props.strength, PROP_DEFAULTS.fan.strength);
  assert.equal(fan.props.range, PROP_DEFAULTS.fan.range);
  assert.equal(fan.props.spread, PROP_DEFAULTS.fan.spread);
  assert.equal(fan.props.active, true);
  // The two list-valued defaults the canonicalizer owns.
  assert.equal(goal.props.accepts, 'any');
  const [trigger] = canonicalize(scene([{ id: 't1', type: 'trigger', pos: [0, 0] }])).objects;
  assert.deepEqual(trigger.props.targets, []);
});

test('material and motion defaults split static from dynamic correctly', () => {
  const c = canonicalize(
    scene([
      { id: 'm1', type: 'marble', pos: [0, 0] },
      { id: 'p1', type: 'platform', pos: [0, -1] },
      { id: 'c1', type: 'crate', pos: [0, 1], props: { magnetic: true, vel: [1.00004, -2], angVel: 90 } },
    ]),
  );
  const [crate, marble, platform] = c.objects;
  assert.equal(marble.material.density, 2.5, 'per-type density from MATERIAL_DEFAULTS');
  assert.equal(marble.material.friction, 0.3);
  assert.equal(marble.material.magnetic, false);
  assert.deepEqual(marble.motion.vel, [0, 0]);

  // A platform has no density — it has no dynamic body to give one to.
  assert.equal(platform.material.density, undefined);
  assert.equal(platform.material.friction, 0.5, 'static surface default (02 §5.2)');
  assert.equal(platform.material.restitution, 0);

  assert.equal(crate.material.magnetic, true);
  assert.deepEqual(crate.motion.vel, [1, -2]);
  assert.equal(crate.motion.angVel, quantizeAngle(90), 'deg/s converted once at load');
});

test('angles convert once, and only the ones that become simulation state', () => {
  const c = canonicalize(
    scene([
      { id: 'g1', type: 'gear', pos: [0, 0], rot: 45, props: { motorSpeed: 180 } },
      { id: 'lv', type: 'lever', pos: [1, 0], props: { minAngle: -30, maxAngle: 30 } },
      { id: 'cv', type: 'curve', pos: [2, 0], props: { sweep: 120 } },
      { id: 'fn', type: 'fan', pos: [3, 0], props: { spread: 25 } },
    ]),
  );
  const [curve, fan, gear, lever] = c.objects;
  assert.equal(gear.rot, 45 * DEG2RAD);
  assert.equal(gear.props.motorSpeed, quantizeAngle(180), 'deg/s → rad/s');
  assert.equal(lever.props.minAngle, quantizeAngle(-30));
  // `sweep` and `spread` stay in degrees: 03 §6 and §7.1 write their formulas
  // that way (`ceil(sweep_deg / 7.5)`, `dcos(spread · DEG2RAD)`), so converting
  // early would silently change the tessellation count.
  assert.equal(curve.props.sweep, 120);
  assert.equal(fan.props.spread, 25);
});

test('world gravity resolves to the vector 02 §1 defines', () => {
  const flat = canonicalize(scene([], [], {})).world;
  assert.equal(flat.gravity, WORLD_DEFAULTS.gravity);
  assert.deepEqual(flat.bounds, [...WORLD_DEFAULTS.bounds]);
  assert.equal(flat.seed, WORLD_DEFAULTS.seed);
  assert.deepEqual(flat.gravityVec, [0, -WORLD_DEFAULTS.gravity], 'straight down when the board is flat');

  const tilted = canonicalize(scene([], [], { gravity: 10, planeAngle: 90 })).world;
  assert.equal(tilted.planeAngle, 90 * DEG2RAD);
  assert.equal(tilted.gravityVec[0], 10);
  assert.ok(Math.abs(tilted.gravityVec[1]) < 1e-15, 'no y component at 90°');
});

test('link props resolve, and via defaults to an empty route', () => {
  const c = canonicalize(
    scene(
      [
        { id: 'a', type: 'crate', pos: [0, 0] },
        { id: 'b', type: 'crate', pos: [1, 0] },
      ],
      [
        { id: 'r1', type: 'rope', a: { obj: 'a' }, b: { obj: 'b' } },
        { id: 'x1', type: 'axle', a: { obj: 'a' }, b: { obj: 'b' }, props: { motorSpeed: 360 } },
        { id: 'w1', type: 'weld', a: { obj: 'a', at: [0.123456, 0] }, b: { obj: 'b' } },
      ],
    ),
  );
  const [rope, weld, axle] = c.links;
  assert.equal(rope.props.segments, 0);
  assert.deepEqual(rope.props.via, []);
  assert.equal(rope.props.length, undefined, 'derived from the layout at expansion, not a constant');
  assert.equal(axle.props.maxTorque, 0.5);
  assert.equal(axle.props.motorSpeed, quantizeAngle(360), 'deg/s → rad/s, same rule as gear');
  assert.deepEqual(weld.a.at, [0.1235, 0], 'endpoint offsets are quantized too');
});

test('byId indexes the canonical objects', () => {
  const c = canonicalize(scene([{ id: 'm1', type: 'marble', pos: [0, 0] }]));
  assert.equal(c.byId.get('m1'), c.objects[0]);
  assert.equal(c.byId.get('nope'), undefined);
});
