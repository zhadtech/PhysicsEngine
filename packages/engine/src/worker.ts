/**
 * The Web Worker shell — the §5 protocol, the §5.1 lifecycle and the §5.5 pacer.
 *
 * Everything that makes a run *happen at a time* lives here, and nothing that
 * makes it *come out a particular way* does. That split is DET-1 stated as a
 * file boundary: the pacer below reads a wall clock, and the only thing it can
 * decide with it is how many whole `dt` steps to ask `SimCore.advance` for. It
 * cannot vary `dt`, cannot half-step, and cannot reorder anything — so a run
 * paused twelve times, resumed at 4× and dragged through a garbage-collection
 * pause produces the same hashes as one that ran straight through. §12's
 * command-boundary test is the machine check of exactly that claim.
 *
 * The shell is written against an injected `WorkerEnv` rather than against
 * `self` directly, for one concrete reason: the browser leg of the determinism
 * matrix is not the only thing that has to drive this state machine. The unit
 * suite drives it in Node with a fake clock and a manual wake queue, which is
 * how the lifecycle table (§5.1) and the pacing formula (§5.5) get tested at
 * all — a wall-clock loop in a real worker can only be observed, not asserted.
 * `attachToWorkerScope()` at the bottom is the seven-line browser binding.
 *
 * Contract: docs/03-SIMULATION-CORE.md §5, §9.
 */

import type { Scene } from '@physics/scene-format';
import type {
  CollisionEvent,
  PlaybackSpeed,
  SimCommand,
  SimEvent,
  SimInbound,
  SimMessage,
} from './protocol.js';
import { ENGINE_VERSION, PROTOCOL_VERSION, SIM, SimStatus } from './protocol.js';
import { SimLoadError } from './sim/expand.js';
import { createSimCore, SimCore } from './sim/step.js';
import type { FrameTransport } from './transport.js';
import { chooseTransport, PostMessageTransport, SabTransport } from './transport.js';

/**
 * Everything the shell needs from its environment. Three functions and a flag:
 * if this interface ever grows, something environment-dependent is leaking
 * toward the simulation.
 */
export interface WorkerEnv {
  /** Post a message to the UI thread. `transfer` is the §5.3 frame buffer. */
  post(message: SimMessage, transfer?: ArrayBuffer[]): void;
  /** Wall clock in milliseconds. Pacing only — never reaches the simulation. */
  now(): number;
  /**
   * Schedule the next pacing wake. §5.5 specifies a MessageChannel-driven loop:
   * a macrotask that is not `setTimeout`, so the worker yields to its own
   * message queue (commands stay responsive) without the 4 ms clamp.
   */
  wake(run: () => void): void;
  /** `crossOriginIsolated` — whether a SharedArrayBuffer can be constructed. */
  sharedMemory: boolean;
}

/** §5.1's states, as the shell tracks them. */
export type Lifecycle = 'idle' | 'ready' | 'running' | 'paused' | 'finished' | 'error';

const STATUS_OF: Record<Lifecycle, SimStatus> = {
  idle: SimStatus.Idle,
  ready: SimStatus.Ready,
  running: SimStatus.Running,
  paused: SimStatus.Paused,
  finished: SimStatus.Finished,
  error: SimStatus.Errored,
};

/**
 * Which commands each state accepts (§5.1: "commands invalid in the current
 * state are acked with `ok: false` and ignored").
 *
 * Two readings are written down here rather than left to the implementation:
 *
 * - `stepN` is legal in `ready` as well as `paused`. §5.2 says "while paused",
 *   and `ready` *is* the paused state a freshly loaded run sits in — it has a
 *   world, it is not running, and stepping it is exactly the debug operation
 *   the command exists for. Refusing it would also make deterministic driving
 *   impossible: the only other way to advance a run is `play`, whose step count
 *   is a function of the wall clock.
 * - `load` is legal in every state. Loading a new scene replaces the world, so
 *   there is nothing for an earlier state to protect; refusing it would strand
 *   a UI that finished a run and opened a different scene.
 */
const VALID_IN: Record<SimCommand['cmd'], readonly Lifecycle[]> = {
  load: ['idle', 'ready', 'running', 'paused', 'finished', 'error'],
  play: ['ready', 'paused'],
  pause: ['running'],
  stepN: ['ready', 'paused'],
  setSpeed: ['ready', 'running', 'paused'],
  stop: ['ready', 'running', 'paused'],
  reset: ['ready', 'running', 'paused', 'finished', 'error'],
  shutdown: ['idle', 'ready', 'running', 'paused', 'finished', 'error'],
};

const SPEEDS: readonly PlaybackSpeed[] = [0.25, 0.5, 1, 2, 4];

/**
 * §5.3's per-batch collision cap, applied where "batch" is defined — at the
 * publish, not at the step.
 *
 * `SimCore` already caps the collisions it emits *per step*; a wake that
 * catches up five steps can still publish five times that. Semantic events
 * (activation, trigger, goal, removal, actuator) are never candidates for
 * dropping: they are what the analytics timeline and the UI status icons are
 * built from, while collisions past the first few hundred are sound and
 * particles nobody can distinguish.
 */
export function capEventBatch(events: SimEvent[]): SimEvent[] {
  const collisions = events.filter((e): e is CollisionEvent => e.kind === 'collision');
  if (collisions.length <= SIM.MAX_SFX_EVENTS_PER_BATCH) return events;
  const keep = new Set(
    [...collisions].sort((a, b) => b.impulse - a.impulse).slice(0, SIM.MAX_SFX_EVENTS_PER_BATCH),
  );
  return events.filter((e) => e.kind !== 'collision' || keep.has(e));
}

/**
 * The §5.5 pacer, as a pure function of the clock so it can be tested against
 * the formula rather than against a stopwatch.
 *
 * `owed = clamp(floor((now − epoch)·speed / dt) − stepsDone, 0, MAX_CATCHUP)`.
 * The cap is what turns an overloaded machine into honest slow motion instead
 * of a death spiral: the shell never tries to buy back more than five steps in
 * one wake, so a wake can never take longer than the next one is willing to
 * wait for.
 */
export function owedSteps(elapsedMs: number, speed: number, stepsDone: number): number {
  const due = Math.floor((elapsedMs * speed) / (SIM.DT * 1000));
  const owed = due - stepsDone;
  if (owed <= 0) return 0;
  return owed > SIM.MAX_CATCHUP_STEPS ? SIM.MAX_CATCHUP_STEPS : owed;
}

export class SimWorkerHost {
  readonly #env: WorkerEnv;
  readonly #core: SimCore;
  #transport: FrameTransport | null = null;
  #phase: Lifecycle = 'idle';
  #speed: PlaybackSpeed = 1;
  /** Pacing anchor: wall clock and step index at the last play/setSpeed (§5.5). */
  #epochMs = 0;
  #stepsAtEpoch = 0;
  #scheduled = false;
  /** Step covered by the last publish — the `fromStep` of the next event batch. */
  #lastPublished = 0;
  #announcedFinish = false;

  private constructor(env: WorkerEnv, core: SimCore) {
    this.#env = env;
    this.#core = core;
  }

  /** Boot: load the WASM build, then announce `ready` (§5.3). */
  static async start(env: WorkerEnv, core?: SimCore): Promise<SimWorkerHost> {
    const host = new SimWorkerHost(env, core ?? (await createSimCore()));
    env.post({
      type: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      engineVersion: ENGINE_VERSION,
      physicsBuild: host.#core.physicsBuild(),
      transport: env.sharedMemory ? 'sab' : 'postmessage',
    });
    return host;
  }

  get phase(): Lifecycle {
    return this.#phase;
  }

  get core(): SimCore {
    return this.#core;
  }

  get transport(): FrameTransport | null {
    return this.#transport;
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  /** Handle one UI → worker message (§5.2, plus the §5.3 buffer hand-back). */
  handle(message: SimInbound): void {
    if ('type' in message) {
      if (message.type === 'recycle' && this.#transport instanceof PostMessageTransport) {
        this.#transport.recycle(message.transforms);
      }
      return;
    }
    // `?? []` is the malformed-message path, not a type-level one: a UI that
    // posts a command this build does not know gets `ok: false`, not a throw.
    const allowed: readonly Lifecycle[] = VALID_IN[message.cmd] ?? [];
    if (!allowed.includes(this.#phase)) {
      this.#ack(message.seq, false, `${message.cmd} is not valid while ${this.#phase}`);
      return;
    }
    switch (message.cmd) {
      case 'load':
        this.#load(message.scene, message.seq);
        return;
      case 'play':
        this.#core.record(message);
        this.#phase = 'running';
        this.#anchor();
        this.#transport?.setStatus(SimStatus.Running);
        this.#schedule();
        this.#ack(message.seq, true);
        return;
      case 'pause':
        this.#core.record(message);
        this.#phase = 'paused';
        this.#transport?.setStatus(SimStatus.Paused);
        this.#ack(message.seq, true);
        return;
      case 'stepN': {
        if (!Number.isInteger(message.n) || message.n < 1 || message.n > 600) {
          this.#ack(message.seq, false, `stepN takes 1–600 steps, got ${String(message.n)}`);
          return;
        }
        this.#core.record(message);
        this.#run(message.n);
        // A `stepN` that walks into a finish condition still executed; only a
        // fatal step is a failed command (§5.1).
        this.#ack(message.seq, this.#phase !== 'error', this.#phase === 'error' ? 'the run failed' : undefined);
        return;
      }
      case 'setSpeed': {
        if (!SPEEDS.includes(message.speed)) {
          this.#ack(message.seq, false, `unsupported speed ${String(message.speed)}`);
          return;
        }
        this.#core.record(message);
        this.#speed = message.speed;
        // Re-anchor, or the elapsed time already served at the old speed would
        // be re-served at the new one and the run would jump (§5.5).
        this.#anchor();
        this.#ack(message.seq, true);
        return;
      }
      case 'stop':
        this.#core.record(message);
        this.#core.stop();
        this.#publish();
        this.#announceFinish();
        this.#ack(message.seq, true);
        return;
      case 'reset':
        this.#core.reset();
        this.#core.record(message);
        this.#phase = 'ready';
        this.#speed = 1;
        this.#announcedFinish = false;
        this.#lastPublished = this.#core.stepIndex;
        this.#publish();
        this.#ack(message.seq, true);
        return;
      case 'shutdown':
        this.#core.dispose();
        this.#transport = null;
        this.#phase = 'idle';
        this.#scheduled = false;
        this.#ack(message.seq, true);
        return;
    }
  }

  // -------------------------------------------------------------------------
  // §9.1 Load
  // -------------------------------------------------------------------------

  #load(scene: Scene, seq: number): void {
    try {
      const result = this.#core.load(scene);
      this.#transport = chooseTransport(this.#env.sharedMemory, result.bodyCount, (message, transfer) =>
        this.#env.post(message, transfer),
      );
      this.#phase = 'ready';
      this.#speed = 1;
      this.#lastPublished = 0;
      this.#announcedFinish = false;
      this.#scheduled = false;
      const loaded: SimMessage =
        this.#transport instanceof SabTransport
          ? {
              type: 'loaded',
              bodyCount: result.bodyCount,
              registry: result.registry,
              warnings: result.warnings,
              sab: this.#transport.buffer,
            }
          : { type: 'loaded', bodyCount: result.bodyCount, registry: result.registry, warnings: result.warnings };
      this.#env.post(loaded);
      // §9.1's order: `loaded` first, then the initial frame. A reader that
      // attaches in between sees an empty `readable()` rather than a slot of
      // zeros — which is why the counter starts at −1 (§5.4).
      this.#publish();
      this.#ack(seq, true);
    } catch (err) {
      // §5.1: an error during load returns to idle.
      this.#phase = 'idle';
      this.#transport = null;
      const code = err instanceof SimLoadError ? err.code : 'E_INTERNAL';
      const message = err instanceof Error ? err.message : String(err);
      const detail = err instanceof SimLoadError ? err.detail : undefined;
      this.#env.post(detail === undefined ? { type: 'error', code, message } : { type: 'error', code, message, detail });
      this.#ack(seq, false, `${code}: ${message}`);
    }
  }

  // -------------------------------------------------------------------------
  // §5.5 Pacing
  // -------------------------------------------------------------------------

  #anchor(): void {
    this.#epochMs = this.#env.now();
    this.#stepsAtEpoch = this.#core.stepIndex;
  }

  #schedule(): void {
    if (this.#scheduled || this.#phase !== 'running') return;
    this.#scheduled = true;
    this.#env.wake(() => this.#pump());
  }

  /** One pacing wake: catch up at most MAX_CATCHUP steps, then publish once. */
  #pump(): void {
    this.#scheduled = false;
    if (this.#phase !== 'running') return;
    const owed = owedSteps(this.#env.now() - this.#epochMs, this.#speed, this.#core.stepIndex - this.#stepsAtEpoch);
    if (owed > 0) this.#run(owed);
    // `#schedule` is a no-op unless the run is still going, so a finish or a
    // fatal step ends the loop without a flag to forget to clear.
    this.#schedule();
  }

  /**
   * Advance, publish, and announce a finish. Leaves the phase at `error` if the
   * step threw, which is what stops the pacing loop.
   */
  #run(steps: number): void {
    try {
      this.#core.advance(steps);
    } catch (err) {
      // §5.1: an error during a run is fatal for that run; reset is required.
      this.#phase = 'error';
      this.#transport?.setStatus(SimStatus.Errored);
      this.#env.post({ type: 'error', code: 'E_INTERNAL', message: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.#publish();
    this.#announceFinish();
  }

  // -------------------------------------------------------------------------
  // §4 P7 Publish
  // -------------------------------------------------------------------------

  #publish(): void {
    const transport = this.#transport;
    if (transport === null) return;
    if (this.#core.finished !== null) this.#phase = 'finished';
    transport.publish(this.#core.stepIndex, STATUS_OF[this.#phase], (target) => this.#core.writeFrame(target));
    const events = capEventBatch(this.#core.drain());
    if (events.length > 0) {
      // `[fromStep, toStep)`, half-open. An event is labelled with the step that
      // was *executing* when it was observed (§4 P6), so a batch ending at
      // `toStep` carries labels up to `toStep − 1`. The one exception is the
      // batch `load` itself publishes, `0 → 0`: §10's step-0 activations are
      // roots of the attribution forest and belong to no step interval.
      this.#env.post({ type: 'events', fromStep: this.#lastPublished, toStep: this.#core.stepIndex, events });
    }
    this.#lastPublished = this.#core.stepIndex;
  }

  #announceFinish(): void {
    const reason = this.#core.finished;
    if (reason === null || this.#announcedFinish) return;
    this.#announcedFinish = true;
    this.#phase = 'finished';
    this.#transport?.setStatus(SimStatus.Finished);
    this.#env.post({ type: 'finished', reason, analytics: this.#core.report() });
  }

  #ack(seq: number, ok: boolean, error?: string): void {
    this.#env.post(error === undefined ? { type: 'ack', seq, ok } : { type: 'ack', seq, ok, error });
  }
}

// ---------------------------------------------------------------------------
// Browser bootstrap
// ---------------------------------------------------------------------------

/** The dedicated-worker global, as much of it as this file uses. */
interface WorkerScope {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  addEventListener(type: 'message', listener: (event: { data: SimInbound }) => void): void;
  crossOriginIsolated?: boolean;
}

function workerScope(): WorkerScope | null {
  const g = globalThis as unknown as Partial<WorkerScope> & { document?: unknown };
  if (typeof g.postMessage !== 'function' || typeof g.addEventListener !== 'function') return null;
  // A page has both of those and a document; a dedicated worker has no document.
  if (g.document !== undefined) return null;
  return g as WorkerScope;
}

/**
 * Bind the host to a real dedicated worker: `new Worker(url, { type: 'module' })`.
 *
 * Messages that arrive before the WASM build finishes loading are queued rather
 * than dropped — a UI that posts `load` immediately after constructing the
 * worker is doing nothing wrong, and losing that command would be a race that
 * only ever bites on a slow machine.
 */
export function attachToWorkerScope(scope: WorkerScope | null = workerScope()): void {
  if (scope === null) return;
  const channel = new MessageChannel();
  let pending: (() => void) | null = null;
  channel.port1.onmessage = () => {
    const run = pending;
    pending = null;
    run?.();
  };
  const env: WorkerEnv = {
    post: (message, transfer) => scope.postMessage(message, transfer),
    now: () => performance.now(),
    wake: (run) => {
      pending = run;
      channel.port2.postMessage(0);
    },
    sharedMemory: scope.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function',
  };
  const queue: SimInbound[] = [];
  let host: SimWorkerHost | null = null;
  scope.addEventListener('message', (event) => {
    if (host === null) queue.push(event.data);
    else host.handle(event.data);
  });
  void SimWorkerHost.start(env).then((started) => {
    host = started;
    for (const message of queue.splice(0)) started.handle(message);
  });
}

attachToWorkerScope();
