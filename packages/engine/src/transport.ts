/**
 * Transport — the §5.4 shared-buffer triple buffer and its postMessage fallback.
 *
 * This file and `worker.ts` are the only two in the package that know a browser
 * exists (03 §1 rule 1), and they are deliberately thin: everything here moves
 * numbers the SimCore already computed, and nothing here may change one. That
 * is not a style preference — the browser leg of `determinism-matrix.yml`
 * compares hashes *read back out of this buffer* against the hashes Node
 * computed from the live bodies, so any arithmetic performed on the way through
 * would show up as a cross-platform divergence.
 *
 * Why a triple buffer at all. The writer (worker) and the reader (renderer) run
 * concurrently with no lock — a lock would let a stalled renderer stall the
 * simulation, which DET-1 forbids in spirit (pacing must never reach results)
 * and 09 forbids in fact (the two 16.67 ms threads are independent). With three
 * slots the writer always has one slot nobody can be reading: it targets
 * `(c+1) % 3`, so slots `c` and `(c−1) % 3` — the two the renderer needs for
 * §5.5's interpolation pair — are never written under the reader's feet.
 *
 * The counter is the only synchronisation. It is published last, with
 * `Atomics.store`, after the slab and the slot's step index are in place; a
 * reader that observes the new counter therefore observes a complete frame.
 * (`Atomics.store`/`Atomics.load` are sequentially consistent, which is what
 * makes "published last" mean "visible last" on a weakly-ordered CPU — and both
 * ISAs in the U9 matrix are represented, arm64 being the weak one.)
 *
 * Contract: docs/03-SIMULATION-CORE.md §5.3, §5.4, §5.5.
 */

import type { FrameMsg, TransportKind } from './protocol.js';
import { SAB, SabHeader, SimStatus, sabByteLength } from './protocol.js';

/** Bytes before the first slab. */
const HEADER_BYTES = SAB.HEADER_WORDS * 4;

/** Floats in one slab. */
export function slabFloats(bodyCount: number): number {
  return bodyCount * SAB.FLOATS_PER_BODY;
}

/** A view over one slab of a §5.4 buffer. Works on a SAB and on a plain buffer. */
export function slabView(buffer: ArrayBufferLike, slot: number, bodyCount: number): Float32Array {
  const floats = slabFloats(bodyCount);
  return new Float32Array(buffer as ArrayBuffer, HEADER_BYTES + slot * floats * 4, floats);
}

/** Fills a slab with the current pose of every dynamic body (`SimCore.writeFrame`). */
export type FrameFiller = (target: Float32Array) => void;

/**
 * The writer half. `worker.ts` holds one of these and never touches the layout
 * itself; `chooseTransport` picks the implementation from the environment.
 */
export interface FrameTransport {
  readonly kind: TransportKind;
  readonly bodyCount: number;
  /** Write one frame and make it visible to the reader. */
  publish(stepIndex: number, status: SimStatus, fill: FrameFiller): void;
  /** Publish a status change with no new frame (pause, finish, error). */
  setStatus(status: SimStatus): void;
}

// ---------------------------------------------------------------------------
// Shared memory (primary)
// ---------------------------------------------------------------------------

export class SabTransport implements FrameTransport {
  readonly kind = 'sab';
  readonly bodyCount: number;
  readonly buffer: SharedArrayBuffer;
  readonly #header: Int32Array;
  readonly #slots: readonly Float32Array[];
  /** Index of the newest published slot's counter; −1 until the first publish. */
  #counter = -1;

  constructor(bodyCount: number) {
    this.bodyCount = bodyCount;
    this.buffer = new SharedArrayBuffer(sabByteLength(bodyCount));
    this.#header = new Int32Array(this.buffer, 0, SAB.HEADER_WORDS);
    this.#slots = [0, 1, 2].map((slot) => slabView(this.buffer, slot, bodyCount));
    // Identity first: a reader that attaches to the wrong buffer, or to a
    // buffer written by a different layout version, must fail loudly at attach
    // rather than silently interpret someone else's floats as poses.
    this.#header[SabHeader.Magic] = SAB.MAGIC;
    this.#header[SabHeader.LayoutVersion] = SAB.LAYOUT_VERSION;
    this.#header[SabHeader.BodyCount] = bodyCount;
    this.#header[SabHeader.LatestStepIndex] = -1;
    this.#header[SabHeader.SimStatus] = SimStatus.Ready;
    this.#header[SabHeader.Flags] = 0;
    this.#header[SabHeader.SlotStepIndex0] = -1;
    this.#header[SabHeader.SlotStepIndex1] = -1;
    this.#header[SabHeader.SlotStepIndex2] = -1;
    Atomics.store(this.#header, SabHeader.WriteCounter, this.#counter);
  }

  publish(stepIndex: number, status: SimStatus, fill: FrameFiller): void {
    const slot = (this.#counter + 1) % SAB.SLOTS;
    const target = this.#slots[slot];
    if (target === undefined) return;
    fill(target);
    this.#header[SabHeader.SlotStepIndex0 + slot] = stepIndex;
    this.#header[SabHeader.LatestStepIndex] = stepIndex;
    this.#header[SabHeader.SimStatus] = status;
    this.#counter += 1;
    // Release: everything above is visible to anyone who observes this store.
    Atomics.store(this.#header, SabHeader.WriteCounter, this.#counter);
  }

  setStatus(status: SimStatus): void {
    Atomics.store(this.#header, SabHeader.SimStatus, status);
  }
}

/** What a reader can see of one published slot. */
export interface SlotRef {
  slot: number;
  stepIndex: number;
}

/**
 * The reader half — the renderer's view (P3) and the browser golden harness's.
 *
 * Every accessor loads the counter once and works from that snapshot: re-reading
 * it mid-frame is how a reader ends up interpolating between two poses that were
 * never both current.
 */
export class SabReader {
  readonly bodyCount: number;
  readonly #header: Int32Array;
  readonly #slots: readonly Float32Array[];

  private constructor(buffer: SharedArrayBuffer) {
    this.#header = new Int32Array(buffer, 0, SAB.HEADER_WORDS);
    const magic = Atomics.load(this.#header, SabHeader.Magic);
    const layout = Atomics.load(this.#header, SabHeader.LayoutVersion);
    if (magic !== SAB.MAGIC) throw new Error(`not a sim buffer (magic 0x${(magic >>> 0).toString(16)})`);
    if (layout !== SAB.LAYOUT_VERSION) throw new Error(`buffer layoutVersion ${layout}, expected ${SAB.LAYOUT_VERSION}`);
    this.bodyCount = Atomics.load(this.#header, SabHeader.BodyCount);
    this.#slots = [0, 1, 2].map((slot) => slabView(buffer, slot, this.bodyCount));
  }

  static attach(buffer: SharedArrayBuffer): SabReader {
    return new SabReader(buffer);
  }

  counter(): number {
    return Atomics.load(this.#header, SabHeader.WriteCounter);
  }

  status(): SimStatus {
    return Atomics.load(this.#header, SabHeader.SimStatus) as SimStatus;
  }

  latestStepIndex(): number {
    return Atomics.load(this.#header, SabHeader.LatestStepIndex);
  }

  /**
   * The slots a reader may touch, newest first: `c % 3` and `(c−1) % 3`.
   *
   * Empty before the first publish, one entry after it — a renderer that
   * attaches between `loaded` and the first frame has nothing to draw, and
   * should be told so rather than handed slot 0 full of zeros.
   */
  readable(): SlotRef[] {
    const c = this.counter();
    if (c < 0) return [];
    const out: SlotRef[] = [{ slot: c % SAB.SLOTS, stepIndex: this.stepIndexOf(c % SAB.SLOTS) }];
    if (c >= 1) {
      const prev = (c - 1) % SAB.SLOTS;
      out.push({ slot: prev, stepIndex: this.stepIndexOf(prev) });
    }
    return out;
  }

  stepIndexOf(slot: number): number {
    return Atomics.load(this.#header, SabHeader.SlotStepIndex0 + slot);
  }

  /** The raw slab of a slot. Read-only by contract; the writer owns it. */
  slab(slot: number): Float32Array {
    const view = this.#slots[slot];
    if (view === undefined) throw new Error(`slot ${slot} is out of range`);
    return view;
  }

  /** Copy one slot out, so a caller can hold a frame past the writer's next wake. */
  copy(slot: number, out?: Float32Array): Float32Array {
    const target = out ?? new Float32Array(slabFloats(this.bodyCount));
    target.set(this.slab(slot));
    return target;
  }
}

// ---------------------------------------------------------------------------
// postMessage fallback
// ---------------------------------------------------------------------------

/** Posts a `frame` message; the buffer is transferred, so it must be listed. */
export type FramePoster = (message: FrameMsg, transfer: ArrayBuffer[]) => void;

/**
 * The fallback when the page is not cross-origin isolated (§5.3).
 *
 * Same slab layout, one frame per message, and the same three buffers recycled
 * forever: transferring detaches the array on this side, so without the UI
 * handing buffers back this would allocate a fresh slab 60 times a second. A
 * pool that runs dry simply allocates — dropping a frame to protect an
 * allocation would be a pacing artefact, and those are exactly what DET-1 keeps
 * out of the simulation.
 */
export class PostMessageTransport implements FrameTransport {
  readonly kind = 'postmessage';
  readonly bodyCount: number;
  readonly #post: FramePoster;
  readonly #pool: Float32Array[] = [];
  #status: SimStatus = SimStatus.Ready;

  constructor(bodyCount: number, post: FramePoster) {
    this.bodyCount = bodyCount;
    this.#post = post;
  }

  publish(stepIndex: number, status: SimStatus, fill: FrameFiller): void {
    this.#status = status;
    const target = this.#pool.pop() ?? new Float32Array(slabFloats(this.bodyCount));
    fill(target);
    this.#post({ type: 'frame', stepIndex, transforms: target }, [target.buffer as ArrayBuffer]);
  }

  setStatus(status: SimStatus): void {
    this.#status = status;
  }

  /** Status is carried by messages here; exposed for parity with the SAB header. */
  status(): SimStatus {
    return this.#status;
  }

  /** The UI transfers a spent frame back. Extra buffers are dropped, not queued. */
  recycle(transforms: Float32Array): void {
    if (transforms.length !== slabFloats(this.bodyCount)) return;
    if (this.#pool.length < SAB.SLOTS) this.#pool.push(transforms);
  }
}

/**
 * Pick the transport (§5.3: the worker checks `crossOriginIsolated`).
 *
 * The choice is passed in rather than read here so the decision has exactly one
 * home — `worker.ts`'s bootstrap — and so both branches are reachable from a
 * test without a browser.
 */
export function chooseTransport(
  sharedMemory: boolean,
  bodyCount: number,
  post: FramePoster,
): SabTransport | PostMessageTransport {
  return sharedMemory ? new SabTransport(bodyCount) : new PostMessageTransport(bodyCount, post);
}

// ---------------------------------------------------------------------------
// §5.5 interpolation (normative for the renderer, M3/P3)
// ---------------------------------------------------------------------------

const TWO_PI = Math.PI * 2;

/**
 * Shortest-arc angular interpolation (§5.5). A body spinning through ±π must
 * not unwind the long way round on screen.
 */
export function lerpAngle(a: number, b: number, t: number): number {
  const d = b - a;
  return a + (d - TWO_PI * Math.round(d / TWO_PI)) * t;
}

/**
 * Advance the playhead one display frame (§5.5).
 *
 * The clamp is the whole trick: staying between 0.5 and 2 steps behind the
 * newest published frame absorbs publish jitter (the worker may publish 1 step
 * or 5 in one wake) without ever letting the renderer run past what exists.
 */
export function advancePlayhead(playhead: number, displayDeltaS: number, speed: number, latestStepIndex: number): number {
  const p = playhead + displayDeltaS * 60 * speed;
  const hi = latestStepIndex - 0.5;
  const lo = latestStepIndex - 2;
  return p < lo ? lo : p > hi ? hi : p;
}

/**
 * Interpolate two published frames into `out` (§5.5).
 *
 * α comes from the frames' own step indices rather than from `floor(playhead)`:
 * §5.5 writes `lerp(state_i, state_{i+1})` assuming one publish per step, and
 * under catch-up the two newest slots can be several steps apart. Deriving α
 * from what was actually published keeps the on-screen motion continuous in
 * that case instead of snapping.
 *
 * `state` is not interpolable (asleep/awake/removed) and is taken from the older
 * frame — the one the interpolated pose actually belongs to until α reaches 1.
 */
export function lerpFrames(
  from: Float32Array,
  fromStep: number,
  to: Float32Array,
  toStep: number,
  playhead: number,
  out: Float32Array,
): number {
  const span = toStep - fromStep;
  const raw = span <= 0 ? 1 : (playhead - fromStep) / span;
  const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  for (let base = 0; base < out.length; base += SAB.FLOATS_PER_BODY) {
    const ax = from[base] ?? 0;
    const ay = from[base + 1] ?? 0;
    const ar = from[base + 2] ?? 0;
    out[base] = ax + ((to[base] ?? 0) - ax) * t;
    out[base + 1] = ay + ((to[base + 1] ?? 0) - ay) * t;
    out[base + 2] = lerpAngle(ar, to[base + 2] ?? 0, t);
    out[base + 3] = from[base + 3] ?? 0;
  }
  return t;
}

/**
 * Sample the shared buffer at `playhead` (§5.5), the renderer's one call.
 *
 * Returns the α used, or `null` when nothing has been published yet. With a
 * single published frame there is nothing to interpolate against, so that frame
 * is copied out as-is.
 */
export function sampleAt(reader: SabReader, playhead: number, out: Float32Array): number | null {
  const slots = reader.readable();
  const newest = slots[0];
  if (newest === undefined) return null;
  const older = slots[1];
  if (older === undefined) {
    out.set(reader.slab(newest.slot));
    return 1;
  }
  return lerpFrames(reader.slab(older.slot), older.stepIndex, reader.slab(newest.slot), newest.stepIndex, playhead, out);
}
