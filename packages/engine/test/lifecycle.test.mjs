// P2b companion check — expansion (§6), the run lifecycle (§9) and analytics (§10).
//
// These are the parts a golden hash cannot see. A hash is computed over body
// positions, so a wrong `longestChain`, a trigger that fires twice, a finish
// condition that never trips, or a body registry that hands the renderer the
// wrong slot all reproduce perfectly on every platform in the matrix while
// being wrong everywhere.

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

async function load(doc) {
  const sim = await createSimCore();
  const result = sim.load(doc);
  return { sim, ...result };
}

// ---------------------------------------------------------------------------
// §6 Expansion
// ---------------------------------------------------------------------------

test('§5.4 the registry holds dynamic bodies only, in creation order', async () => {
  const { registry, bodyCount } = await load(
    scene([
      { id: 'zPlat', type: 'platform', pos: [0, 0] },
      { id: 'aMarble', type: 'marble', pos: [0, 1] },
      { id: 'mPiston', type: 'piston', pos: [1, 0] },
    ]),
  );
  // Objects expand in id order (DET-3), and within a prefab in the §6 table's
  // row order — so the piston's fixed base takes no slot and its head does.
  assert.deepEqual(registry, [
    { objId: 'aMarble', piece: 'main' },
    { objId: 'mPiston', piece: 'head' },
  ]);
  assert.equal(bodyCount, 2, 'the platform is static and has no slot');
});

test('§6 `anchored` turns a dynamic prefab into scenery with no slot', async () => {
  const free = await load(scene([{ id: 'c1', type: 'crate', pos: [0, 1] }]));
  assert.equal(free.bodyCount, 1);
  const pinned = await load(scene([{ id: 'c1', type: 'crate', pos: [0, 1], props: { anchored: true } }]));
  assert.equal(pinned.bodyCount, 0, 'an anchored crate never moves, so the renderer derives it (§5.3)');
});

test('§6 file order does not change the registry — only id order does', async () => {
  const a = await load(
    scene([
      { id: 'bbb', type: 'marble', pos: [0, 1] },
      { id: 'aaa', type: 'marble', pos: [1, 1] },
    ]),
  );
  const b = await load(
    scene([
      { id: 'aaa', type: 'marble', pos: [1, 1] },
      { id: 'bbb', type: 'marble', pos: [0, 1] },
    ]),
  );
  assert.deepEqual(a.registry, b.registry);
  assert.deepEqual(a.registry.map((r) => r.objId), ['aaa', 'bbb']);
});

test('§9.1 `E_LIMITS` fires before 8 000 bodies are allocated, not after', async () => {
  const objects = [];
  const links = [];
  for (let i = 0; i < 140; i++) {
    objects.push({ id: `a${i}`, type: 'platform', pos: [Number((i * 0.05 - 3.5).toFixed(4)), 2] });
    objects.push({ id: `b${i}`, type: 'crate', pos: [Number((i * 0.05 - 3.5).toFixed(4)), 1] });
    links.push({ id: `r${i}`, type: 'rope', a: { obj: `a${i}`, anchor: 'bottom' }, b: { obj: `b${i}`, anchor: 'top' }, props: { segments: 64 } });
  }
  await assert.rejects(
    async () => load(scene(objects, links, { bounds: [10, 6] })),
    (err) => {
      assert.equal(err.code, 'E_LIMITS');
      assert.match(err.message, /9100 dynamic bodies/);
      assert.match(err.message, new RegExp(String(SIM.MAX_DYNAMIC_BODIES)));
      return true;
    },
  );
});

test('§9.1 load warnings name the object and the problem', async () => {
  const tilted = await load(
    scene([{ id: 'lv', type: 'lever', pos: [0, 1], rot: 60, props: { minAngle: -20, maxAngle: 20 } }]),
  );
  assert.deepEqual(tilted.warnings.map((w) => w.code), ['W_LEVER_ROT_OUTSIDE_LIMITS']);
  assert.equal(tilted.warnings[0].id, 'lv');

  const conflicted = await load(
    scene(
      [
        { id: 'pul', type: 'pulley', pos: [0, 2] },
        { id: 'aa', type: 'crate', pos: [-0.5, 1] },
        { id: 'bb', type: 'crate', pos: [0.5, 1] },
      ],
      [{ id: 'rp', type: 'rope', a: { obj: 'aa' }, b: { obj: 'bb' }, props: { via: ['pul'], segments: 8 } }],
    ),
  );
  assert.deepEqual(conflicted.warnings.map((w) => w.code), ['W_ROPE_VIA_SEGMENTS_CONFLICT']);

  const mismatched = await load(
    scene(
      [
        { id: 'g1', type: 'gear', pos: [0, 1] },
        { id: 'p1', type: 'plank', pos: [0.4, 1] },
      ],
      [{ id: 'ax', type: 'axle', a: { obj: 'g1' }, b: { obj: 'p1' } }],
    ),
  );
  assert.deepEqual(mismatched.warnings.map((w) => w.code), ['W_AXLE_ANCHOR_MISMATCH']);
});

test('§9.1 a correctly authored scene produces no warnings at all', async () => {
  // The counterpart that keeps the warnings above meaningful: a warning that
  // fires on healthy input is noise, and noise gets ignored. The pulley rope is
  // the one to watch — its budget is derived from the very spans it is compared
  // against, so a strict inequality warns on every well-formed rope.
  const { warnings } = await load(
    scene(
      [
        { id: 'pul', type: 'pulley', pos: [0, 2] },
        { id: 'aa', type: 'crate', pos: [-0.5, 1] },
        { id: 'bb', type: 'crate', pos: [0.5, 1] },
      ],
      [{ id: 'rp', type: 'rope', a: { obj: 'aa', anchor: 'top' }, b: { obj: 'bb', anchor: 'top' }, props: { via: ['pul'] } }],
    ),
  );
  assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------
// §9.2 Finish conditions
// ---------------------------------------------------------------------------

test('§9.2 `quiescent`: everything asleep and no live actuator', async () => {
  const { sim } = await load(
    scene([
      { id: 'floor', type: 'platform', pos: [0, -0.025], props: { w: 3 } },
      { id: 'zc', type: 'crate', pos: [0, 0.3] },
    ]),
  );
  sim.advance(3600);
  assert.equal(sim.finished, 'quiescent');
  assert.ok(sim.stepIndex < 3600, `stopped early, at step ${sim.stepIndex}`);
});

test('§9.2 `quiescent` is blocked while an actuator is live', async () => {
  const { sim } = await load(
    scene([
      { id: 'floor', type: 'platform', pos: [0, -0.025], props: { w: 3 } },
      { id: 'gm', type: 'gear', pos: [1, 1], props: { motorSpeed: 90 } },
      { id: 'zc', type: 'crate', pos: [-1, 0.3] },
    ]),
  );
  sim.advance(3600);
  // The gear is still turning, so the run cannot be quiescent — it ends on the
  // idle clause instead, because a gear spinning in a corner moves nothing.
  assert.equal(sim.finished, 'idle');
});

test('§9.2 `idle`: five seconds of nothing happening', async () => {
  const { sim } = await load(
    scene([
      { id: 'floor', type: 'platform', pos: [0, -0.025], props: { w: 3 } },
      { id: 'fn', type: 'fan', pos: [0, 0.5], rot: 90, props: { active: true, range: 0.2 } },
    ]),
  );
  sim.advance(3600);
  assert.equal(sim.finished, 'idle');
  assert.ok(
    sim.stepIndex >= SIM.IDLE_WINDOW_S * 60,
    `the idle window is at least ${SIM.IDLE_WINDOW_S} s (stopped at ${sim.stepIndex})`,
  );
});

test('§9.2 `stopped`: the stop command finishes the run where it stands', async () => {
  const { sim } = await load(scene([{ id: 'm1', type: 'marble', pos: [0, 1] }]));
  sim.advance(30);
  sim.stop();
  assert.equal(sim.finished, 'stopped');
  assert.equal(sim.advance(100), 0, 'a finished run does not advance');
  assert.equal(sim.stepIndex, 30);
});

test('§9.2 a machine still working is not finished', async () => {
  // The complement of the tests above: finish conditions that fire too eagerly
  // would truncate every golden run, and the goldens would still be stable.
  const { sim } = await load(
    scene([
      { id: 'cv', type: 'conveyor', pos: [0, 0], props: { w: 4, h: 0.05, speed: 0.2, active: true } },
      { id: 'zc', type: 'crate', pos: [-1.8, 0.07] },
    ]),
  );
  sim.advance(600);
  assert.equal(sim.finished, null, 'a belt carrying a crate is not idle');
});

// ---------------------------------------------------------------------------
// §9.3 Triggers and goals
// ---------------------------------------------------------------------------

test('§9.3 a `once` trigger fires exactly once; `once: false` re-fires', async () => {
  const build = (once) =>
    scene([
      { id: 'floor', type: 'platform', pos: [0, -0.025], props: { w: 4 } },
      { id: 'tr', type: 'trigger', pos: [0, 0.06], props: { targets: ['fn'], once, w: 0.08, h: 0.08 } },
      { id: 'fn', type: 'fan', pos: [1.5, 1.5], rot: 90, props: { active: false, range: 0.1 } },
      { id: 'zm1', type: 'marble', pos: [-1.2, 0.03], props: { vel: [1.4, 0] } },
      { id: 'zm2', type: 'marble', pos: [-1.6, 0.03], props: { vel: [1.4, 0] } },
    ]);

  const onceRun = await load(build(true));
  onceRun.sim.advance(600);
  const onceFires = onceRun.sim.drain().filter((e) => e.kind === 'triggerFired');
  assert.equal(onceFires.length, 1, 'two marbles crossed, one firing');

  const manyRun = await load(build(false));
  manyRun.sim.advance(600);
  const manyFires = manyRun.sim.drain().filter((e) => e.kind === 'triggerFired');
  assert.ok(manyFires.length >= 2, `once: false re-fires per entry (got ${manyFires.length})`);
});

test('DET-9 a trigger effect lands on the step after the entry, never during it', async () => {
  const { sim } = await load(
    scene([
      { id: 'floor', type: 'platform', pos: [0, -0.025], props: { w: 4 } },
      { id: 'tr', type: 'trigger', pos: [0, 0.06], props: { targets: ['cv'] } },
      { id: 'cv', type: 'conveyor', pos: [2, 1.5], props: { active: false } },
      { id: 'zm', type: 'marble', pos: [-1.2, 0.03], props: { vel: [1.4, 0] } },
    ]),
  );
  sim.advance(600);
  const events = sim.drain();
  const fired = events.find((e) => e.kind === 'triggerFired');
  const toggled = events.find((e) => e.kind === 'actuator' && e.obj === 'cv');
  assert.ok(fired, 'the trigger fired');
  assert.ok(toggled, 'the conveyor was toggled');
  assert.equal(toggled.step, fired.step + 1, 'the effect is applied at the start of the next step');
  assert.equal(toggled.active, true);
});

test('§9.3 a goal only accepts the objects it lists', async () => {
  const build = (accepts) =>
    scene([
      { id: 'floor', type: 'platform', pos: [0, -0.025], props: { w: 4 } },
      { id: 'gl', type: 'goal', pos: [0.8, 0.06], props: { accepts, w: 0.12, h: 0.12 } },
      { id: 'zm', type: 'marble', pos: [-1, 0.03], props: { vel: [1.4, 0] } },
    ]);

  const anyRun = await load(build('any'));
  anyRun.sim.advance(600);
  assert.equal(anyRun.sim.report().success, true, 'accepts "any" is satisfied by the marble');

  const namedRun = await load(build(['floor']));
  namedRun.sim.advance(600);
  assert.equal(namedRun.sim.report().success, false, 'a goal listing another object is not satisfied by the marble');
});

test('§9.3 the run continues after a goal is satisfied', async () => {
  const { sim } = await load(
    scene([
      { id: 'floor', type: 'platform', pos: [0, -0.025], props: { w: 4 } },
      { id: 'gl', type: 'goal', pos: [0, 0.06], props: { w: 0.12, h: 0.12 } },
      { id: 'zm', type: 'marble', pos: [-1, 0.03], props: { vel: [1.4, 0] } },
    ]),
  );
  sim.advance(120);
  assert.equal(sim.report().success, true);
  assert.equal(sim.finished, null, 'success is not a finish condition — chains carry on');
});

// ---------------------------------------------------------------------------
// DET-10 Removal
// ---------------------------------------------------------------------------

test('DET-10 a body that leaves the board is removed, once, and stays removed', async () => {
  const { sim, bodyCount } = await load(
    scene([{ id: 'm1', type: 'marble', pos: [0, 0], props: { vel: [12, 0] } }], [], { bounds: [4, 2.4] }),
  );
  sim.advance(600);
  const removals = sim.drain().filter((e) => e.kind === 'removed');
  assert.equal(removals.length, 1, 'exactly one removal event');
  assert.equal(removals[0].obj, 'm1');
  assert.equal(sim.report().removedCount, 1);

  const frame = new Float32Array(bodyCount * 4);
  sim.writeFrame(frame);
  assert.deepEqual([...frame], [0, 0, 0, 2], 'a removed body publishes (0, 0, 0, Removed)');
});

test('DET-10 removal happens on the sweep cadence, not the instant it crosses', async () => {
  const { sim } = await load(
    scene([{ id: 'm1', type: 'marble', pos: [0, 0], props: { vel: [12, 0] } }], [], { bounds: [4, 2.4] }),
  );
  sim.advance(600);
  const removed = sim.drain().find((e) => e.kind === 'removed');
  assert.equal(removed.step % SIM.REMOVAL_SWEEP_STEPS, 0, `removed at step ${removed.step}`);
});

test('DET-10 leaves everything inside the bounds alone', async () => {
  const { sim } = await load(
    scene([
      { id: 'floor', type: 'platform', pos: [0, -0.025], props: { w: 3 } },
      { id: 'zc', type: 'crate', pos: [0, 0.3] },
    ]),
  );
  sim.advance(900);
  assert.equal(sim.report().removedCount, 0);
});

// ---------------------------------------------------------------------------
// §10 Analytics
// ---------------------------------------------------------------------------

test('§10 the activatable set excludes pure structure', async () => {
  const { sim } = await load(
    scene([
      { id: 'plat', type: 'platform', pos: [0, -0.025] },
      { id: 'rmp', type: 'ramp', pos: [1, 0] },
      { id: 'crv', type: 'curve', pos: [2, 1] },
      { id: 'pul', type: 'pulley', pos: [3, 1] },
      { id: 'mar', type: 'marble', pos: [0, 1] },
      { id: 'fan', type: 'fan', pos: [1, 1], props: { active: false } },
    ]),
  );
  // Six objects, four of them scenery. A platform that never moves is not a
  // machine part that failed to fire.
  assert.equal(sim.report().activatableCount, 2);
});

test('§10 a domino chain is attributed contact by contact', async () => {
  const objects = [
    { id: 'floor', type: 'platform', pos: [0, -0.025], props: { w: 3 } },
    { id: 'zm', type: 'marble', pos: [-0.75, 0.03], props: { vel: [1.2, 0] } },
  ];
  for (let i = 0; i < 5; i++) objects.push({ id: `d${i}`, type: 'domino', pos: [Number((-0.6 + i * 0.06).toFixed(4)), 0] });
  const { sim } = await load(scene(objects));
  sim.advance(1200);

  const report = sim.report();
  assert.equal(report.objectsActivated, 6, 'the marble and all five dominoes moved');
  assert.equal(report.chainReactions, 5, 'five cause-effect edges');
  assert.equal(report.longestChain, 5, 'and they form one unbroken path');

  const causes = sim.drain().filter((e) => e.kind === 'activation');
  assert.equal(causes[0].obj, 'zm');
  assert.equal(causes[0].cause, undefined, 'the marble is a root — nothing caused it');
  for (let i = 1; i < causes.length; i++) {
    assert.equal(causes[i].cause.via, 'contact', `${causes[i].obj} was knocked over`);
  }
});

test('§10 attribution rule 0: a trigger is caused by whatever entered it (D14)', async () => {
  const { sim } = await load(
    scene([
      { id: 'floor', type: 'platform', pos: [0, -0.025], props: { w: 4 } },
      { id: 'tr', type: 'trigger', pos: [0, 0.06], props: { targets: ['fn'] } },
      { id: 'fn', type: 'fan', pos: [0.6, 0.4], rot: 0, props: { active: false, range: 0.6, strength: 1 } },
      { id: 'zm', type: 'marble', pos: [-1.2, 0.03], props: { vel: [1.4, 0] } },
    ]),
  );
  sim.advance(900);
  const activations = sim.drain().filter((e) => e.kind === 'activation');
  const trigger = activations.find((e) => e.obj === 'tr');
  assert.ok(trigger, 'the trigger activated');
  // Without rule 0 the trigger would be a root, and the chain would restart at
  // every signal hand-off — which is exactly the bug D14 was opened for.
  assert.deepEqual(trigger.cause, { via: 'sensor', from: 'zm' });

  const fan = activations.find((e) => e.obj === 'fn');
  assert.ok(fan, 'and the fan it switched on activated too');
  assert.equal(sim.report().longestChain >= 2, true, 'so the chain runs marble → trigger → fan');
});

test('§10 `efficiencyScore` follows its formula, and success is worth 20 points', async () => {
  const build = (withGoal) =>
    scene([
      { id: 'floor', type: 'platform', pos: [0, -0.025], props: { w: 4 } },
      { id: 'zm', type: 'marble', pos: [-1, 0.03], props: { vel: [1.4, 0] } },
      ...(withGoal ? [{ id: 'gl', type: 'goal', pos: [0, 0.06], props: { w: 0.12, h: 0.12 } }] : []),
    ]);

  const missed = await load(build(false));
  missed.sim.advance(900);
  const a = missed.sim.report();
  assert.equal(a.success, false);
  assert.equal(a.activatableCount, 1);
  assert.equal(a.objectsActivated, 1);
  // A = 1, longestChain = 0, S = 0  ->  round(100 * 0.45) = 45.
  assert.equal(a.efficiencyScore, 45);

  const scored = await load(build(true));
  scored.sim.advance(900);
  const b = scored.sim.report();
  assert.equal(b.success, true);
  assert.equal(b.activatableCount, 2, 'the goal is activatable too');
  // A = 1, longestChain = 1 over max(3, 1) = 3, S = 1
  //   ->  round(100 * (0.45 + 0.35/3 + 0.20)) = 77.
  assert.equal(b.longestChain, 1);
  assert.equal(b.efficiencyScore, 77);
});

test('§10 `maxSpeedMS` names the fastest body, ties going to the smaller id', async () => {
  const { sim } = await load(
    scene([
      { id: 'aSlow', type: 'marble', pos: [-1, 1], props: { vel: [1, 0] } },
      { id: 'bFast', type: 'marble', pos: [1, 1], props: { vel: [4, 0] } },
    ], [], { gravity: 0, bounds: [200, 100] }),
  );
  sim.advance(60);
  const report = sim.report();
  assert.equal(report.maxSpeedObj, 'bFast');
  assert.ok(Math.abs(report.maxSpeedMS - 4) < 1e-6, `max speed ${report.maxSpeedMS}`);
});

test('§10 `durationS` is when the machine stopped, not when the run ended', async () => {
  const { sim } = await load(
    scene([
      { id: 'floor', type: 'platform', pos: [0, -0.025], props: { w: 3 } },
      { id: 'zc', type: 'crate', pos: [0, 0.5] },
    ]),
  );
  sim.advance(3600);
  const report = sim.report();
  assert.ok(report.durationS > 0, 'the crate fell, so something happened');
  assert.ok(report.durationS < report.simEndS, `duration ${report.durationS} < end ${report.simEndS}`);
});

test('§5.3 semantic events survive a batch that overflows the collision cap', async () => {
  // MAX_SFX_EVENTS_PER_BATCH caps collision events per publish. Semantic events
  // — activations, triggers, goals, removals — are never dropped, and this is
  // the scene where that distinction has teeth.
  const objects = [{ id: 'floor', type: 'platform', pos: [0, -0.025], props: { w: 10 } }];
  for (let i = 0; i < 400; i++) objects.push({ id: `d${String(i).padStart(3, '0')}`, type: 'domino', pos: [Number((-4.7 + i * 0.023).toFixed(4)), 0] });
  objects.push({ id: 'zk', type: 'marble', pos: [-4.9, 0.12], props: { vel: [2, 0] } });
  const { sim } = await load(scene(objects, [], { bounds: [12, 4] }));
  sim.advance(600);
  const events = sim.drain();
  const collisions = events.filter((e) => e.kind === 'collision');
  const activations = events.filter((e) => e.kind === 'activation');
  assert.ok(collisions.length > 0, 'collisions are reported');
  assert.ok(activations.length > 50, `activations are not capped (got ${activations.length})`);
});
