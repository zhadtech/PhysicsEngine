// P2a companion check — the seeded PRNG (DET-6) and the state hash (§12).
//
// These two are tested together because they share a job: both are the reason a
// run can be *reproduced* rather than merely repeated. The PRNG is the only
// legitimate source of variation in the engine, and the hash is how CI notices
// when something else has become one.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Fnv1a32, Pcg32, fnv1a32, quantizeForHash, stateHash } from '../dist/src/index.js';

/**
 * The published pcg32-demo prefix for seed 42 / stream 54 — the same vector
 * `PCG32_TEST_VECTOR` carries in types/procgen.ts, so the generator procgen
 * draws from at P5 and the one the engine snapshots are provably one algorithm.
 * verify-engine.mjs asserts these two copies agree.
 */
const PCG32_TEST_VECTOR = [0xa15c02b7, 0x7b47f409, 0xba1d3330, 0x83d2f293, 0xbfa4784b, 0xcbed606e];

test('PCG32 reproduces the reference test vector', () => {
  const rng = new Pcg32(42, 54);
  const got = Array.from({ length: PCG32_TEST_VECTOR.length }, () => rng.next());
  assert.deepEqual(got, PCG32_TEST_VECTOR);
});

test('PCG32 output is uint32 and streams differ by sequence', () => {
  const a = new Pcg32(1, 0);
  const b = new Pcg32(1, 1);
  const outA = [];
  const outB = [];
  for (let i = 0; i < 64; i++) {
    const x = a.next();
    assert.ok(Number.isInteger(x) && x >= 0 && x <= 0xffffffff, `not a uint32: ${x}`);
    outA.push(x);
    outB.push(b.next());
  }
  assert.notDeepEqual(outA, outB, 'same seed, different stream must not coincide');
});

test('PCG32 save/restore round-trips exactly — reset rewinds the PRNG (§11)', () => {
  const rng = new Pcg32(7, 3);
  for (let i = 0; i < 10; i++) rng.next();
  const snap = rng.save();
  const expected = Array.from({ length: 20 }, () => rng.next());

  rng.restore(snap);
  assert.deepEqual(Array.from({ length: 20 }, () => rng.next()), expected);

  const rebuilt = Pcg32.from(snap);
  assert.deepEqual(Array.from({ length: 20 }, () => rebuilt.next()), expected);
  // The saved form must survive structuredClone — it rides in the snapshot
  // bundle across the worker boundary.
  assert.deepEqual(structuredClone(snap), snap);
});

test('nextFloat and nextBelow stay in range and consume the stream deterministically', () => {
  const rng = new Pcg32(99, 1);
  for (let i = 0; i < 200; i++) {
    const f = rng.nextFloat();
    assert.ok(f >= 0 && f < 1, `nextFloat out of range: ${f}`);
  }
  const a = new Pcg32(5, 5);
  const b = new Pcg32(5, 5);
  for (let i = 0; i < 100; i++) {
    const bound = 1 + (i % 17);
    const x = a.nextBelow(bound);
    assert.ok(Number.isInteger(x) && x >= 0 && x < bound);
    assert.equal(x, b.nextBelow(bound));
  }
  assert.throws(() => new Pcg32().nextBelow(0), RangeError);
  assert.throws(() => new Pcg32().nextBelow(2.5), RangeError);
});

test('FNV-1a 32 matches the reference digests', () => {
  // Reference vectors for FNV-1a 32 over ASCII.
  assert.equal(new Fnv1a32().hex(), '811c9dc5', 'offset basis');
  assert.equal(new Fnv1a32().byte(0x61).hex(), 'e40c292c', '"a"');
  assert.equal(new Fnv1a32().byte(0x66).byte(0x6f).byte(0x6f).hex(), 'a9f37ed7', '"foo"');
  // `text` feeds UTF-16 code units low byte first, so ASCII picks up a zero
  // byte per character — a different digest from the byte-wise one by design,
  // and the one PG-2's stream labels are hashed with.
  assert.equal(typeof fnv1a32('cand0/lane1/stage2/pick'), 'number');
  assert.equal(fnv1a32('abc'), fnv1a32('abc'));
  assert.notEqual(fnv1a32('abc'), fnv1a32('abd'));
});

test('the state hash sees exactly the quantum §12 specifies', () => {
  const base = [{ x: 1, y: 2, rot: 0.5, state: 1 }];
  const h = stateHash(0, base);

  // Below the quantum: invisible, as it must be — the format only stores four
  // digits, so a hash sensitive to less than that would fail its own
  // round-trip test in §12.
  assert.equal(stateHash(0, [{ x: 1.00004, y: 2, rot: 0.5, state: 1 }]), h);
  // At the quantum: visible.
  assert.notEqual(stateHash(0, [{ x: 1.0001, y: 2, rot: 0.5, state: 1 }]), h);
  // Every field participates, including the step index and the sleep state.
  assert.notEqual(stateHash(1, base), h);
  assert.notEqual(stateHash(0, [{ x: 1, y: 2, rot: 0.5, state: 0 }]), h);
  assert.notEqual(stateHash(0, [{ x: 1, y: 2, rot: 0.5001, state: 1 }]), h);
  // Registry order is part of the definition (DET-3): the same bodies in a
  // different order are a different hash, which is what makes an unsorted
  // iteration somewhere upstream detectable at all.
  const two = [
    { x: 1, y: 2, rot: 0, state: 1 },
    { x: 3, y: 4, rot: 0, state: 1 },
  ];
  assert.notEqual(stateHash(0, two), stateHash(0, [...two].reverse()));
  assert.match(h, /^[0-9a-f]{8}$/);
});

test('hash quantization rounds and wraps rather than saturating', () => {
  assert.equal(quantizeForHash(0), 0);
  assert.equal(quantizeForHash(1), 10000);
  assert.equal(quantizeForHash(0.00005), 1);
  // `Math.round` breaks ties toward +∞ — exactly specified, so both engines
  // agree, which is the only property being relied on here.
  assert.equal(quantizeForHash(-1.00005), -10001); // −10000.500000000002, not a tie
  assert.equal(quantizeForHash(-1.00005000000001), -10001);
  assert.equal(Math.round(-10000.5), -10000);
  // At the DET-10 removal boundary (bounds 200 m + 2 m margin) the quantized
  // value is still three orders inside int32, so wrapping never happens in a
  // scene that passes validation.
  assert.equal(quantizeForHash(202), 2020000);
});
