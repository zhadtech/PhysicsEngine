// The per-frame half: 03 §5.5's interpolation applied to a plan (04 §10.3), the
// 09 §7.2 adaptive-quality loop, the 04 §12 generated link visuals, and the
// Three.js binding's structure — which is checkable without a GPU because
// building an InstancedMesh needs no WebGL context.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OVERLOAD,
  PERF_TIERS,
  QualityController,
  RENDER,
  allInstances,
  applyCamera,
  applyFrame,
  beltVisual,
  bindRegistry,
  buildInstancedMeshes,
  buildRenderPlan,
  budgetMsFor,
  commonTangents,
  detectTier,
  dynamicInstanceCount,
  envelopeFor,
  frameStats,
  lodFor,
  makeFrameBuffer,
  p95,
  pitchCirclesTouch,
  ribbon,
  ropeSag,
  ropeVisual,
  sagDepth,
  unitGeometry,
  uploadFrame,
  gravityDir,
  SKIN_COLOR_COVERAGE,
} from '../dist/src/index.js';
import { BodyState, SAB } from '@physics/engine/protocol';
import { canonicalize } from '@physics/engine/geometry';
import { PerspectiveCamera } from 'three';
import { fixtureScene } from './fixtures.mjs';

const scene = (objects, links = []) => ({
  schemaVersion: 1,
  engineVersion: '0.1.0',
  world: {},
  objects,
  links,
});
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

function boundPlan(doc = fixtureScene()) {
  const plan = buildRenderPlan(doc);
  const dynamics = allInstances(plan).filter((i) => i.pose === null);
  const registry = dynamics.map((i) => ({ objId: i.objId, piece: i.piece }));
  assert.equal(bindRegistry(plan, registry), 0);
  return { plan, registry };
}

function frameOf(registry, fill) {
  const floats = new Float32Array(registry.length * SAB.FLOATS_PER_BODY);
  for (let i = 0; i < registry.length; i++) {
    const base = i * SAB.FLOATS_PER_BODY;
    const [x, y, rot, state] = fill(i, registry[i]);
    floats[base] = x;
    floats[base + 1] = y;
    floats[base + 2] = rot;
    floats[base + 3] = state;
  }
  return floats;
}

// -- frame application ------------------------------------------------------

test('a dynamic instance takes its pose from the buffer, with the collider offset composed on', () => {
  const { plan, registry } = boundPlan(
    scene([{ id: 'p1', type: 'pendulum', pos: [0, 1], props: { arm: 'rigid', len: 0.4, bobR: 0.03 } }]),
  );
  const instances = allInstances(plan);
  const buf = makeFrameBuffer(instances);
  // One body, rotated a quarter turn: the bob at local [0, −0.4] must swing out
  // to [+0.4, 0] relative to the body, not stay below it.
  const floats = frameOf(registry, () => [2, 3, Math.PI / 2, BodyState.Awake]);
  applyFrame(buf, floats, [0, 0], PERF_TIERS.high);
  const bob = buf.drawn[instances.findIndex((i) => i.primitive === 'sphere')];
  assert.ok(near(bob.x, 2.4, 1e-6) && near(bob.y, 3, 1e-6), `bob at ${bob.x},${bob.y}`);
  // The buffer is a Float32Array (03 §5.4), so the angle the renderer sees is
  // the float32 rounding of the one the sim wrote — not the float64 original.
  assert.equal(bob.rot, Math.fround(Math.PI / 2));
});

test('a static instance keeps the pose §6 gave it, buffer or no buffer', () => {
  const { plan, registry } = boundPlan(scene([{ id: 'floor', type: 'platform', pos: [1, -0.5], props: { w: 2 } }]));
  const instances = allInstances(plan);
  assert.equal(dynamicInstanceCount(plan), 0, 'a platform is static');
  const buf = makeFrameBuffer(instances);
  applyFrame(buf, null, [0, 0], PERF_TIERS.high);
  assert.ok(near(buf.drawn[0].x, 1) && near(buf.drawn[0].y, -0.5));
  assert.equal(buf.drawn[0].visible, true, 'and it is drawn before the first publish');
  assert.equal(registry.length, 0);
});

test('nothing is drawn at the origin before the first publish (§5.5)', () => {
  const { plan } = boundPlan(scene([{ id: 'm1', type: 'marble', pos: [5, 5] }]));
  const buf = makeFrameBuffer(allInstances(plan));
  applyFrame(buf, null, [0, 0], PERF_TIERS.high);
  assert.equal(buf.drawn[0].visible, false, 'a dynamic body with no frame is hidden, not placed at (0,0)');
});

test('Removed hides and fires once; Asleep dims and desaturates; Awake is plain (04 §10.3)', () => {
  const { plan, registry } = boundPlan(scene([{ id: 'm1', type: 'marble', pos: [0, 1] }]));
  const buf = makeFrameBuffer(allInstances(plan));

  applyFrame(buf, frameOf(registry, () => [0, 1, 0, BodyState.Awake]), [0, 0], PERF_TIERS.high);
  assert.deepEqual(
    { visible: buf.drawn[0].visible, dim: buf.drawn[0].dim, saturation: buf.drawn[0].saturation },
    { visible: true, dim: 1, saturation: 1 },
  );

  applyFrame(buf, frameOf(registry, () => [0, 1, 0, BodyState.Asleep]), [0, 0], PERF_TIERS.high);
  assert.equal(buf.drawn[0].dim, RENDER.SLEEP_DIM_FACTOR);
  assert.equal(buf.drawn[0].saturation, 1 - RENDER.SLEEP_DESATURATE);
  assert.equal(buf.drawn[0].visible, true);

  applyFrame(buf, frameOf(registry, () => [0, 1, 0, BodyState.Removed]), [0, 0], PERF_TIERS.high);
  assert.equal(buf.drawn[0].visible, false);
  assert.equal(buf.drawn[0].justRemoved, true, 'the poof fires on the transition');
  applyFrame(buf, frameOf(registry, () => [0, 1, 0, BodyState.Removed]), [0, 0], PERF_TIERS.high);
  assert.equal(buf.drawn[0].justRemoved, false, 'and only on the transition');
});

test('frame stats separate awake, asleep and hidden — 09 §3’s cost law is about the awake set', () => {
  const objects = [];
  for (let i = 0; i < 6; i++) objects.push({ id: `m${i}`, type: 'marble', pos: [i * 0.1, 1] });
  const { plan, registry } = boundPlan(scene(objects));
  const buf = makeFrameBuffer(allInstances(plan));
  const states = [BodyState.Awake, BodyState.Awake, BodyState.Asleep, BodyState.Asleep, BodyState.Asleep, BodyState.Removed];
  applyFrame(buf, frameOf(registry, (i) => [0, 0, 0, states[i]]), [0, 0], PERF_TIERS.high);
  assert.deepEqual(frameStats(buf), { awake: 2, asleep: 3, hidden: 1 });
});

test('LOD falls off with distance and is capped by the tier, not after it', () => {
  assert.equal(lodFor(0, PERF_TIERS.high), 2);
  assert.equal(lodFor(RENDER.LOD_NEAR_M + 1, PERF_TIERS.high), 1);
  assert.equal(lodFor(RENDER.LOD_FAR_M + 1, PERF_TIERS.high), 0);
  assert.equal(lodFor(0, PERF_TIERS.mid), PERF_TIERS.mid.maxInstanceDetailLod);
  assert.equal(lodFor(0, PERF_TIERS.low), 0, 'low never asks for a beveled mesh at any distance');
});

// -- adaptive quality (09 §7.2) ---------------------------------------------

test('the ladder drops shadows, then LOD, then overlays — information last', () => {
  const steps = [0, 1, 2, 3].map((l) => envelopeFor('high', l));
  assert.deepEqual(steps.map((e) => e.shadows), [true, false, false, false]);
  assert.deepEqual(
    steps.map((e) => e.maxInstanceDetailLod),
    [2, 2, 1, 1],
  );
  assert.deepEqual(steps.map((e) => e.fieldOverlays), [true, true, true, false]);
  assert.equal(envelopeFor('high', 0).shadowMapPx, RENDER.SHADOW_MAP_PX);
  assert.equal(envelopeFor('mid', 0).shadowMapPx, 0, 'mid has no shadows to halve');
  assert.equal(envelopeFor('low', 0).budgetMs, budgetMsFor(PERF_TIERS.low));
});

test('p95 is nearest-rank and does not crash on an empty window', () => {
  assert.equal(p95([]), 0);
  assert.equal(p95([5]), 5);
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(p95(hundred), 95);
});

test('a sustained overrun degrades exactly one step per window, never more', () => {
  const q = new QualityController('high');
  const over = budgetMsFor(PERF_TIERS.high) * (OVERLOAD.DEGRADE_FRAME_RATIO + 0.5);
  let changes = 0;
  for (let i = 0; i < OVERLOAD.DEGRADE_WINDOW_FRAMES - 1; i++) changes += q.frame(over) ? 1 : 0;
  assert.equal(changes, 0, 'no decision before a full window exists');
  assert.equal(q.qualityLevel, 0);
  assert.equal(q.frame(over), true, 'the window completes and one step is dropped');
  assert.equal(q.qualityLevel, 1);
  for (let i = 0; i < OVERLOAD.DEGRADE_WINDOW_FRAMES - 1; i++) assert.equal(q.frame(over), false, 'and only one');
  assert.equal(q.frame(over), true);
  assert.equal(q.qualityLevel, 2);
});

test('degradation bottoms out at the last rung and stays there', () => {
  const q = new QualityController('high');
  const over = budgetMsFor(PERF_TIERS.high) * 3;
  for (let i = 0; i < OVERLOAD.DEGRADE_WINDOW_FRAMES * 6; i++) q.frame(over);
  assert.equal(q.qualityLevel, 3);
  assert.equal(q.envelope.fieldOverlays, false);
});

test('a window between the budget and the degrade threshold does not oscillate', () => {
  const budget = budgetMsFor(PERF_TIERS.high);
  const q = new QualityController('high');
  for (let i = 0; i < OVERLOAD.DEGRADE_WINDOW_FRAMES * 2; i++) q.frame(budget * 3);
  const settled = q.qualityLevel;
  assert.ok(settled > 0, 'it degraded first');
  // Now sit in the dead band: over budget, under 1.25 × budget.
  const between = budget * 1.1;
  for (let i = 0; i < OVERLOAD.DEGRADE_WINDOW_FRAMES * 5; i++) q.frame(between);
  assert.equal(q.qualityLevel, settled, 'no flapping in the band a symmetric rule would flap in');
});

test('a calm window recovers one step, and never past the tier', () => {
  const budget = budgetMsFor(PERF_TIERS.high);
  const q = new QualityController('high');
  for (let i = 0; i < OVERLOAD.DEGRADE_WINDOW_FRAMES * 3; i++) q.frame(budget * 3);
  const degraded = q.qualityLevel;
  assert.ok(degraded >= 2);
  for (let i = 0; i < OVERLOAD.DEGRADE_WINDOW_FRAMES * 10; i++) q.frame(budget * 0.5);
  assert.equal(q.qualityLevel, 0, 'it climbed all the way back');
  for (let i = 0; i < OVERLOAD.DEGRADE_WINDOW_FRAMES * 3; i++) q.frame(budget * 0.5);
  assert.equal(q.qualityLevel, 0, 'and stopped at the tier');
});

test('the controller never exposes anything that could touch the worker (D20)', () => {
  const q = new QualityController('low');
  const keys = Object.keys(q.envelope);
  assert.deepEqual(keys.sort(), [
    'budgetMs',
    'fieldOverlays',
    'level',
    'maxInstanceDetailLod',
    'shadowMapPx',
    'shadows',
    'targetHz',
    'tier',
  ]);
  assert.equal(typeof q.p95Ms, 'number');
});

test('tier detection is coarse, and errs toward the tier the controller can fix', () => {
  assert.equal(detectTier({ hardwareConcurrency: 16, deviceMemoryGb: 16, maxTextureSize: 16384 }), 'high');
  assert.equal(detectTier({ hardwareConcurrency: 4, deviceMemoryGb: 8, maxTextureSize: 8192 }), 'mid');
  assert.equal(detectTier({ hardwareConcurrency: 2, deviceMemoryGb: 8, maxTextureSize: 8192 }), 'low');
  assert.equal(detectTier({ hardwareConcurrency: 16, deviceMemoryGb: 16, maxTextureSize: 2048 }), 'low');
  assert.equal(detectTier({}), 'mid', 'an unknown device is not assumed weak');
  assert.equal(
    detectTier({ hardwareConcurrency: 8, deviceMemoryGb: 8, coarsePointer: true, maxTextureSize: 8192 }),
    'mid',
    'a strong tablet is mid, not high',
  );
});

// -- generated geometry (04 §12) --------------------------------------------

test('rope sag matches the length of the rope, not a linear guess (04 §12.2)', () => {
  assert.equal(sagDepth(1, 1), 0, 'taut');
  assert.equal(sagDepth(1, 0.9), 0, 'stretched is still taut');
  const small = sagDepth(1, 1.01);
  const big = sagDepth(1, 1.04);
  assert.ok(small > 0 && big > small);
  assert.ok(
    near(big / small, 2, 1e-9),
    `four times the slack is twice the sag, not four times (got ${big / small})`,
  );
  assert.ok(sagDepth(0.01, 10) <= 5, 'a hugely slack rope is capped at half its length');
});

test('the sagged curve is about as long as the rope it draws', () => {
  const path = ropeSag([0, 0], [1, 0], 1.05, [0, -1], 64);
  let arc = 0;
  for (let i = 1; i < path.length; i++) arc += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  assert.ok(Math.abs(arc - 1.05) < 0.01, `drawn arc ${arc.toFixed(4)} vs rope 1.05`);
});

test('the sag hangs along scene gravity, so a tilted board hangs sideways', () => {
  const g = gravityDir(Math.PI / 2); // planeAngle 90°: "down" is +X
  const path = ropeSag([0, 0], [0, 1], 1.1, g, 8);
  const mid = path[4];
  assert.ok(mid[0] > 0.05, `the middle sags along gravity, not down the screen (${mid})`);
});

test('a via rope runs rim to rim, so it wraps the wheel it routes over (04 §12.2)', () => {
  const doc = fixtureScene();
  const canonical = canonicalize(doc);
  const rope = canonical.links.find((l) => l.id === 'rope1');
  const visual = ropeVisual(rope, canonical, gravityDir(0));
  assert.ok(visual, 'the rope is drawn');
  const pulley = canonical.byId.get('pul1');
  const r = pulley.props.r;
  const onRim = visual.path.filter((p) => Math.abs(Math.hypot(p[0] - pulley.pos[0], p[1] - pulley.pos[1]) - r) < 1e-9);
  assert.equal(onRim.length, 2, 'it touches the rim on the way in and on the way out');
});

test('a segmented rope is not drawn here — its bodies arrive in the frame buffer', () => {
  const doc = scene(
    [
      { id: 'a1', type: 'platform', pos: [0, 1], props: { w: 1 } },
      { id: 'c1', type: 'crate', pos: [0, 0] },
    ],
    [{ id: 'r1', type: 'rope', a: { obj: 'a1' }, b: { obj: 'c1' }, props: { segments: 6, length: 1 } }],
  );
  const canonical = canonicalize(doc);
  assert.equal(ropeVisual(canonical.links[0], canonical, gravityDir(0)), null);
});

test('common tangents exist exactly when 04 §12.1 says they do', () => {
  assert.ok(commonTangents([0, 0], 0.1, [0.5, 0], 0.1, 'outer'), 'outer tangents for separated circles');
  assert.ok(commonTangents([0, 0], 0.1, [0.5, 0], 0.1, 'inner'), 'inner tangents too');
  assert.equal(commonTangents([0, 0], 0.1, [0.15, 0], 0.1, 'inner'), null, 'overlapping circles have no inner tangent');
  assert.ok(commonTangents([0, 0], 0.1, [0.15, 0], 0.1, 'outer'), 'but they still have an outer one');
  assert.equal(commonTangents([0, 0], 0.3, [0.05, 0], 0.05, 'outer'), null, 'nor when one contains the other');
});

test('a tangent point really lies on its own circle', () => {
  const t = commonTangents([0, 0], 0.12, [0.7, 0.2], 0.05, 'outer');
  assert.ok(near(Math.hypot(t.a1[0], t.a1[1]), 0.12, 1e-12));
  assert.ok(near(Math.hypot(t.b1[0] - 0.7, t.b1[1] - 0.2), 0.05, 1e-12));
});

test('D9’s four gearMesh cases each render as 04 §12.1 tabulates them', () => {
  const gear = (id, x, r) => ({ id, type: 'gear', pos: [x, 0], props: { r } });
  const link = (props) => ({ id: 'g1', type: 'gearMesh', a: { obj: 'ga' }, b: { obj: 'gb' }, props });
  const build = (xb, rb, props) => {
    const c = canonicalize(scene([gear('ga', 0, 0.1), gear('gb', xb, rb)], [link(props)]));
    return beltVisual(c.links[0], c.byId.get('ga'), c.byId.get('gb'), 4, 0.01);
  };
  assert.equal(build(0.2, 0.1, undefined).style, 'glint', 'touching pitch circles, no ratio: geometric mesh');
  assert.equal(build(0.2, 0.1, { ratio: 2 }).style, 'glint', 'touching wins over ratio');
  assert.equal(build(0.9, 0.1, { ratio: 2 }).style, 'open', 'apart + positive ratio: open belt');
  assert.equal(build(0.9, 0.1, { ratio: -2 }).style, 'crossed', 'apart + negative ratio: crossed belt');
  const degenerate = build(0.12, 0.1, { ratio: -2 });
  assert.equal(degenerate.style, 'degenerate', 'overlapping + negative: no inner tangents');
  assert.equal(degenerate.warn, true, 'and it carries the warning tint');
  assert.deepEqual(degenerate.tangents, []);
  assert.equal(build(0.9, 0.1, { ratio: 2 }).surfaceSpeed, 0.4, 'the UV scroll is ω_A·r_A');
});

test('pitch-circle contact uses the §6.4 tolerance', () => {
  assert.equal(pitchCirclesTouch([0, 0], 0.1, [0.2, 0], 0.1, 0.005), true);
  assert.equal(pitchCirclesTouch([0, 0], 0.1, [0.21, 0], 0.1, 0.005), false);
  assert.equal(pitchCirclesTouch([0, 0], 0.1, [0.21, 0], 0.1, 0.02), true);
});

test('a ribbon offsets a path symmetrically about it', () => {
  const { left, right } = ribbon([[0, 0], [1, 0], [2, 0]], 0.02);
  assert.equal(left.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.ok(near(left[i][1], 0.01, 1e-12) && near(right[i][1], -0.01, 1e-12));
    assert.ok(near((left[i][0] + right[i][0]) / 2, i, 1e-12));
  }
});

// -- the Three.js binding ---------------------------------------------------

test('the binding builds exactly one InstancedMesh per plan mesh, sized to it', () => {
  const { plan } = boundPlan();
  const binding = buildInstancedMeshes(plan);
  try {
    assert.equal(binding.bindings.length, plan.meshes.length);
    assert.equal(binding.root.children.length, plan.meshes.length);
    let expected = 0;
    for (let i = 0; i < plan.meshes.length; i++) {
      assert.equal(binding.bindings[i].key, plan.meshes[i].key);
      assert.equal(binding.bindings[i].mesh.count, plan.meshes[i].instances.length);
      assert.equal(binding.bindings[i].offset, expected, 'offsets index the flat frame buffer');
      expected += plan.meshes[i].instances.length;
    }
    assert.equal(expected, allInstances(plan).length);
  } finally {
    binding.dispose();
  }
});

test('uploading a frame writes every instance, and a removed one collapses to zero scale', () => {
  const { plan, registry } = boundPlan(scene([{ id: 'm1', type: 'marble', pos: [0, 1] }, { id: 'm2', type: 'marble', pos: [1, 1] }]));
  const buf = makeFrameBuffer(allInstances(plan));
  const binding = buildInstancedMeshes(plan);
  try {
    applyFrame(
      buf,
      frameOf(registry, (i) => [i, 2, 0, i === 0 ? BodyState.Awake : BodyState.Removed]),
      [0, 0],
      PERF_TIERS.high,
    );
    uploadFrame(binding, plan, buf, envelopeFor('high', 0));
    const mesh = binding.bindings[0].mesh;
    const m = mesh.instanceMatrix.array;
    // Column-major: element 0 is scale.x for an axis-aligned instance.
    assert.ok(m[0] > 0, 'the awake marble has size');
    assert.equal(m[16], 0, 'the removed one has none');
    assert.ok(mesh.instanceColor, 'colors were written for sleep dimming');
  } finally {
    binding.dispose();
  }
});

test('every skin has a placeholder color, and each primitive has a unit mesh', () => {
  assert.equal(SKIN_COLOR_COVERAGE, true);
  for (const primitive of ['box', 'sphere', 'disc']) {
    const geometry = unitGeometry(primitive);
    try {
      assert.ok(geometry.attributes.position.count > 0, `${primitive} has vertices`);
    } finally {
      geometry.dispose();
    }
  }
});

test('the camera binding rolls the up vector, not the world (04 §4 board-frame cursor)', () => {
  const camera = new PerspectiveCamera();
  const cam = { target: [1, 2], distance: 5, tiltDeg: 15 };
  applyCamera(camera, cam, { widthPx: 800, heightPx: 600 }, 0);
  assert.ok(near(camera.up.x, 0, 1e-9), 'no roll, no lean');
  applyCamera(camera, cam, { widthPx: 800, heightPx: 600 }, 20);
  assert.ok(Math.abs(camera.up.x) > 0.1, 'a tilted board leans the camera');
  assert.equal(camera.fov, 50);
  assert.ok(near(camera.position.x, 1, 1e-9), 'the eye still sits over the target in X');
});
