/**
 * PCG32 — the engine's single pseudo-random source (03 §3, rule DET-6).
 *
 * PCG-XSH-RR 64/32 with the reference constants. v1 physics draws zero random
 * numbers; the generator exists so that everything which *will* need randomness
 * — future engine features, and procgen at P5 (06 §3, PG-2 names this same
 * algorithm) — shares one seeded, snapshot-able source instead of reaching for
 * `Math.random`, which is unseeded, unspecified, and would make a run
 * unreproducible the moment it was called.
 *
 * The state is 64-bit and is carried in `BigInt`, which ECMA-262 defines as
 * exact arbitrary-precision integer arithmetic — no rounding, therefore no
 * cross-engine variance, the same reasoning DET-5 applies to the float ops.
 * 06 §3 (PG-2) allows a Uint32-pair variant later on the condition that it stays
 * bit-identical to this one; `PCG32_TEST_VECTOR` is what would hold it to that.
 *
 * Contract: docs/03-SIMULATION-CORE.md §3 (DET-6), §11 (state is snapshotted).
 */

const MASK64 = (1n << 64n) - 1n;
const MASK32 = 0xffffffffn;
const MULTIPLIER = 6364136223846793005n;

/** Serializable generator state — part of `ExtraState` in every snapshot (§11). */
export interface Pcg32State {
  /** u64 as a decimal string: survives `structuredClone` and JSON alike. */
  state: string;
  /** u64 as a decimal string; always odd. */
  inc: string;
}

export class Pcg32 {
  #state: bigint;
  #inc: bigint;

  /**
   * @param initState the seed (`world.seed`, or a procgen stream seed)
   * @param initSeq   stream selector — two generators with the same seed and
   *                  different sequences produce distinct, non-overlapping
   *                  streams, which is what PG-2's labeled streams rely on
   */
  constructor(initState: number | bigint = 0n, initSeq: number | bigint = 0n) {
    this.#state = 0n;
    this.#inc = ((BigInt(initSeq) << 1n) | 1n) & MASK64;
    this.next();
    this.#state = (this.#state + (BigInt(initState) & MASK64)) & MASK64;
    this.next();
  }

  /** Next uint32. */
  next(): number {
    const old = this.#state;
    this.#state = (old * MULTIPLIER + this.#inc) & MASK64;
    const xorshifted = Number((((old >> 18n) ^ old) >> 27n) & MASK32);
    const rot = Number((old >> 59n) & 31n);
    // Rotate right by `rot`, in uint32. `>>> 0` keeps every intermediate
    // unsigned; `(-rot) & 31` is the complement rotation with rot = 0 handled
    // (a plain `32 - rot` would shift by 32, which is a no-op in JS, not zero).
    return (((xorshifted >>> rot) | (xorshifted << ((-rot) & 31))) >>> 0) as number;
  }

  /** Uniform float in [0, 1) with 32 bits of entropy. Division by 2³² is exact. */
  nextFloat(): number {
    return this.next() / 4294967296;
  }

  /**
   * Uniform integer in [0, bound). Rejection-sampled rather than taken modulo,
   * so the distribution is exactly uniform and — the part that matters here —
   * the number of draws consumed is a deterministic function of the stream.
   */
  nextBelow(bound: number): number {
    if (!Number.isInteger(bound) || bound <= 0) {
      throw new RangeError(`Pcg32.nextBelow: bound must be a positive integer, got ${String(bound)}`);
    }
    const threshold = (0x100000000 - bound) % bound;
    for (;;) {
      const r = this.next();
      if (r >= threshold) return r % bound;
    }
  }

  /** Snapshot the generator (§11). */
  save(): Pcg32State {
    return { state: this.#state.toString(), inc: this.#inc.toString() };
  }

  /** Restore a snapshot (§11) — `reset` must rewind the PRNG with everything else. */
  restore(s: Pcg32State): void {
    this.#state = BigInt(s.state) & MASK64;
    this.#inc = BigInt(s.inc) & MASK64;
  }

  /** Rebuild a generator from a saved state. */
  static from(s: Pcg32State): Pcg32 {
    const g = new Pcg32();
    g.restore(s);
    return g;
  }
}
