// P2c companion check — the §5.4 triple buffer and the §5.5 interpolation rules.
//
// The transport is the one place in the engine where two threads touch the same
// memory, and the one place where the numbers the determinism matrix compares
// pass through a representation change (f64 poses → an f32 slab). Both are
// checked here rather than argued:
//
//   - the writer never writes a slot a reader is allowed to hold, at any point
//     in the rotation — the property the three slots exist for;
//   - hashing what came *out* of the buffer equals hashing the live bodies,
//     over the corpus. That equality is what makes the browser leg of the
//     matrix meaningful at all: a page cannot reach into the worker's world, so
//     it hashes the frame, and the number it gets has to be the same number
//     Node computed a different way.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  advancePlayhead,
  createSimCore,
  frameHash,
  lerpAngle,
  lerpFrames,
  PostMessageTransport,
  SAB,
  SabHeader,
  SabReader,
  SabTransport,
  sabByteLength,
  sampleAt,
  slabFloats,
  SimStatus,
  chooseTransport,
} from '../dist/src/index.js';

const QUICK = ['minimal-chain', 'mechanism-showcase', 'catalog', 'pulley-lift', 'gear-chain', 'all-fields'];

function scene(name) {
  return JSON.parse(readFileSync(new URL(`../goldens/scenes/${name}.json`, import.meta.url), 'utf8'));
}

test('§5.4 the header identifies the buffer before anything reads a pose', () => {
  const t = new SabTransport(7);
  assert.equal(t.buffer.byteLength, sabByteLength(7));
  const header = new Int32Array(t.buffer, 0, SAB.HEADER_WORDS);
  assert.equal(header[SabHeader.Magic], SAB.MAGIC);
  assert.equal(header[SabHeader.LayoutVersion], SAB.LAYOUT_VERSION);
  assert.equal(header[SabHeader.BodyCount], 7);
  // Nothing published yet: a reader must be able to tell.
  assert.equal(header[SabHeader.WriteCounter], -1);
  assert.deepEqual(SabReader.attach(t.buffer).readable(), []);
});

test('§5.4 a reader refuses a buffer that is not ours, or is not this layout', () => {
  assert.throws(() => SabReader.attach(new SharedArrayBuffer(64)), /not a sim buffer/);
  const t = new SabTransport(2);
  new Int32Array(t.buffer, 0, SAB.HEADER_WORDS)[SabHeader.LayoutVersion] = 2;
  assert.throws(() => SabReader.attach(t.buffer), /layoutVersion 2/);
});

test('§5.4 the writer never targets a slot the reader may be holding', () => {
  const bodies = 3;
  const t = new SabTransport(bodies);
  const reader = SabReader.attach(t.buffer);
  for (let step = 0; step < 12; step++) {
    // What the reader is entitled to hold *before* this publish.
    const held = new Set(reader.readable().map((s) => s.slot));
    let written = -1;
    t.publish(step, SimStatus.Running, (target) => {
      written = (reader.counter() + 1) % SAB.SLOTS;
      target.fill(step);
    });
    assert.ok(!held.has(written), `step ${step}: wrote slot ${written} while the reader could hold ${[...held]}`);
    assert.equal(reader.counter(), step);
    assert.equal(reader.latestStepIndex(), step);
    assert.equal(reader.status(), SimStatus.Running);
  }
  const readable = reader.readable();
  assert.equal(readable.length, 2, 'after the first publish there are always exactly two safe slots');
  assert.equal(readable[0].stepIndex, 11);
  assert.equal(readable[1].stepIndex, 10);
  assert.equal(reader.slab(readable[0].slot)[0], 11);
});

test('§5.4 hashing the published frame equals hashing the live bodies', async () => {
  for (const name of QUICK) {
    const sim = await createSimCore();
    const load = sim.load(scene(name));
    const transport = new SabTransport(load.bodyCount);
    const reader = SabReader.attach(transport.buffer);
    for (let i = 0; i < 6 && sim.finished === null; i++) {
      transport.publish(sim.stepIndex, SimStatus.Running, (target) => sim.writeFrame(target));
      const slot = reader.readable()[0];
      assert.equal(
        frameHash(slot.stepIndex, reader.slab(slot.slot)),
        sim.hash(),
        `${name} at step ${sim.stepIndex}: the buffer and the world disagree`,
      );
      sim.advance(60);
    }
    sim.dispose();
  }
});

test('§5.4 the fallback transport carries the same frame as shared memory', async () => {
  const sim = await createSimCore();
  const load = sim.load(scene('minimal-chain'));
  const shared = new SabTransport(load.bodyCount);
  const posted = [];
  const fallback = new PostMessageTransport(load.bodyCount, (message, transfer) => posted.push({ message, transfer }));
  sim.advance(120);
  shared.publish(sim.stepIndex, SimStatus.Running, (t) => sim.writeFrame(t));
  fallback.publish(sim.stepIndex, SimStatus.Running, (t) => sim.writeFrame(t));
  const slot = SabReader.attach(shared.buffer).readable()[0];
  const { message, transfer } = posted[0];
  assert.equal(message.type, 'frame');
  assert.equal(message.stepIndex, sim.stepIndex);
  assert.deepEqual([...message.transforms], [...SabReader.attach(shared.buffer).slab(slot.slot)]);
  assert.equal(frameHash(message.stepIndex, message.transforms), sim.hash());
  assert.deepEqual(transfer, [message.transforms.buffer], 'the slab must be transferred, not copied');
  sim.dispose();
});

test('§5.3 the fallback pool recycles three buffers and refuses foreign ones', () => {
  const posted = [];
  const t = new PostMessageTransport(4, (message) => posted.push(message));
  const fill = (target) => target.fill(1);
  t.publish(0, SimStatus.Running, fill);
  t.publish(1, SimStatus.Running, fill);
  assert.notEqual(posted[0].transforms, posted[1].transforms, 'an un-returned buffer is never reused');
  t.recycle(posted[0].transforms);
  t.publish(2, SimStatus.Running, fill);
  assert.equal(posted[2].transforms, posted[0].transforms, 'a returned buffer is reused');
  // The pool is bounded, and a buffer of the wrong size is not ours.
  for (let i = 0; i < 6; i++) t.recycle(new Float32Array(slabFloats(4)));
  t.recycle(new Float32Array(slabFloats(9)));
  const before = posted.length;
  for (let i = 0; i < 4; i++) t.publish(3 + i, SimStatus.Running, fill);
  const reused = posted.slice(before).filter((m) => m.transforms.length === slabFloats(4));
  assert.equal(reused.length, 4);
});

test('§5.3 the transport choice follows crossOriginIsolated', () => {
  assert.equal(chooseTransport(true, 2, () => {}).kind, 'sab');
  assert.equal(chooseTransport(false, 2, () => {}).kind, 'postmessage');
});

test('§5.5 angles interpolate along the shortest arc', () => {
  const near = Math.PI - 0.1;
  const far = -Math.PI + 0.1;
  // The long way round is 2π − 0.2; the short way is 0.2 through ±π.
  assert.ok(Math.abs(lerpAngle(near, far, 0.5) - (near + 0.1)) < 1e-12);
  assert.equal(lerpAngle(0.25, 0.75, 0), 0.25);
  assert.ok(Math.abs(lerpAngle(0.25, 0.75, 1) - 0.75) < 1e-12);
});

test('§5.5 the playhead stays between 0.5 and 2 steps behind the newest frame', () => {
  // Free-running: 1/60 s of display time at 1× advances exactly one step.
  assert.ok(Math.abs(advancePlayhead(97, 1 / 60, 1, 100) - 98) < 1e-12);
  // Too far ahead is clamped to latest − 0.5; too far behind to latest − 2.
  assert.equal(advancePlayhead(120, 1 / 60, 4, 100), 99.5);
  assert.equal(advancePlayhead(10, 1 / 60, 1, 100), 98);
  // A stalled worker cannot make the renderer run past what exists.
  let p = 0;
  for (let i = 0; i < 200; i++) p = advancePlayhead(p, 1 / 60, 4, 30);
  assert.equal(p, 29.5);
});

test('§5.5 α comes from the published step indices, and state is not interpolated', () => {
  const from = Float32Array.from([0, 0, 0, 1]);
  const to = Float32Array.from([10, -4, 1, 0]);
  const out = new Float32Array(4);
  // Two frames five steps apart: halfway between them is step 102.5.
  assert.equal(lerpFrames(from, 100, to, 105, 102.5, out), 0.5);
  assert.deepEqual([...out], [5, -2, 0.5, 1]);
  // Outside the pair, α saturates rather than extrapolating.
  assert.equal(lerpFrames(from, 100, to, 105, 400, out), 1);
  assert.equal(lerpFrames(from, 100, to, 105, -400, out), 0);
  // Degenerate pair (both slots the same step): take the newer frame.
  assert.equal(lerpFrames(from, 100, to, 100, 100, out), 1);
});

test('§5.5 sampling before the first publish reports that there is nothing to draw', () => {
  const t = new SabTransport(1);
  const reader = SabReader.attach(t.buffer);
  const out = new Float32Array(slabFloats(1));
  assert.equal(sampleAt(reader, 0, out), null);
  t.publish(0, SimStatus.Ready, (target) => target.set([1, 2, 3, 1]));
  assert.equal(sampleAt(reader, 0, out), 1, 'one frame is copied as-is');
  assert.deepEqual([...out], [1, 2, 3, 1]);
  t.publish(1, SimStatus.Running, (target) => target.set([3, 2, 3, 1]));
  assert.equal(sampleAt(reader, 0.5, out), 0.5);
  assert.deepEqual([...out], [2, 2, 3, 1]);
});
