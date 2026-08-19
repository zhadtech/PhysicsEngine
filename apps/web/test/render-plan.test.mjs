// 09 §4's rendering strategy, as properties of the plan rather than of a picture.
//
// The claim under test is the one the whole performance argument rests on:
// draw calls are bounded by *kinds*, not by object count. That is checkable
// without a GPU, so it is checked here rather than being taken on trust until
// someone opens a browser.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INSTANCED_TYPES,
  INSTANCE_PRIMITIVES,
  MAX_INSTANCE_DRAWS,
  MAX_INSTANCE_GROUPS,
  MAX_SOLID_DRAWS,
  RENDER,
  RENDER_CLASS,
  SKIN_NAMES,
  DEFAULT_SKIN,
  allInstances,
  assertWithinCeilings,
  bindRegistry,
  buildRenderPlan,
  countDrawCalls,
  groupKeys,
  meshKey,
  resolveSkin,
} from '../dist/src/index.js';
import { OBJECT_TYPES } from '@physics/scene-format';
import { canonicalize, objectGeometry } from '@physics/engine/geometry';
import { fixtureScene } from './fixtures.mjs';

const scene = (objects, links = []) => ({
  schemaVersion: 1,
  engineVersion: '0.1.0',
  world: {},
  objects,
  links,
});

test('every catalog type is classified, and the instanced tuple is exactly the instanced set', () => {
  for (const type of OBJECT_TYPES) {
    assert.ok(['instanced', 'generated', 'overlay'].includes(RENDER_CLASS[type]), `${type} is classified`);
  }
  const fromMap = OBJECT_TYPES.filter((t) => RENDER_CLASS[t] === 'instanced').sort();
  assert.deepEqual([...INSTANCED_TYPES].sort(), fromMap);
});

test('a five-thousand domino scene is one draw call (09 §4)', () => {
  const objects = [];
  for (let i = 0; i < 5000; i++) objects.push({ id: `d${i}`, type: 'domino', pos: [i * 0.06, 0] });
  const plan = buildRenderPlan(scene(objects));
  assert.equal(plan.meshes.length, 1);
  assert.equal(plan.meshes[0].instances.length, 5000);
  assert.deepEqual(countDrawCalls(plan), { solid: 1, generated: 0, overlays: 0, total: 1 });
});

test('the draw count is bounded by kinds, not by object count', () => {
  const small = [];
  const large = [];
  for (const type of INSTANCED_TYPES) {
    for (const skin of SKIN_NAMES) {
      // `INSTANCE_MIN` instances of each pair, so no group falls back to
      // individual draws — the regime the ceiling describes.
      for (let i = 0; i < RENDER.INSTANCE_MIN; i++) {
        small.push({ id: `${type}${skin}${i}`, type, pos: [i * 0.5, 0], skin });
      }
    }
  }
  for (let i = 0; i < 20; i++) {
    for (const o of small) large.push({ ...o, id: `${o.id}x${i}`, pos: [o.pos[0], i * 0.5] });
  }
  const planSmall = buildRenderPlan(scene(small));
  const planLarge = buildRenderPlan(scene(large));
  assert.equal(groupKeys(planSmall).length, MAX_INSTANCE_GROUPS, 'the pathological scene uses every group');
  assert.equal(planSmall.meshes.length, MAX_INSTANCE_DRAWS, 'and every mesh');
  assert.equal(countDrawCalls(planSmall).solid, MAX_INSTANCE_DRAWS);
  assert.equal(
    countDrawCalls(planLarge).solid,
    countDrawCalls(planSmall).solid,
    'twenty times the objects, the same number of draws',
  );
  assert.ok(allInstances(planLarge).length > 20 * allInstances(planSmall).length - 1);
});

test('a rigid pendulum needs two meshes per skin — the reason 88 ≠ 96', () => {
  const plan = buildRenderPlan(
    scene([{ id: 'p1', type: 'pendulum', pos: [0, 1], props: { arm: 'rigid', len: 0.4, bobR: 0.03 } }]),
  );
  assert.equal(groupKeys(plan).length, 1, 'one (type, skin) group');
  assert.equal(plan.meshes.length, 2, 'but a sphere mesh and a box mesh');
  assert.deepEqual(
    plan.meshes.map((m) => m.primitive).sort(),
    ['box', 'sphere'],
    'the bob and the rod are different primitives',
  );
  assert.equal(
    MAX_INSTANCE_DRAWS,
    (INSTANCED_TYPES.length + 1) * SKIN_NAMES.length,
    'exactly one type contributes a second primitive',
  );
  assert.equal(MAX_INSTANCE_GROUPS, INSTANCED_TYPES.length * SKIN_NAMES.length, '09 §4’s group ceiling is unchanged');
});

test('a rope-armed pendulum is a bob and nothing else', () => {
  const plan = buildRenderPlan(
    scene([{ id: 'p1', type: 'pendulum', pos: [0, 1], props: { arm: 'rope', len: 0.4, bobR: 0.03 } }]),
  );
  assert.equal(plan.meshes.length, 1);
  assert.equal(plan.meshes[0].primitive, 'sphere');
});

test('the declared primitives are the collider kinds §6 actually emits', () => {
  // Derived, not asserted: expand every instanced type (both pendulum arms, both
  // spring modes) and check the collider kinds against the table.
  const variants = {
    pendulum: [{ arm: 'rigid' }, { arm: 'rope' }],
    spring: [{ mode: 'passive' }, { mode: 'triggered' }],
    piston: [{ mode: 'cycle' }, { mode: 'triggered' }],
  };
  const wanted = { cuboid: 'box', ball: ['sphere', 'disc'] };
  for (const type of INSTANCED_TYPES) {
    const kinds = new Set();
    for (const props of variants[type] ?? [{}]) {
      const canonical = canonicalize(scene([{ id: 'o1', type, pos: [0, 0], props }]));
      const geom = objectGeometry(canonical.byId.get('o1'));
      for (const piece of geom.pieces) for (const c of piece.colliders) kinds.add(c.kind);
    }
    const declared = new Set(
      INSTANCE_PRIMITIVES[type].map((p) => (p === 'box' ? 'cuboid' : 'ball')),
    );
    assert.deepEqual([...kinds].sort(), [...declared].sort(), `${type}: ${[...kinds]} vs ${INSTANCE_PRIMITIVES[type]}`);
    assert.ok(
      INSTANCE_PRIMITIVES[type].every((p) => (p === 'box' ? true : wanted.ball.includes(p))),
      `${type} declares known primitives`,
    );
  }
});

test('ramps and curves are generated, fields and sensors are overlays', () => {
  const plan = buildRenderPlan(fixtureScene());
  assert.deepEqual(plan.generated.map((g) => g.type).sort(), ['ramp']);
  assert.deepEqual(plan.overlays.map((o) => o.type).sort(), ['fan', 'goal', 'pulley', 'trigger']);
  for (const shape of plan.generated) assert.ok(shape.outline.length >= 3, 'a generated shape has vertices');
});

test('a curve traces its own colliders, so the picture is what the marble rolls on', () => {
  const plan = buildRenderPlan(
    scene([{ id: 'c1', type: 'curve', pos: [0, 0], props: { r: 0.5, sweep: 90, thickness: 0.02 } }]),
  );
  const [curve] = plan.generated;
  assert.equal(curve.type, 'curve');
  const canonical = canonicalize(scene([{ id: 'c1', type: 'curve', pos: [0, 0], props: { r: 0.5, sweep: 90, thickness: 0.02 } }]));
  const colliders = objectGeometry(canonical.byId.get('c1')).pieces[0].colliders;
  assert.equal(curve.outline.length, colliders.length, 'one outline point per collider box');
  for (const p of curve.outline) {
    const d = Math.hypot(p[0], p[1]);
    assert.ok(Math.abs(d - 0.5) < 0.5 * 0.01, `outline point stays on the arc (r=${d})`);
  }
});

test('an unknown skin falls back to the type default (02 §5.1), a known one survives', () => {
  assert.equal(resolveSkin('domino', 'neon'), 'neon');
  assert.equal(resolveSkin('domino', 'holographic'), DEFAULT_SKIN.domino);
  assert.equal(resolveSkin('domino', undefined), DEFAULT_SKIN.domino);
  const plan = buildRenderPlan(
    scene([
      { id: 'd1', type: 'domino', pos: [0, 0], skin: 'holographic' },
      { id: 'd2', type: 'domino', pos: [0.1, 0] },
    ]),
  );
  assert.equal(plan.meshes.length, 1, 'both land in the default-skin group');
  assert.equal(plan.meshes[0].key, meshKey('domino', DEFAULT_SKIN.domino, 'box'));
});

test('meshes come out in a stable order regardless of document order', () => {
  const objects = [
    { id: 'z1', type: 'marble', pos: [0, 1], skin: 'candy' },
    { id: 'a1', type: 'domino', pos: [0, 0], skin: 'wood' },
    { id: 'm1', type: 'crate', pos: [1, 0], skin: 'steel' },
  ];
  const forward = buildRenderPlan(scene(objects)).meshes.map((m) => m.key);
  const reversed = buildRenderPlan(scene([...objects].reverse())).meshes.map((m) => m.key);
  assert.deepEqual(forward, reversed);
  // INSTANCED_TYPES order, not document order: platform, domino, marble, crate, …
  assert.deepEqual(forward, ['domino:wood:box', 'marble:candy:sphere', 'crate:steel:box']);
});

test('a nearly-empty group is drawn individually, and that is still bounded', () => {
  const objects = [];
  for (let i = 0; i < RENDER.INSTANCE_MIN - 1; i++) objects.push({ id: `d${i}`, type: 'domino', pos: [i * 0.1, 0] });
  const plan = buildRenderPlan(scene(objects));
  assert.equal(countDrawCalls(plan).solid, RENDER.INSTANCE_MIN - 1, 'below the threshold: one draw each');
  objects.push({ id: 'dN', type: 'domino', pos: [1, 0] });
  assert.equal(countDrawCalls(buildRenderPlan(scene(objects))).solid, 1, 'at the threshold: one instanced draw');
  assert.equal(MAX_SOLID_DRAWS, MAX_INSTANCE_DRAWS * (RENDER.INSTANCE_MIN - 1));
});

test('the ceilings are asserted, not assumed', () => {
  assert.doesNotThrow(() => assertWithinCeilings(buildRenderPlan(fixtureScene())));
});

test('static bodies keep their §6 pose; dynamic ones bind to registry slots', () => {
  const plan = buildRenderPlan(fixtureScene());
  const statics = allInstances(plan).filter((i) => i.pose !== null);
  const dynamics = allInstances(plan).filter((i) => i.pose === null);
  assert.ok(statics.length > 0 && dynamics.length > 0, 'the fixture has both');
  assert.ok(statics.every((i) => i.slot === -1), 'static instances are never bound');

  // A registry in a deliberately different order from the plan: matching is by
  // (objId, piece), so the binding must not depend on the walk order.
  const registry = dynamics.map((i) => ({ objId: i.objId, piece: i.piece })).reverse();
  assert.equal(bindRegistry(plan, registry), 0, 'every dynamic instance found a slot');
  for (const inst of dynamics) {
    const expected = registry.findIndex((e) => e.objId === inst.objId && e.piece === inst.piece);
    assert.equal(inst.slot, expected, `${inst.objId}/${inst.piece}`);
  }
});

test('a registry missing a body is reported, not silently drawn at the origin', () => {
  const plan = buildRenderPlan(fixtureScene());
  const dynamics = allInstances(plan).filter((i) => i.pose === null);
  const short = dynamics.slice(1).map((i) => ({ objId: i.objId, piece: i.piece }));
  assert.equal(bindRegistry(plan, short), 1);
});
