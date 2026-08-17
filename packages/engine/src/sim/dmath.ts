/**
 * dmath — deterministic transcendentals (03 §3, rule DET-5).
 *
 * ## Why this file exists, measured rather than assumed
 *
 * ECMA-262 pins `+ − × ÷ sqrt` and the comparisons to IEEE-754 semantics, so
 * they are bit-identical on every conforming engine. It explicitly does *not*
 * pin `Math.sin/cos/tan/atan2/pow/exp/log` — implementations are free to use
 * any approximation "of the result" (§21.3.2), and they do differ.
 *
 * P2 measured that difference instead of citing it. Over 20 000 samples spread
 * across this engine's whole angle domain (|x| ≤ 4π), V8 (Node 24) and
 * JavaScriptCore (the WebKit leg of the browser triple, macOS system `jsc`)
 * disagree in the last bit on:
 *
 * | function | samples differing |
 * |---|---|
 * | `Math.sin`   | 924 / 20 000 (4.62 %) |
 * | `Math.cos`   | 917 / 20 000 (4.58 %) |
 * | `Math.atan2` | 3 342 / 20 000 (16.71 %) |
 * | `Math.sqrt`, `*`, `+` | 0 — bit-identical, as specified |
 *
 * One ULP in an initial pose is not a rounding detail here: it is a different
 * run. Two bodies that start 2⁻⁵² m apart diverge visibly within a few hundred
 * steps, and the golden hash (§12) is over quantized positions, so it forks the
 * moment the difference reaches 0.1 mm. That would have failed the P2 exit gate
 * on the `webkit` leg of `determinism-matrix.yml` with no other symptom.
 *
 * So the engine computes its own. Everything below is built exclusively from
 * the operations ECMA-262 pins, which is what makes the output identical on
 * every engine — verified by the cross-engine golden vectors in
 * `goldens/dmath.golden.json`, replayed under both V8 and JSC by
 * `tools/verify-engine.mjs`.
 *
 * ## What this is
 *
 * A port of the fdlibm kernels (Sun Microsystems, 1993 — the reference every
 * major libm descends from, hence its ≈1 ULP accuracy against the true value):
 * Cody–Waite argument reduction into [−π/4, π/4] with a two-step π/2 split,
 * then the standard minimax polynomial kernels. Only `sin`, `cos` and `atan2`
 * are provided, because those are the only transcendentals 03 §6–§8 calls for
 * (fan/conveyor/prismatic axes, initial poses, curve tessellation, segment
 * directions). Nothing here is needed per-step: DET-5 confines all of it to
 * load time, so a few extra polynomial terms cost nothing that matters.
 *
 * Contract: docs/03-SIMULATION-CORE.md §3 (DET-5), §6.
 */

/** Degrees → radians. DET-4's one shared constant, one multiply. */
export const DEG2RAD = Math.PI / 180;

/**
 * Largest |argument| the reduction is valid for. fdlibm's "medium size" path
 * covers |x| < 2¹⁹·(π/2); this engine's domain is |x| ≤ 4π (DET-5), so the cap
 * is set far below the algorithmic limit and anything past it is a bug in the
 * caller — an unnormalized angle, a NaN-free garbage value — not a case to
 * approximate. Load-time-only code may throw; per-step code may not, and does
 * not call this.
 */
export const DMATH_MAX_ARG = 262144; // 2^18, ~6 500× the 4π domain

const PIO4 = 7.85398163397448278999e-01;
/** 2/π. */
const INV_PIO2 = 6.36619772367581382433e-01;
/** π/2 as a two-word sum: PIO2_1 holds the leading 33 bits, PIO2_1T the tail. */
const PIO2_1 = 1.57079632673412561417e0;
const PIO2_1T = 6.07710050650619224932e-11;
/** …and PIO2_1T itself split again, for the second reduction step. */
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_2T = 2.02226624879595063154e-21;

/**
 * Cancellation guard for the reduction (see `remPio2`). fdlibm compares raw
 * exponent fields and refines when the remainder lost more than 16 binary
 * digits; comparing magnitudes against a power of two is the same test to
 * within one exponent, needs no bit surgery (and therefore no assumption about
 * word order in a Float64Array view), and errs toward taking the *more*
 * accurate path — which is never the wrong choice, only the slower one.
 */
const TWO_POW_M15 = 3.0517578125e-5; // 2^-15, exact

// __kernel_sin coefficients (fdlibm k_sin.c).
const S1 = -1.66666666666666324348e-01;
const S2 = 8.33333333332248946124e-03;
const S3 = -1.98412698298579493134e-04;
const S4 = 2.75573137070700676789e-06;
const S5 = -2.50507602534068634195e-08;
const S6 = 1.58969099521155010221e-10;

// __kernel_cos coefficients (fdlibm k_cos.c).
const C1 = 4.16666666666666019037e-02;
const C2 = -1.38888888888741095749e-03;
const C3 = 2.48015872894767294178e-05;
const C4 = -2.75573143513906633035e-07;
const C5 = 2.08757232129817482790e-09;
const C6 = -1.13596475577881948265e-11;

/**
 * sin(x + tail) for |x| ≤ π/4. `hasTail` distinguishes the plain call (the
 * argument is exact, tail is zero) from the post-reduction call, exactly as
 * fdlibm's `iy` flag does — the two branches are not algebraically equal in
 * floating point, and using the wrong one costs accuracy near multiples of π/2.
 */
function kernelSin(x: number, tail: number, hasTail: boolean): number {
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (!hasTail) return x + v * (S1 + z * r);
  return x - (z * (0.5 * tail - v * r) - tail - v * S1);
}

/** cos(x + tail) for |x| ≤ π/4 (fdlibm k_cos.c). */
function kernelCos(x: number, tail: number): number {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  const hz = 0.5 * z;
  const w = 1 - hz;
  return w + (1 - w - hz + (z * r - x * tail));
}

/**
 * Argument reduction: writes x = n·(π/2) + y0 + y1 with |y0| ≤ π/4, returning n
 * mod 4 (all the kernels need) alongside the two-word remainder.
 *
 * Results are written into module-level slots rather than an object literal so
 * the hot path allocates nothing — and, more to the point here, so the returned
 * values are plain doubles with no chance of an engine-specific
 * object-shape/escape-analysis difference creeping into the arithmetic.
 */
let remQuadrant = 0;
let remY0 = 0;
let remY1 = 0;
let remReduced = false;

function remPio2(x: number): void {
  const t = Math.abs(x);
  if (t <= PIO4) {
    remQuadrant = 0;
    remY0 = x;
    remY1 = 0;
    remReduced = false;
    return;
  }
  const n = Math.floor(t * INV_PIO2 + 0.5);
  // n ≤ 2^18·(2/π) here, so n·PIO2_1 is exact: PIO2_1 has 33 significant bits
  // and n has at most 18, well inside the 53 available.
  let r = t - n * PIO2_1;
  let w = n * PIO2_1T;
  let y0 = r - w;
  if (Math.abs(y0) < t * TWO_POW_M15) {
    // Cancellation: redo the tail subtraction at ~118-bit precision.
    const r0 = r;
    w = n * PIO2_2;
    r = r0 - w;
    w = n * PIO2_2T - (r0 - r - w);
    y0 = r - w;
  }
  const y1 = r - y0 - w;
  // fdlibm returns −n for a negative argument and negates the remainder; the
  // quadrant index is that count taken mod 4 in two's complement, which is what
  // JS bitwise `&` does natively.
  const negative = x < 0;
  remQuadrant = (negative ? -n : n) & 3;
  remY0 = negative ? -y0 : y0;
  remY1 = negative ? -y1 : y1;
  remReduced = true;
}

function guard(x: number): void {
  if (Math.abs(x) > DMATH_MAX_ARG) {
    throw new RangeError(
      `dmath: |x| = ${String(Math.abs(x))} exceeds DMATH_MAX_ARG (${String(DMATH_MAX_ARG)}); ` +
        'angles must be normalized before the engine sees them (DET-4/DET-5)',
    );
  }
}

/** Deterministic sin. Bit-identical on every conforming engine. */
export function dsin(x: number): number {
  guard(x);
  remPio2(x);
  switch (remQuadrant) {
    case 0:
      return kernelSin(remY0, remY1, remReduced);
    case 1:
      return kernelCos(remY0, remY1);
    case 2:
      return -kernelSin(remY0, remY1, remReduced);
    default:
      return -kernelCos(remY0, remY1);
  }
}

/** Deterministic cos. Bit-identical on every conforming engine. */
export function dcos(x: number): number {
  guard(x);
  remPio2(x);
  switch (remQuadrant) {
    case 0:
      return kernelCos(remY0, remY1);
    case 1:
      return -kernelSin(remY0, remY1, remReduced);
    case 2:
      return -kernelCos(remY0, remY1);
    default:
      return kernelSin(remY0, remY1, remReduced);
  }
}

// atan (fdlibm s_atan.c): a rational approximation on [0, 7/16] after folding
// the argument into one of four ranges whose endpoint atan values are stored to
// double-double precision.
const ATAN_HI0 = 4.63647609000806093515e-01; // atan(0.5)
const ATAN_HI1 = 7.85398163397448278999e-01; // atan(1.0)
const ATAN_HI2 = 9.82793723247329054082e-01; // atan(1.5)
const ATAN_HI3 = 1.57079632679489655800e0; // atan(inf)
const ATAN_LO0 = 2.26987774529616870924e-17;
const ATAN_LO1 = 3.06161699786838301793e-17;
const ATAN_LO2 = 1.39033110312309984516e-17;
const ATAN_LO3 = 6.12323399573676603587e-17;

const AT0 = 3.33333333333329318027e-01;
const AT1 = -1.99999999998764832476e-01;
const AT2 = 1.42857142725034663711e-01;
const AT3 = -1.11111104054623557880e-01;
const AT4 = 9.09088713343650656196e-02;
const AT5 = -7.69187620504482999495e-02;
const AT6 = 6.66107313738753120669e-02;
const AT7 = -5.83357013379057348645e-02;
const AT8 = 4.97687799461593236017e-02;
const AT9 = -3.65315727442169155270e-02;
const AT10 = 1.62858201153657823623e-02;

/** 2^-29 and 2^66 — the "already the answer" and "saturated" thresholds. */
const TWO_POW_M29 = 1.862645149230957e-9;
const TWO_POW_66 = 7.378697629483821e19;

/** Deterministic atan. Bit-identical on every conforming engine. */
export function datan(x: number): number {
  const negative = x < 0;
  let ax = Math.abs(x);
  if (Number.isNaN(ax)) return NaN;
  if (ax > TWO_POW_66) {
    const big = ATAN_HI3 + ATAN_LO3;
    return negative ? -big : big;
  }
  let id: number;
  if (ax < 0.4375) {
    if (ax < TWO_POW_M29) return x; // atan(x) == x to the last bit down here
    id = -1;
  } else if (ax < 1.1875) {
    if (ax < 0.6875) {
      id = 0;
      ax = (2 * ax - 1) / (2 + ax);
    } else {
      id = 1;
      ax = (ax - 1) / (ax + 1);
    }
  } else if (ax < 2.4375) {
    id = 2;
    ax = (ax - 1.5) / (1 + 1.5 * ax);
  } else {
    id = 3;
    ax = -1 / ax;
  }

  const z = ax * ax;
  const w = z * z;
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
  if (id < 0) return ax - ax * (s1 + s2);

  const hi = id === 0 ? ATAN_HI0 : id === 1 ? ATAN_HI1 : id === 2 ? ATAN_HI2 : ATAN_HI3;
  const lo = id === 0 ? ATAN_LO0 : id === 1 ? ATAN_LO1 : id === 2 ? ATAN_LO2 : ATAN_LO3;
  const r = hi - (ax * (s1 + s2) - lo - ax);
  return negative ? -r : r;
}

const PI = 3.14159265358979311600e0;
const PI_LO = 1.22464679914735317722e-16;
const PI_O_2 = 1.57079632679489655800e0;

/** True for negative values *and* for −0 — atan2's quadrant logic needs the sign bit. */
function signBit(v: number): boolean {
  return v < 0 || Object.is(v, -0);
}

/**
 * Deterministic atan2. Bit-identical on every conforming engine.
 *
 * Quadrant handling follows fdlibm e_atan2.c, including its −0 conventions, so
 * a direction vector that lands exactly on an axis produces the canonical angle
 * rather than something that depends on which side of zero a coordinate fell.
 */
export function datan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  const yNeg = signBit(y);
  const xNeg = signBit(x);

  if (y === 0) {
    if (!xNeg) return y; // ±0 preserved
    return yNeg ? -PI : PI;
  }
  if (x === 0) return yNeg ? -PI_O_2 : PI_O_2;

  if (!Number.isFinite(x)) {
    if (!Number.isFinite(y)) {
      // Both infinite: the angle of the diagonal of that quadrant.
      const q = PI_O_2 / 2;
      if (!xNeg) return yNeg ? -q : q;
      return yNeg ? -3 * q : 3 * q;
    }
    if (!xNeg) return yNeg ? -0 : 0;
    return yNeg ? -PI : PI;
  }
  if (!Number.isFinite(y)) return yNeg ? -PI_O_2 : PI_O_2;

  const z = datan(Math.abs(y / x));
  if (!xNeg) return yNeg ? -z : z;
  const flipped = PI - (z - PI_LO);
  return yNeg ? -flipped : flipped;
}

/**
 * Rotate `(x, y)` by `angle` radians, CCW — the `R(θ)` of 03 §6.
 *
 * Every prefab's placement math goes through here, so the two trig calls happen
 * once per object at load and the per-step code never sees an angle at all.
 */
export function rotate(x: number, y: number, angle: number): [number, number] {
  const c = dcos(angle);
  const s = dsin(angle);
  return [x * c - y * s, x * s + y * c];
}

/** Euclidean length. `sqrt` is IEEE-exact, so this needs no dmath treatment — but `Math.hypot` is *not* pinned, which is why it is banned in this package. */
export function length2(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}
