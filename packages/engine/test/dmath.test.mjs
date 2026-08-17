// P2a companion check — deterministic transcendentals (03 §3, DET-5).
//
// Two properties matter, and they are different properties:
//
//   1. *Accuracy* — dmath must agree with a good libm, or every scene is
//      subtly the wrong shape. Checked here against `Math`, which is accurate
//      even where it is not reproducible.
//   2. *Reproducibility* — the same bits on every engine. That one cannot be
//      checked from inside a single engine, so it lives in verify-engine.mjs,
//      which runs tools/dmath-digest.mjs under Node and JavaScriptCore and
//      compares both to the committed golden. What this file can do is pin the
//      golden's spot values, so an accidental change to a coefficient fails
//      here — naming the angle — before it fails there as a moved checksum.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEG2RAD, DMATH_MAX_ARG, datan, datan2, dcos, dsin, length2, rotate } from '../dist/src/index.js';

const golden = JSON.parse(readFileSync(new URL('../goldens/dmath.golden.json', import.meta.url), 'utf8'));

const scratch = new ArrayBuffer(8);
const asF64 = new Float64Array(scratch);
const asU32 = new Uint32Array(scratch);
const asI64 = new BigInt64Array(scratch);

function bits(x) {
  asF64[0] = x;
  return (asU32[1] >>> 0).toString(16).padStart(8, '0') + (asU32[0] >>> 0).toString(16).padStart(8, '0');
}

/** Distance in representable doubles — the only honest unit for "how close". */
function ulps(a, b) {
  const order = (x) => {
    asF64[0] = x;
    const v = asI64[0];
    return v < 0n ? -9223372036854775808n - v : v;
  };
  const d = order(a) - order(b);
  return d < 0n ? -d : d;
}

test('dsin/dcos agree with Math to 1 ULP across the whole domain', () => {
  const n = 50021; // prime-ish, so samples do not land on tidy fractions of pi
  let worstSin = 0n;
  let worstCos = 0n;
  for (let i = 0; i < n; i++) {
    const x = (i / n) * 8 * Math.PI - 4 * Math.PI;
    const ds = ulps(dsin(x), Math.sin(x));
    const dc = ulps(dcos(x), Math.cos(x));
    if (ds > worstSin) worstSin = ds;
    if (dc > worstCos) worstCos = dc;
  }
  assert.ok(worstSin <= 1n, `dsin worst error ${worstSin} ULP`);
  assert.ok(worstCos <= 1n, `dcos worst error ${worstCos} ULP`);
});

test('datan2 agrees with Math to 1 ULP, including across quadrants', () => {
  let worst = 0n;
  for (let i = -400; i <= 400; i++) {
    for (let j = -7; j <= 7; j++) {
      const y = i / 37;
      const x = j / 3;
      if (x === 0 && y === 0) continue;
      const d = ulps(datan2(y, x), Math.atan2(y, x));
      if (d > worst) worst = d;
    }
  }
  assert.ok(worst <= 1n, `datan2 worst error ${worst} ULP`);
});

test('the angles scenes are actually built from come out exact', () => {
  // Multiples of 15° cover every catalog default and every snap step the
  // builder offers (04 §6), so these are the values that must not drift.
  for (let deg = -360; deg <= 360; deg += 15) {
    const x = deg * DEG2RAD;
    assert.ok(ulps(dsin(x), Math.sin(x)) <= 1n, `dsin(${deg}°)`);
    assert.ok(ulps(dcos(x), Math.cos(x)) <= 1n, `dcos(${deg}°)`);
  }
  // Axis-aligned placement must be exactly axis-aligned: a platform at 90°
  // whose cosine is 1e-17 instead of 0 is a platform with a slope.
  assert.equal(dsin(0), 0);
  assert.equal(dcos(0), 1);
  assert.equal(dsin(90 * DEG2RAD), 1);
  assert.equal(dcos(180 * DEG2RAD), -1);
  assert.equal(dsin(-90 * DEG2RAD), -1);
});

test('spot values match the committed cross-engine golden', () => {
  for (const [name, spot] of Object.entries(golden.spots)) {
    asU32[1] = parseInt(spot.x.slice(0, 8), 16);
    asU32[0] = parseInt(spot.x.slice(8), 16);
    const x = asF64[0];
    assert.equal(bits(dsin(x)), spot.dsin, `dsin at ${name}`);
    assert.equal(bits(dcos(x)), spot.dcos, `dcos at ${name}`);
  }
  assert.equal(bits(datan2(1, 0)), golden.datan2['(1,0)']);
  assert.equal(bits(datan2(0, -1)), golden.datan2['(0,-1)']);
  assert.equal(bits(datan2(-0, -1)), golden.datan2['(-0,-1)']);
  assert.equal(bits(datan2(1, 1)), golden.datan2['(1,1)']);
  assert.equal(bits(datan(1)), golden.datan1);
});

test('datan2 keeps the sign conventions the quadrant logic depends on', () => {
  assert.equal(datan2(0, 1), 0);
  assert.ok(Object.is(datan2(-0, 1), -0));
  assert.equal(datan2(0, -1), Math.PI);
  assert.equal(datan2(-0, -1), -Math.PI);
  assert.equal(datan2(1, 0), Math.PI / 2);
  assert.equal(datan2(-1, 0), -Math.PI / 2);
  // −0 vs +0 in a coordinate flips the quadrant — which is exactly why the
  // canonicalizer normalizes −0 away before geometry ever sees it (DET-4).
  assert.notEqual(datan2(-0, -1), datan2(0, -1));
});

test('rotate composes the two calls the expansion tables assume', () => {
  // 90° is π/2 rounded to a double, so its cosine is 6.1e−17 rather than 0 —
  // true of any correctly-rounded libm, and the reason expansion compares
  // positions with a tolerance rather than for equality.
  const [x, y] = rotate(1, 0, 90 * DEG2RAD);
  assert.ok(Math.abs(x) < 1e-16, `cos(90°) residue ${x}`);
  assert.equal(y, 1);
  // Rotation by exactly zero must be exactly the identity, though: an
  // unrotated object may not drift.
  const [a, b] = rotate(0.3, -0.7, 0);
  assert.equal(a, 0.3);
  assert.equal(b, -0.7);
  // dcos(π) is exactly −1 and dsin(π) is ~1e−16, so two half-turns land back
  // within a rounding of the start.
  const [p, q] = rotate(...rotate(2, 5, Math.PI), Math.PI);
  assert.ok(Math.abs(p - 2) < 1e-15 && Math.abs(q - 5) < 1e-15, `round trip ${p},${q}`);
});

test('length2 is exact where it can be', () => {
  assert.equal(length2(3, 4), 5);
  assert.equal(length2(0, 0), 0);
  assert.equal(length2(-3, -4), 5);
});

test('arguments outside the DET-5 domain throw instead of returning nonsense', () => {
  assert.throws(() => dsin(DMATH_MAX_ARG * 2), RangeError);
  assert.throws(() => dcos(Infinity), RangeError);
  assert.ok(Number.isNaN(dsin(NaN)));
  // 4π is the documented domain and must be comfortably inside the guard.
  assert.ok(Number.isFinite(dsin(4 * Math.PI)));
  assert.ok(Number.isFinite(dcos(-4 * Math.PI)));
});
