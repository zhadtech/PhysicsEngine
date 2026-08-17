// dmath-digest.mjs — the cross-engine determinism probe for DET-5.
//
// Prints one digest over `dsin`/`dcos`/`datan2`/`datan`/`rotate` across the
// engine's whole angle domain. The point is to run it under more than one
// JavaScript engine and get the same line back: that is what "bit-identical on
// every platform" means, and `Math.sin` demonstrably fails it (V8 and JSC
// disagree on 4.62 % of sin samples over this same sweep — the measurement that
// put dmath in the build at all).
//
// Deliberately written to the intersection of Node and the bare `jsc` shell:
// no `console`, no `process`, no Node builtins, relative import specifiers only.
// That is what lets `tools/verify-engine.mjs` run this file under both engines
// and diff two strings, and it is why the sweep is defined here rather than in
// a test — a suite that only ever runs on one engine cannot prove this property.
//
// Usage:
//   node tools/dmath-digest.mjs
//   jsc -m tools/dmath-digest.mjs
// Both must print the digest committed in packages/engine/goldens/dmath.golden.json.

import { datan, datan2, dcos, dsin, rotate } from '../packages/engine/dist/src/sim/dmath.js';

const emit = typeof print === 'function' ? print : console.log;

const scratch = new ArrayBuffer(8);
const asF64 = new Float64Array(scratch);
const asU32 = new Uint32Array(scratch);

/** IEEE-754 bit pattern as 16 hex digits — the only representation that proves *bit*-identity. */
export function bits(x) {
  asF64[0] = x;
  return (asU32[1] >>> 0).toString(16).padStart(8, '0') + (asU32[0] >>> 0).toString(16).padStart(8, '0');
}

/** FNV-1a 32 over text, mirroring packages/engine/src/sim/hash.ts. */
function makeDigest() {
  let h = 0x811c9dc5 >>> 0;
  return {
    feed(s) {
      for (let i = 0; i < s.length; i++) {
        h = Math.imul(h ^ (s.charCodeAt(i) & 0xff), 0x01000193) >>> 0;
        h = Math.imul(h ^ (s.charCodeAt(i) >>> 8), 0x01000193) >>> 0;
      }
    },
    hex: () => (h >>> 0).toString(16).padStart(8, '0'),
  };
}

/** Sample count and sweep — changing either invalidates the committed golden. */
export const SAMPLES = 20000;

/** The i-th sample point: |x| ≤ 4π, the domain DET-5 bounds angles to. */
export function sampleAt(i) {
  return (i / SAMPLES) * 8 * Math.PI - 4 * Math.PI;
}

/** Every value the digest covers, for one sample point. */
export function valuesAt(x) {
  const [rx, ry] = rotate(0.3, -0.7, x);
  return [dsin(x), dcos(x), datan2(x, 1 - x), datan(x), rx, ry];
}

export function digest() {
  const d = makeDigest();
  for (let i = 0; i < SAMPLES; i++) {
    const vs = valuesAt(sampleAt(i));
    for (let k = 0; k < vs.length; k++) d.feed(bits(vs[k]));
  }
  return d.hex();
}

emit(digest());
