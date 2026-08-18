// P2b companion check — the §7 force layer and the §8 custom constraints.
//
// §12 calls for "force-layer units": fan falloff and cone edges, the magnet
// clamp at 5 cm, the conveyor acceleration cap, gearMesh convergence after the 8
// passes, and pulley length error under load. These are the formulas whose
// numbers a user actually feels, and they are the ones a refactor can quietly
// halve without moving a single hash — because a golden only says "the same as
// last time", never "right".
//
// Each test states the number the spec predicts and checks the engine produces
// it, rather than recording what the engine happens to do.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSimCore, SIM } from '../dist/src/index.js';

const scene = (objects, links = [], world = {}) => ({
  schemaVersion: 1,
  engineVersion: '0.1.0',
  world,
  objects,
  links,
});

/** Shortest signed difference between two wrapped angles, in (-pi, pi]. */
function angleDelta(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

async function run(doc, steps) {
  const sim = await createSimCore();
  const load = sim.load(doc);
  sim.advance(steps);
  const frame = new Float32Array(load.bodyCount * 4);
  sim.writeFrame(frame);
  const at = (objId, piece = 'main') => {
    const i = load.registry.findIndex((r) => r.objId === objId && r.piece === piece);
    assert.ok(i >= 0, `no registry slot for ${objId}/${piece}`);
    return { x: frame[i * 4], y: frame[i * 4 + 1], rot: frame[i * 4 + 2], state: frame[i * 4 + 3] };
  };
  return { sim, load, at };
}

// ---------------------------------------------------------------------------
// §7.1 Fan
// ---------------------------------------------------------------------------

test('§7.1 fan: force falls off linearly and stops at `range`', async () => {
  // Two identical marbles, one at a quarter of the range and one at three
  // quarters. The forces are 0.75*strength and 0.25*strength, so over a short
  // burst — before either has moved far enough to change its own falloff — the
  // near marble must gain about three times the speed of the far one.
  const doc = scene([
    { id: 'fn', type: 'fan', pos: [0, 0], rot: 0, props: { strength: 0.4, range: 1, spread: 60 } },
    { id: 'aNear', type: 'marble', pos: [0.25, 0] },
    { id: 'bFar', type: 'marble', pos: [0.75, 0] },
  ], [], { gravity: 0 });
  const { at } = await run(doc, 6);
  const near = at('aNear').x - 0.25;
  const far = at('bFar').x - 0.75;
  assert.ok(near > 0 && far > 0, 'both marbles are blown along +x');
  assert.ok(Math.abs(near / far - 3) < 0.02, `linear falloff ratio ${(near / far).toFixed(4)}, expected 3`);
});

test('§7.1 fan: nothing outside `range` is touched', async () => {
  const doc = scene([
    { id: 'fn', type: 'fan', pos: [0, 0], rot: 0, props: { strength: 5, range: 0.5, spread: 80 } },
    { id: 'zOut', type: 'marble', pos: [0.6, 0] },
  ], [], { gravity: 0 });
  const { at } = await run(doc, 120);
  // The frame is f32 (§5.4), so "unmoved" is compared at f32 resolution.
  assert.ok(Math.abs(at('zOut').x - 0.6) < 1e-6, `a marble beyond the range must not move (got ${at('zOut').x})`);
});

test('§7.1 fan: the cone edge is exactly `spread` degrees off the axis', async () => {
  // spread 30 means the cone test admits directions within 30 deg of the axis.
  // A marble at 25 deg is inside, one at 35 deg is outside, and nothing between
  // them needs to be asserted for the boundary to be pinned.
  const at25 = 25 * (Math.PI / 180);
  const at35 = 35 * (Math.PI / 180);
  const r = 0.4;
  const doc = scene([
    { id: 'fn', type: 'fan', pos: [0, 0], rot: 0, props: { strength: 2, range: 1, spread: 30 } },
    { id: 'aIn', type: 'marble', pos: [Number((r * Math.cos(at25)).toFixed(4)), Number((r * Math.sin(at25)).toFixed(4)) ] },
    { id: 'bOut', type: 'marble', pos: [Number((r * Math.cos(at35)).toFixed(4)), Number((r * Math.sin(at35)).toFixed(4)) ] },
  ], [], { gravity: 0 });
  const { at } = await run(doc, 8);
  const inside = Number((r * Math.cos(at25)).toFixed(4));
  const outside = Number((r * Math.cos(at35)).toFixed(4));
  assert.ok(at('aIn').x > inside + 1e-3, 'a marble 25 deg off a 30 deg cone axis is inside the cone');
  assert.ok(Math.abs(at('bOut').x - outside) < 1e-6, `a marble 35 deg off is outside and unmoved (got ${at('bOut').x})`);
});

test('§7 wake rule: a weak field does not wake a sleeping body', async () => {
  // FIELD_WAKE_FACTOR gates waking at 0.7 * m * g. A magnet far enough away to
  // deliver far less than that must leave a settled crate asleep — otherwise a
  // distant field pins the whole board awake and no run ever reaches
  // `quiescent` (§9.2).
  const doc = scene([
    { id: 'floor', type: 'platform', pos: [0, -0.025], props: { w: 3 } },
    { id: 'kCrate', type: 'crate', pos: [0, 0.04], props: { magnetic: true } },
    { id: 'zMag', type: 'magnet', pos: [0.9, 0.04], props: { strength: 0.02, range: 2, active: true } },
  ]);
  const { sim, at } = await run(doc, 900);
  assert.equal(at('kCrate').state, 0, 'the crate is asleep — the weak field never woke it');
  // Not `quiescent`: §9.2 counts any switched-on magnet as a live actuator, so
  // the run ends on the `idle` clause instead. Both are finishes; a field that
  // kept nudging the crate would produce neither.
  assert.equal(sim.finished, 'idle', 'and the run still finishes');
});

// ---------------------------------------------------------------------------
// §7.2 Magnet
// ---------------------------------------------------------------------------

test('§7.2 magnet: `strength` is newtons at MAGNET_REF_DIST, inverse-square beyond', async () => {
  // A six-step burst with gravity off: short enough that the crate covers only
  // a couple of percent of its distance to the magnet, so each sample measures
  // one point on the falloff curve rather than a smear across it.
  const pulled = async (dist) => {
    const start = Number(dist.toFixed(4));
    const doc = scene([
      { id: 'mg', type: 'magnet', pos: [0, 0], props: { strength: 3, range: 4, active: true } },
      { id: 'zc', type: 'crate', pos: [start, 0], props: { magnetic: true } },
    ], [], { gravity: 0 });
    const { at } = await run(doc, 6);
    return start - at('zc').x;
  };
  const near = await pulled(0.4);
  const mid = await pulled(0.8);
  const far = await pulled(1.6);
  assert.ok(Math.abs(near / mid - 4) < 0.05, `2x distance is 1/4 the pull (got ${(near / mid).toFixed(4)})`);
  assert.ok(Math.abs(mid / far - 4) < 0.05, `2x again is 1/4 again (got ${(mid / far).toFixed(4)})`);
});

test('§7.2 magnet: the inverse square is clamped inside 5 cm, never singular', async () => {
  // Inside the clamp the pull is a full 3 N, which throws a default 26 g crate
  // clean past the magnet in a few steps — so this one uses the heaviest crate
  // the format allows (0.5 m at density 100, 25 kg) to stay put and be measured.
  const pulled = async (dist) => {
    // DET-4 quantizes `pos` to four digits on the way in, so the displacement is
    // measured from the position the engine actually used. MAGNET_REF_DIST / 3
    // is not representable at four digits, and subtracting the unrounded value
    // instead reports a 0.5 % difference that is entirely the test's own.
    const start = Number(dist.toFixed(4));
    const doc = scene([
      { id: 'mg', type: 'magnet', pos: [0, 0], props: { strength: 3, range: 4, active: true } },
      { id: 'zc', type: 'crate', pos: [start, 0], props: { w: 0.5, h: 0.5, density: 100, magnetic: true } },
    ], [], { gravity: 0 });
    const { at } = await run(doc, 20);
    return start - at('zc').x;
  };
  // Inside the reference distance the force stops rising. An unclamped inverse
  // square would be 4x at half the distance and 11x at 1.5 cm — which is how a
  // magnet ends up flinging a crate the instant it touches.
  const ref = await pulled(SIM.MAGNET_REF_DIST);
  const half = await pulled(SIM.MAGNET_REF_DIST / 2);
  const third = await pulled(SIM.MAGNET_REF_DIST / 3);
  assert.ok(Math.abs(half / ref - 1) < 1e-3, `clamped at half the reference distance (ratio ${(half / ref).toFixed(6)})`);
  assert.ok(Math.abs(third / ref - 1) < 1e-3, `clamped at a third of it (ratio ${(third / ref).toFixed(6)})`);
});

test('§7.2 magnet: only `magnetic` bodies feel it', async () => {
  // Separate scenes, identical but for the flag: put both crates in one world
  // and the magnetic one is dragged through the other, which would "move" it.
  const travel = async (magnetic) => {
    const doc = scene([
      { id: 'mg', type: 'magnet', pos: [0, 0], props: { strength: 8, range: 2, active: true } },
      { id: 'zc', type: 'crate', pos: [0.3, 0], ...(magnetic ? { props: { magnetic: true } } : {}) },
    ], [], { gravity: 0 });
    const { at } = await run(doc, 30);
    return 0.3 - at('zc').x;
  };
  assert.ok(Math.abs(await travel(false)) < 1e-6, 'a non-magnetic crate is unaffected');
  assert.ok((await travel(true)) > 0.01, 'a magnetic one is pulled in');
});

// ---------------------------------------------------------------------------
// §7.3 Conveyor
// ---------------------------------------------------------------------------

test('§7.3 conveyor: a crate is carried at belt speed', async () => {
  const doc = scene([
    { id: 'cv', type: 'conveyor', pos: [0, 0], props: { w: 3, h: 0.05, speed: 0.3, active: true } },
    { id: 'zc', type: 'crate', pos: [-1, 0.07] },
  ]);
  const a = await run(doc, 120);
  const b = await run(doc, 240);
  // Between second 2 and second 4 the crate is fully up to speed, so the
  // displacement over those two seconds is the belt speed times two.
  const travelled = b.at('zc').x - a.at('zc').x;
  assert.ok(Math.abs(travelled - 0.6) < 0.01, `carried ${travelled.toFixed(4)} m in 2 s at 0.3 m/s`);
});

test('§7.3 conveyor: the grip limit caps how fast it can pick a load up', async () => {
  // CONVEYOR_MAX_ACCEL is the belt's grip: a crate set down on a fast belt may
  // not be teleported to belt speed, only accelerated at up to 10 m/s^2. So the
  // distance covered in the first t seconds is bounded by 0.5 * a * t^2 — far
  // below the 0.3 m a 3 m/s belt would carry it if the grip were ignored.
  const doc = scene([
    { id: 'cv', type: 'conveyor', pos: [0, 0], props: { w: 4, h: 0.05, speed: 3, active: true } },
    { id: 'zc', type: 'crate', pos: [-1.5, 0.07] },
  ]);
  const steps = 6;
  const t = steps / 60;
  const { at } = await run(doc, steps);
  const travelled = at('zc').x + 1.5;
  const bound = 0.5 * SIM.CONVEYOR_MAX_ACCEL * t * t;
  assert.ok(travelled > 0, 'the belt does pick it up');
  assert.ok(travelled <= bound + 1e-4, `travelled ${travelled.toFixed(5)} m in ${steps} steps, grip bound ${bound.toFixed(5)} m`);
});

test('§7.3 conveyor: an inactive belt is a plain static box', async () => {
  const doc = scene([
    { id: 'cv', type: 'conveyor', pos: [0, 0], props: { w: 3, h: 0.05, speed: 0.9, active: false } },
    { id: 'zc', type: 'crate', pos: [-1, 0.07] },
  ]);
  const { at, sim } = await run(doc, 600);
  assert.equal(at('zc').x, -1, 'the crate does not move');
  assert.equal(sim.finished, 'quiescent', 'and a switched-off belt is not a live actuator (§9.2)');
});

// ---------------------------------------------------------------------------
// §8.1 gearMesh
// ---------------------------------------------------------------------------

test('§8.1 gearMesh: the ratio converges to better than 1e-3 rad/s in 8 passes', async () => {
  const doc = scene(
    [
      { id: 'ga', type: 'gear', pos: [0, 1], props: { r: 0.2, motorSpeed: 90, maxTorque: 5 } },
      { id: 'gb', type: 'gear', pos: [0.31, 1], props: { r: 0.1 } },
    ],
    [{ id: 'm1', type: 'gearMesh', a: { obj: 'ga' }, b: { obj: 'gb' } }],
  );
  // Sampled over 12 steps so neither angle can wrap past +/-pi and turn a
  // correct ratio into a nonsense one.
  const a = await run(doc, 60);
  const b = await run(doc, 72);
  const dA = angleDelta(a.at('ga').rot, b.at('ga').rot);
  const dB = angleDelta(a.at('gb').rot, b.at('gb').rot);
  const ratio = dB / dA;
  assert.ok(Math.abs(ratio + 2) < 1e-3, `default ratio -rA/rB = -2, measured ${ratio.toFixed(6)}`);
  // And the driven gear held its commanded speed under the mesh load.
  assert.ok(Math.abs(dA / (12 / 60) - Math.PI / 2) < 1e-3, `driver holds 90 deg/s, measured ${(dA / (12 / 60)).toFixed(6)} rad/s`);
});

test('§8.1 gearMesh: an explicit ratio overrides the radii', async () => {
  const doc = scene(
    [
      { id: 'ga', type: 'gear', pos: [0, 1], props: { r: 0.2, motorSpeed: 90, maxTorque: 5 } },
      { id: 'gb', type: 'gear', pos: [0.31, 1], props: { r: 0.1 } },
    ],
    [{ id: 'm1', type: 'gearMesh', a: { obj: 'ga' }, b: { obj: 'gb' }, props: { ratio: 0.5 } }],
  );
  const a = await run(doc, 60);
  const b = await run(doc, 72);
  const ratio = angleDelta(a.at('gb').rot, b.at('gb').rot) / angleDelta(a.at('ga').rot, b.at('ga').rot);
  assert.ok(Math.abs(ratio - 0.5) < 1e-3, `explicit ratio 0.5, measured ${ratio.toFixed(6)}`);
});

test('§8.1 gearMesh: a chain of meshes stays coupled end to end', async () => {
  const objects = [];
  const links = [];
  for (let i = 0; i < 5; i++) {
    objects.push({ id: `g${i}`, type: 'gear', pos: [Number((i * 0.4).toFixed(4)), 1], props: { r: 0.19, ...(i === 0 ? { motorSpeed: 180, maxTorque: 5 } : {}) } });
    if (i > 0) links.push({ id: `m${i}`, type: 'gearMesh', a: { obj: `g${i - 1}` }, b: { obj: `g${i}` } });
  }
  const doc = scene(objects, links);
  const a = await run(doc, 60);
  const b = await run(doc, 66);
  // Equal radii mean ratio -1 at every mesh, so the chain alternates direction
  // and the fifth gear turns exactly as fast as the first.
  const d = (id) => angleDelta(a.at(id).rot, b.at(id).rot);
  for (let i = 1; i < 5; i++) {
    assert.ok(Math.abs(d(`g${i}`) / d(`g${i - 1}`) + 1) < 2e-3, `mesh ${i} holds ratio -1 (got ${(d(`g${i}`) / d(`g${i - 1}`)).toFixed(5)})`);
  }
});

// ---------------------------------------------------------------------------
// §8.2 Rope over pulleys
// ---------------------------------------------------------------------------

test('§8.2 pulley rope: the total length holds to within 2x the slop under load', async () => {
  // A 10x-density load hanging from a static anchor over a pulley — §12's
  // "pulley length error < 2 * slop under 10x load". Kept off the floor and
  // below the pulley for the whole window, so what is measured is the rope and
  // not a landing or a swing over the top.
  const doc = scene(
    [
      { id: 'anc', type: 'platform', pos: [-0.4, 1.8], props: { w: 0.2 } },
      { id: 'pul', type: 'pulley', pos: [0, 1.8] },
      { id: 'load', type: 'crate', pos: [0.4, 1.0], props: { w: 0.1, h: 0.1, density: 40 } },
    ],
    [{ id: 'r1', type: 'rope', a: { obj: 'anc', anchor: 'bottom' }, b: { obj: 'load', anchor: 'top' }, props: { via: ['pul'] } }],
  );
  // The anchored end is on `ground`, so its span never changes.
  const fixedSpan = Math.hypot(0.4, 1.8 - 0.025 - 1.8);
  // The load's anchor rides on a rotating body, so the `top` point has to be
  // rotated out of the body frame — using (x, y + h/2) would measure the swing.
  const loadSpan = (r) => {
    const p = r.at('load');
    return Math.hypot(p.x - 0.05 * Math.sin(p.rot), p.y + 0.05 * Math.cos(p.rot) - 1.8);
  };
  const budget = fixedSpan + loadSpan(await run(doc, 0));
  let worst = 0;
  for (let steps = 10; steps <= 900; steps += 10) {
    const over = fixedSpan + loadSpan(await run(doc, steps)) - budget;
    if (over > worst) worst = over;
  }
  assert.ok(
    worst < 2 * SIM.ROPE_SLOP,
    `worst stretch over 15 s was ${(worst * 1000).toFixed(3)} mm, budget ${(2 * SIM.ROPE_SLOP * 1000).toFixed(3)} mm`,
  );
});

test('§8.2 pulley rope: a slack rope does not haul its load in', async () => {
  // The unilateral half. The rope is authored 40 cm longer than the path it
  // needs, so for the first stretch of the fall it must do nothing at all —
  // without the activation gate the constraint winches the load up to the
  // pulley instead.
  const doc = scene(
    [
      { id: 'anc', type: 'platform', pos: [-0.4, 1.8], props: { w: 0.2 } },
      { id: 'pul', type: 'pulley', pos: [0, 1.8] },
      { id: 'load', type: 'crate', pos: [0.4, 1.2], props: { w: 0.1, h: 0.1 } },
    ],
    [{ id: 'r1', type: 'rope', a: { obj: 'anc', anchor: 'bottom' }, b: { obj: 'load', anchor: 'top' }, props: { via: ['pul'], length: 1.5 } }],
  );
  const start = (await run(doc, 0)).at('load').y;
  const after = (await run(doc, 20)).at('load').y;
  const freefall = 0.5 * 9.81 * (20 / 60) ** 2;
  assert.ok(after < start, `a slack rope lets the load fall (from ${start.toFixed(4)} to ${after.toFixed(4)})`);
  assert.ok(start - after > freefall * 0.9, 'and it falls at very nearly g');
});

test('§8.2 pulley rope: it pulls and never pushes', async () => {
  // The sign correction. With the multiplier clamped the wrong way the light
  // crate is shoved *down* by the constraint instead of hoisted, so this is the
  // one assertion that separates a working rope from a working-looking one.
  const doc = scene(
    [
      { id: 'floor', type: 'platform', pos: [0, -0.025], props: { w: 4 } },
      { id: 'pul', type: 'pulley', pos: [0, 1.8] },
      { id: 'heavy', type: 'crate', pos: [-0.4, 1.4], props: { w: 0.14, h: 0.14, density: 40 } },
      { id: 'light', type: 'crate', pos: [0.4, 0.05], props: { w: 0.08, h: 0.08 } },
    ],
    [{ id: 'r1', type: 'rope', a: { obj: 'heavy', anchor: 'top' }, b: { obj: 'light', anchor: 'top' }, props: { via: ['pul'] } }],
  );
  const { at } = await run(doc, 180);
  assert.ok(at('heavy').y < 1.4, 'the heavy side descends');
  assert.ok(at('light').y > 0.4, `the light side is hoisted (reached y=${at('light').y.toFixed(3)})`);
});

// ---------------------------------------------------------------------------
// Motors (§6, and U10's fallback — see constraints.ts)
// ---------------------------------------------------------------------------

test('§6 gear motor: reaches `motorSpeed` and respects `maxTorque`', async () => {
  const doc = scene([{ id: 'g1', type: 'gear', pos: [0, 1], props: { r: 0.15, motorSpeed: 90 } }]);
  const a = await run(doc, 60);
  const b = await run(doc, 72);
  assert.ok(Math.abs(angleDelta(a.at('g1').rot, b.at('g1').rot) / (12 / 60) - Math.PI / 2) < 1e-4, 'free gear holds 90 deg/s');

  // The same motor against a mesh load it cannot drive: a tiny torque cap must
  // leave it well short of its commanded speed rather than delivering infinite
  // torque, which is what an uncapped Rapier motor would do.
  const loaded = scene(
    [
      { id: 'ga', type: 'gear', pos: [0, 1], props: { r: 0.15, motorSpeed: 900, maxTorque: 0.0002 } },
      { id: 'gb', type: 'gear', pos: [0.36, 1], props: { r: 0.2 } },
    ],
    [{ id: 'm1', type: 'gearMesh', a: { obj: 'ga' }, b: { obj: 'gb' } }],
  );
  const c = await run(loaded, 6);
  const d = await run(loaded, 12);
  const omega = angleDelta(c.at('ga').rot, d.at('ga').rot) / (6 / 60);
  assert.ok(omega < 900 * (Math.PI / 180) * 0.5, `a 0.2 mN.m motor cannot reach 900 deg/s (got ${omega.toFixed(3)} rad/s)`);
});

test('§6 piston: reaches full stroke at `speed`, and stalls under an over-weight load', async () => {
  const doc = scene([{ id: 'p1', type: 'piston', pos: [0, 0], props: { mode: 'cycle', stroke: 0.15, speed: 0.2, period: 4 } }]);
  // stroke / speed = 0.75 s. Sampled just after that, the head is at the top of
  // its travel; a vertical piston that lost `speed` to gravity would not be.
  const seated = 0.03;
  const { at } = await run(doc, 48);
  assert.ok(Math.abs(at('p1', 'head').y - (seated + 0.15)) < 0.005, `head reached ${at('p1', 'head').y.toFixed(4)}, expected ${(seated + 0.15).toFixed(4)}`);

  const loaded = scene([
    { id: 'p1', type: 'piston', pos: [0, 0], props: { mode: 'cycle', stroke: 0.3, speed: 0.2, force: 0.5, period: 8 } },
    { id: 'zLoad', type: 'crate', pos: [0, 0.16], props: { w: 0.2, h: 0.2, density: 60 } },
  ]);
  const r = await run(loaded, 120);
  assert.ok(r.at('p1', 'head').y < seated + 0.02, `a 0.5 N piston under a 24 N load stays seated (got ${r.at('p1', 'head').y.toFixed(4)})`);
});

test('§6 spring: `stiffness` is newtons per metre — the sag under a load is mg/k', async () => {
  const doc = scene([
    { id: 'sp', type: 'spring', pos: [0, 0], props: { mode: 'passive', travel: 0.08, stiffness: 25, damping: 0.5 } },
    { id: 'zc', type: 'crate', pos: [0, 0.145] },
  ]);
  const { at } = await run(doc, 900);
  // Plate 0.1 x 0.015 at density 5 = 7.5 g; crate 0.08 x 0.08 at density 4 =
  // 25.6 g. Together 0.0331 kg, so the sag is 0.0331 * 9.81 / 25 = 13.0 mm.
  const seated = (0.02 + 0.015) / 2;
  const sag = seated + 0.08 - at('sp', 'plate').y;
  assert.ok(Math.abs(sag - 0.013) < 0.0015, `sag ${(sag * 1000).toFixed(2)} mm, predicted 13.0 mm`);
});

test('§6 spring: `triggered` stays latched until something fires it', async () => {
  const doc = scene([
    { id: 'floor', type: 'platform', pos: [0, -0.025], props: { w: 3 } },
    { id: 'sp', type: 'spring', pos: [0.8, 0], props: { mode: 'triggered', travel: 0.08 } },
    { id: 'tr', type: 'trigger', pos: [0, 0.06], props: { targets: ['sp'] } },
    { id: 'zm', type: 'marble', pos: [-0.8, 0.03], props: { vel: [1.2, 0] } },
  ]);
  const seated = (0.02 + 0.015) / 2;
  const early = await run(doc, 30);
  assert.ok(Math.abs(early.at('sp', 'plate').y - seated) < 1e-4, 'latched: the plate sits on the base');
  const late = await run(doc, 300);
  assert.ok(late.at('sp', 'plate').y > seated + 0.05, `released: the plate rose to ${late.at('sp', 'plate').y.toFixed(4)}`);
});
