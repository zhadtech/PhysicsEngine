// P2c companion check — the §5 worker shell: the §5.1 lifecycle, the §5.2
// command surface, the §5.3 messages and the §5.5 pacer.
//
// The shell is the only part of the engine that reads a clock, so it is the
// only part that *could* leak wall time into a result. §12's command-boundary
// test lives here for that reason, at the level it actually matters: not "the
// same advance() calls give the same hash", but "a run paused, resumed, sped up
// and slowed down at arbitrary wall-clock moments gives the same hash as one
// that ran straight through".
//
// The environment is injected (`WorkerEnv`), so all of this runs headlessly
// with a fake clock and a manual wake queue. The browser leg (tools/golden-browser.mjs)
// then drives the *same* host through a real Worker in a real browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createSimCore,
  frameHash,
  owedSteps,
  capEventBatch,
  SabReader,
  SIM,
  SimStatus,
  SimWorkerHost,
} from '../dist/src/index.js';

function scene(name) {
  return JSON.parse(readFileSync(new URL(`../goldens/scenes/${name}.json`, import.meta.url), 'utf8'));
}

/** A worker environment with a clock the test owns and wakes it must pump. */
function harness({ sharedMemory = true } = {}) {
  const posted = [];
  const wakes = [];
  let clock = 0;
  const env = {
    post: (message, transfer) => posted.push({ message, transfer }),
    now: () => clock,
    wake: (run) => wakes.push(run),
    sharedMemory,
  };
  return {
    env,
    posted,
    messages: (type) => posted.filter((p) => p.message.type === type).map((p) => p.message),
    last: (type) => posted.filter((p) => p.message.type === type).at(-1)?.message,
    advanceClock: (ms) => {
      clock += ms;
    },
    /** Run every scheduled wake once, `n` times over. */
    pump: (n = 1) => {
      for (let i = 0; i < n; i++) for (const run of wakes.splice(0)) run();
    },
    pendingWakes: () => wakes.length,
  };
}

let seq = 0;
const cmd = (command) => ({ seq: ++seq, ...command });

async function booted(options) {
  const h = harness(options);
  const host = await SimWorkerHost.start(h.env, await createSimCore());
  return { ...h, host };
}

test('§5.3 `ready` is posted once at boot, naming the build that actually loaded', async () => {
  const { host, messages, last } = await booted();
  assert.equal(messages('ready').length, 1);
  const ready = last('ready');
  assert.equal(ready.protocolVersion, 1);
  assert.equal(ready.engineVersion, '0.1.0');
  assert.match(ready.physicsBuild, /^@dimforge\/rapier2d-deterministic-compat@0\.19\.3$/);
  assert.equal(ready.transport, 'sab');
  assert.equal(host.phase, 'idle');
});

test('§5.3 `loaded` carries the registry and the shared buffer, then the step-0 frame', async () => {
  const { host, last, posted } = await booted();
  host.handle(cmd({ cmd: 'load', scene: scene('minimal-chain') }));
  const loaded = last('loaded');
  assert.equal(host.phase, 'ready');
  assert.equal(loaded.registry.length, loaded.bodyCount);
  assert.ok(loaded.sab instanceof SharedArrayBuffer);
  assert.deepEqual(loaded.warnings, []);
  // §9.1's order: `loaded` first, then the frame — and the frame is in the SAB,
  // so nothing else is posted for it.
  const reader = SabReader.attach(loaded.sab);
  assert.equal(reader.counter(), 0);
  assert.equal(reader.status(), SimStatus.Ready);
  assert.equal(frameHash(0, reader.slab(reader.readable()[0].slot)), host.core.hash());
  assert.equal(last('ack').ok, true);
  assert.equal(posted.filter((p) => p.message.type === 'error').length, 0);
});

test('§5.3 a rejected scene reports the gate code and returns to idle (§5.1)', async () => {
  const { host, last } = await booted();
  const broken = scene('minimal-chain');
  broken.objects[0].type = 'not-a-thing';
  host.handle(cmd({ cmd: 'load', scene: broken }));
  assert.equal(last('error').code, 'E_SCHEMA');
  assert.equal(last('ack').ok, false);
  assert.equal(host.phase, 'idle');
  // …and the worker is still usable afterwards.
  host.handle(cmd({ cmd: 'load', scene: scene('minimal-chain') }));
  assert.equal(host.phase, 'ready');
});

test('§5.1 commands invalid in the current state are acked ok:false and ignored', async () => {
  const { host, last } = await booted();
  host.handle(cmd({ cmd: 'play' }));
  assert.equal(last('ack').ok, false, 'play before load');
  host.handle(cmd({ cmd: 'load', scene: scene('minimal-chain') }));
  host.handle(cmd({ cmd: 'pause' }));
  assert.equal(last('ack').ok, false, 'pause while ready');
  host.handle(cmd({ cmd: 'play' }));
  assert.equal(host.phase, 'running');
  host.handle(cmd({ cmd: 'play' }));
  assert.equal(last('ack').ok, false, 'play while running');
  host.handle(cmd({ cmd: 'stepN', n: 3 }));
  assert.equal(last('ack').ok, false, 'stepN while running');
  assert.equal(host.core.stepIndex, 0, 'a refused command changes nothing');
});

test('§5.2 stepN validates its range, and works from `ready` (the pre-play paused state)', async () => {
  const { host, last } = await booted();
  host.handle(cmd({ cmd: 'load', scene: scene('mechanism-showcase') }));
  for (const n of [0, -1, 601, 2.5, 'many']) {
    host.handle(cmd({ cmd: 'stepN', n }));
    assert.equal(last('ack').ok, false, `stepN ${n}`);
  }
  assert.equal(host.core.stepIndex, 0);
  host.handle(cmd({ cmd: 'stepN', n: 600 }));
  assert.equal(last('ack').ok, true);
  assert.equal(host.core.stepIndex, 600);
});

test('§5.5 the pacer buys back whole steps from the clock, capped at MAX_CATCHUP', () => {
  const ms = SIM.DT * 1000;
  assert.equal(owedSteps(0, 1, 0), 0);
  assert.equal(owedSteps(ms * 0.99, 1, 0), 0, 'never a partial step');
  assert.equal(owedSteps(ms * 3, 1, 0), 3);
  assert.equal(owedSteps(ms * 3, 2, 0), 6 > SIM.MAX_CATCHUP_STEPS ? SIM.MAX_CATCHUP_STEPS : 6);
  assert.equal(owedSteps(ms * 3, 0.25, 0), 0, 'quarter speed owes a quarter of the steps');
  assert.equal(owedSteps(ms * 8, 0.25, 0), 2);
  assert.equal(owedSteps(ms * 1000, 1, 0), SIM.MAX_CATCHUP_STEPS, 'a stall becomes slow motion, not a spiral');
  assert.equal(owedSteps(ms * 10, 1, 10), 0, 'steps already taken are not owed twice');
});

test('§5.5 a running worker steps on its own wakes and stops when paused', async () => {
  const { host, advanceClock, pump, pendingWakes, last } = await booted();
  host.handle(cmd({ cmd: 'load', scene: scene('minimal-chain') }));
  host.handle(cmd({ cmd: 'play' }));
  assert.equal(pendingWakes(), 1, 'play schedules exactly one wake');
  pump(3);
  assert.equal(host.core.stepIndex, 0, 'no wall time has passed, so nothing is owed');
  advanceClock(SIM.DT * 1000 * 3);
  pump();
  assert.equal(host.core.stepIndex, 3);
  advanceClock(SIM.DT * 1000 * 100);
  pump();
  assert.equal(host.core.stepIndex, 3 + SIM.MAX_CATCHUP_STEPS, 'one wake buys back at most five steps');
  host.handle(cmd({ cmd: 'pause' }));
  const at = host.core.stepIndex;
  advanceClock(10_000);
  pump(5);
  assert.equal(host.core.stepIndex, at, 'a paused run does not step');
  assert.equal(last('ack').ok, true);
  assert.equal(SabReader.attach(host.transport.buffer).status(), SimStatus.Paused);
});

test('§12 command boundaries never change the result (DET-1/DET-8)', async () => {
  // The straight run: 900 steps, no commands.
  const plain = await createSimCore();
  plain.load(scene('mechanism-showcase'));
  plain.advance(900);
  const want = plain.hash();

  // The same 900 steps, chopped up by play/pause/setSpeed at arbitrary wall
  // times and at every speed the protocol allows. Pacing decides *when* steps
  // happen; if it also decided anything about *what* they compute, these two
  // hashes would differ.
  const { host, advanceClock, pump } = await booted();
  host.handle(cmd({ cmd: 'load', scene: scene('mechanism-showcase') }));
  const speeds = [1, 4, 0.25, 2, 0.5, 1];
  let i = 0;
  while (host.core.stepIndex < 900) {
    host.handle(cmd({ cmd: 'setSpeed', speed: speeds[i % speeds.length] }));
    host.handle(cmd({ cmd: 'play' }));
    // Two or three ragged wakes, then a pause somewhere in the middle.
    for (let k = 0; k < 2 + (i % 2); k++) {
      advanceClock(7 + ((i * 13) % 40));
      pump();
    }
    host.handle(cmd({ cmd: 'pause' }));
    i++;
    const left = 900 - host.core.stepIndex;
    if (left > 0 && left <= 600 && i > 12) {
      host.handle(cmd({ cmd: 'stepN', n: left }));
    }
  }
  assert.equal(host.core.stepIndex, 900);
  assert.equal(host.core.hash(), want);
  assert.ok(i > 3, 'the run really was chopped up');
});

test('§5.3 event batches are contiguous and semantic events survive the cap', async () => {
  const { host, messages } = await booted();
  host.handle(cmd({ cmd: 'load', scene: scene('mechanism-showcase') }));
  for (let i = 0; i < 6; i++) host.handle(cmd({ cmd: 'stepN', n: 60 }));
  const batches = messages('events');
  assert.ok(batches.length > 1);
  // The load's own batch is `0 → 0`: the step-0 activations §10 calls the roots
  // of the attribution forest happened at load, not during any step interval.
  assert.equal(batches[0].fromStep, 0);
  assert.equal(batches[0].toStep, 0);
  let cursor = 0;
  for (const batch of batches.slice(1)) {
    assert.equal(batch.fromStep, cursor, 'batches are contiguous and never go backwards');
    assert.ok(batch.toStep > batch.fromStep);
    for (const event of batch.events) {
      // Half-open: an event labelled k was observed while stepping k → k+1, so a
      // batch that ends at `toStep` cannot contain one labelled `toStep` yet.
      assert.ok(event.step >= batch.fromStep && event.step < batch.toStep, `event at ${event.step} outside its batch`);
    }
    cursor = batch.toStep;
  }
  assert.equal(cursor, 360);

  // The cap itself, on a synthetic batch: collisions are trimmed by impulse,
  // everything semantic is kept.
  const many = [];
  for (let i = 0; i < SIM.MAX_SFX_EVENTS_PER_BATCH + 50; i++) {
    many.push({ kind: 'collision', step: 1, a: 'a', b: 'b', impulse: i });
  }
  many.push({ kind: 'goalReached', step: 1, goal: 'g', by: 'm' });
  many.push({ kind: 'triggerFired', step: 1, trigger: 't', by: 'm' });
  const capped = capEventBatch(many);
  assert.equal(capped.length, SIM.MAX_SFX_EVENTS_PER_BATCH + 2);
  assert.equal(capped.filter((e) => e.kind !== 'collision').length, 2);
  const kept = capped.filter((e) => e.kind === 'collision').map((e) => e.impulse);
  assert.equal(Math.min(...kept), 50, 'the weakest collisions are the ones dropped');
  assert.deepEqual(kept, [...kept].sort((x, y) => x - y), 'survivors stay in step order');
});

test('§9.2 a finish is announced once, with the analytics report, and freezes the run', async () => {
  const { host, messages, last } = await booted();
  host.handle(cmd({ cmd: 'load', scene: scene('mechanism-showcase') }));
  host.handle(cmd({ cmd: 'stepN', n: 600 }));
  host.handle(cmd({ cmd: 'stop' }));
  assert.equal(host.phase, 'finished');
  const finished = last('finished');
  assert.equal(finished.reason, 'stopped');
  assert.equal(finished.analytics.finalHash, host.core.hash());
  assert.equal(SabReader.attach(host.transport.buffer).status(), SimStatus.Finished);
  host.handle(cmd({ cmd: 'play' }));
  assert.equal(last('ack').ok, false, 'a finished run does not resume');
  host.handle(cmd({ cmd: 'stop' }));
  assert.equal(last('ack').ok, false);
  assert.equal(messages('finished').length, 1, 'exactly one finish is announced');
});

test('§5.2 reset rewinds to step 0 and republishes, and the rerun matches (§11)', async () => {
  const { host, last } = await booted();
  host.handle(cmd({ cmd: 'load', scene: scene('mechanism-showcase') }));
  const zero = host.core.hash();
  host.handle(cmd({ cmd: 'stepN', n: 300 }));
  const at300 = host.core.hash();
  host.handle(cmd({ cmd: 'reset' }));
  assert.equal(last('ack').ok, true);
  assert.equal(host.phase, 'ready');
  assert.equal(host.core.stepIndex, 0);
  assert.equal(host.core.hash(), zero);
  const reader = SabReader.attach(host.transport.buffer);
  assert.equal(frameHash(0, reader.slab(reader.readable()[0].slot)), zero, 'the buffer was republished, not left stale');
  host.handle(cmd({ cmd: 'stepN', n: 300 }));
  assert.equal(host.core.hash(), at300);
});

test('§5.2 shutdown frees the world, and the fallback transport round-trips its buffers', async () => {
  const { host, posted, last } = await booted({ sharedMemory: false });
  assert.equal(last('ready').transport, 'postmessage');
  host.handle(cmd({ cmd: 'load', scene: scene('minimal-chain') }));
  assert.equal(last('loaded').sab, undefined, 'no shared buffer without cross-origin isolation');
  host.handle(cmd({ cmd: 'stepN', n: 60 }));
  const frames = posted.filter((p) => p.message.type === 'frame');
  assert.equal(frames.length, 2, 'the step-0 frame and one for the stepN batch');
  assert.deepEqual(frames[0].transfer, [frames[0].message.transforms.buffer]);
  assert.equal(frameHash(60, frames[1].message.transforms), host.core.hash());
  // The hand-back is transport plumbing, not a command: no ack, no log entry.
  const acks = posted.filter((p) => p.message.type === 'ack').length;
  host.handle({ type: 'recycle', transforms: frames[0].message.transforms });
  assert.equal(posted.filter((p) => p.message.type === 'ack').length, acks);
  host.handle(cmd({ cmd: 'stepN', n: 1 }));
  assert.equal(posted.filter((p) => p.message.type === 'frame').at(-1).message.transforms, frames[0].message.transforms);
  host.handle(cmd({ cmd: 'shutdown' }));
  assert.equal(host.phase, 'idle');
  assert.equal(last('ack').ok, true);
});

test('§9.2 a run that goes quiet on its own finishes without being told to', async () => {
  const { host, messages, last, advanceClock, pump, pendingWakes } = await booted();
  host.handle(cmd({ cmd: 'load', scene: scene('minimal-chain') }));
  host.handle(cmd({ cmd: 'play' }));
  // minimal-chain goes quiescent at step 309 (goldens/state.golden.json). Let
  // the pacer run it there rather than stepping it by hand.
  for (let i = 0; i < 200 && host.phase === 'running'; i++) {
    advanceClock(200);
    pump();
  }
  assert.equal(host.phase, 'finished');
  assert.equal(host.core.stepIndex, 309);
  assert.equal(last('finished').reason, 'quiescent');
  assert.equal(messages('finished').length, 1);
  assert.equal(last('finished').analytics.finalHash, host.core.hash());
  // The pacing loop stops with the run: no wake is left scheduled.
  pump(3);
  assert.equal(pendingWakes(), 0);
  assert.equal(host.core.stepIndex, 309);
});
