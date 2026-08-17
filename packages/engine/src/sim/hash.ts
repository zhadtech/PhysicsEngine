/**
 * State hashing — FNV-1a 32 (03 §12).
 *
 * The state hash is the whole determinism programme in one number. It is what
 * `determinism-matrix.yml` compares across linux-x64, macos-arm64 and the
 * browser triple; what a leaderboard submission carries so a run can be
 * re-verified server-side (08 §5, D17); and what the double-run, snapshot and
 * round-trip suites in §12 assert on. So its definition is part of the
 * `engineVersion` surface: changing anything below — the quantum, the field
 * order, the byte encoding — changes every golden hash in the repo and is an
 * engineVersion bump, not a refactor.
 *
 * 03 §12 fixes the digest (FNV-1a 32), the quantum (1e-4 m, matching the format's
 * 4-digit writer rule so the hash can never be more precise than the document
 * that produced it) and the field set (x, y, rot, state per dynamic body in
 * registry order, plus stepIndex). It does not fix how those integers become
 * bytes, and two implementations that disagree there produce different hashes
 * from identical physics — so this file pins that too: **little-endian int32,
 * stepIndex first, then each body's four fields in order**.
 *
 * Contract: docs/03-SIMULATION-CORE.md §12.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Position/rotation quantum for hashing: 1e-4, the 02 §2 writer precision. */
export const HASH_QUANTUM = 1e4;

/**
 * Incremental FNV-1a 32. `Math.imul` is the exact int32 multiply — plain `*`
 * would go through a double and lose the high bits above 2⁵³.
 */
export class Fnv1a32 {
  #h = FNV_OFFSET_BASIS >>> 0;

  /** Absorb one byte (only the low 8 bits are read). */
  byte(b: number): this {
    this.#h = Math.imul(this.#h ^ (b & 0xff), FNV_PRIME) >>> 0;
    return this;
  }

  /** Absorb a 32-bit integer, little-endian. Values are wrapped to int32 first. */
  int32(v: number): this {
    const n = v | 0;
    return this.byte(n).byte(n >>> 8).byte(n >>> 16).byte(n >>> 24);
  }

  /** Absorb a string as UTF-16 code units, low byte first. */
  text(s: string): this {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      this.byte(c).byte(c >>> 8);
    }
    return this;
  }

  /** Current digest as an unsigned 32-bit number. */
  value(): number {
    return this.#h >>> 0;
  }

  /** Current digest as 8 lowercase hex digits — the form goldens are committed in. */
  hex(): string {
    return this.#h.toString(16).padStart(8, '0');
  }
}

/** One-shot FNV-1a 32 over a string. This is the hash PG-2 labels streams with. */
export function fnv1a32(s: string): number {
  return new Fnv1a32().text(s).value();
}

/** A dynamic body's contribution to the state hash, in registry order. */
export interface HashableBody {
  x: number;
  y: number;
  /** Radians (engine-native; only the file format uses degrees). */
  rot: number;
  /** `BodyState`: 0 asleep, 1 awake, 2 removed. */
  state: number;
}

/**
 * Quantize a coordinate for hashing: metres → tenth-millimetre integers.
 *
 * `Math.round` is exactly specified (ties toward +∞), and `| 0` wraps rather
 * than saturating — deliberately, so a body that has escaped to an absurd
 * coordinate still hashes to *something* reproducible instead of clamping many
 * distinct states onto one value. Bodies that far out are removed by DET-10
 * within 15 steps anyway; at the removal boundary (bounds ≤ 200 m + 2 m margin)
 * the quantized value is ~2.02e6, three orders inside int32.
 */
export function quantizeForHash(v: number): number {
  return Math.round(v * HASH_QUANTUM) | 0;
}

/**
 * The normative state hash (§12): FNV-1a 32 over `stepIndex` followed by
 * `(x, y, rot, state)` per dynamic body in registry order.
 */
export function stateHash(stepIndex: number, bodies: readonly HashableBody[]): string {
  const h = new Fnv1a32();
  h.int32(stepIndex);
  for (const b of bodies) {
    h.int32(quantizeForHash(b.x));
    h.int32(quantizeForHash(b.y));
    h.int32(quantizeForHash(b.rot));
    h.int32(b.state | 0);
  }
  return h.hex();
}
