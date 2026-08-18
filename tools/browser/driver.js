/**
 * The page-side driver for the browser golden run (03 §12, P2c).
 *
 * This is the browser's answer to `tools/golden-node.mjs`: same corpus, same
 * run plan, same checkpoint cadence — but the steps are asked for over the §5.2
 * command protocol, and the state hash is computed from what came *out* of the
 * §5.4 transport rather than from the bodies themselves. That is the strongest
 * form the browser leg can take. A page cannot reach into the worker's world,
 * and it should not want to: if the hashes match the Node goldens, then the
 * physics, the worker shell and the buffer that carries the frames all agree
 * across every engine in `BROWSER_TRIPLE`.
 *
 * It deliberately compares nothing. Measurements go back to Node, which holds
 * them against `goldens/state.golden.json` with the same code that judges the
 * Node leg — two verdict implementations would be two chances to be wrong.
 *
 * Driving is by `stepN`, never by `play`: `play` advances by wall clock (§5.5),
 * so the number of steps it takes is a property of the machine. `stepN` is the
 * command that exists for asking a run to advance an exact amount.
 */

import { frameHash, SabReader } from '/engine.js';

const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');

function log(line) {
  logEl.textContent += `${line}\n`;
  console.log(line);
}

/** A worker plus the small amount of plumbing needed to await its replies. */
function connect(url) {
  const worker = new Worker(url, { type: 'module' });
  const inbox = [];
  const waiters = [];
  /** The most recent `frame` message — the fallback transport's channel. */
  const state = { lastFrame: null, finished: null, error: null };

  const deliver = (message) => {
    if (message.type === 'frame') state.lastFrame = message;
    if (message.type === 'finished') state.finished = message;
    if (message.type === 'error') state.error = message;
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].match(message)) {
        waiters.splice(i, 1)[0].resolve(message);
        return;
      }
    }
    inbox.push(message);
  };
  worker.onmessage = (event) => deliver(event.data);
  worker.onerror = (event) => {
    state.error = { type: 'error', code: 'E_INTERNAL', message: event.message ?? 'worker error' };
  };

  const until = (match) =>
    new Promise((resolve, reject) => {
      const found = inbox.findIndex(match);
      if (found >= 0) {
        resolve(inbox.splice(found, 1)[0]);
        return;
      }
      const timer = setTimeout(() => reject(new Error('timed out waiting for a worker message')), 120_000);
      waiters.push({
        match,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });

  let seq = 0;
  const send = async (command) => {
    const mine = ++seq;
    worker.postMessage({ seq: mine, ...command });
    const ack = await until((m) => m.type === 'ack' && m.seq === mine);
    if (!ack.ok) throw new Error(`${command.cmd} was refused: ${ack.error ?? 'no reason given'}`);
    return ack;
  };

  return { worker, send, until, state, post: (m, transfer) => worker.postMessage(m, transfer) };
}

/**
 * Run one corpus scene and report what the Node side needs to judge it.
 *
 * The shape mirrors `golden-node.mjs`'s per-scene record exactly, field for
 * field, because the two are compared against the same committed goldens.
 */
async function runScene(workerUrl, name, plan) {
  const doc = await (await fetch(`/goldens/scenes/${name}.json`)).json();
  const started = performance.now();
  const link = connect(workerUrl);
  const ready = await link.until((m) => m.type === 'ready');

  await link.send({ cmd: 'load', scene: doc });
  const loaded = await link.until((m) => m.type === 'loaded');
  const reader = loaded.sab === undefined ? null : SabReader.attach(loaded.sab);
  if (reader !== null && reader.bodyCount !== loaded.bodyCount) {
    throw new Error(`the buffer says ${reader.bodyCount} bodies, the registry says ${loaded.bodyCount}`);
  }

  /** Hash the newest published frame, whichever transport carried it. */
  const readFrame = () => {
    if (reader !== null) {
      const slot = reader.readable()[0];
      if (slot === undefined) throw new Error('nothing has been published yet');
      return { stepIndex: slot.stepIndex, hash: frameHash(slot.stepIndex, reader.slab(slot.slot)) };
    }
    const frame = link.state.lastFrame;
    if (frame === null) throw new Error('nothing has been published yet');
    const hash = frameHash(frame.stepIndex, frame.transforms);
    // Hand the slab back so the worker's three-buffer pool can reuse it (§5.3).
    link.post({ type: 'recycle', transforms: frame.transforms }, [frame.transforms.buffer]);
    link.state.lastFrame = null;
    return { stepIndex: frame.stepIndex, hash };
  };

  const checkpoints = [];
  let at = readFrame().stepIndex;
  while (at < plan.steps && link.state.finished === null) {
    const want = Math.min(plan.checkpointEvery, plan.steps - at);
    await link.send({ cmd: 'stepN', n: want });
    const frame = readFrame();
    at = frame.stepIndex;
    checkpoints.push(`${at}:${frame.hash}`);
    if (link.state.error !== null) throw new Error(`the run failed: ${link.state.error.message}`);
  }

  // A scene that never reached a §9.2 finish condition is stopped here purely
  // to collect its analytics — the same report `golden-node.mjs` reads off the
  // core at the same step. `finishReason` therefore records what the *run*
  // decided, not what the harness did, which is why it is null in that case.
  const natural = link.state.finished;
  if (natural === null) await link.send({ cmd: 'stop' });
  const finished = natural ?? (await link.until((m) => m.type === 'finished'));
  if (natural === null && finished.reason !== 'stopped') {
    throw new Error(`stop produced ${finished.reason}, not "stopped"`);
  }
  const report = finished.analytics;

  await link.send({ cmd: 'shutdown' });
  link.worker.terminate();

  return {
    transport: ready.transport,
    engineVersion: ready.engineVersion,
    physicsBuild: ready.physicsBuild,
    ms: performance.now() - started,
    result: {
      bodyCount: loaded.bodyCount,
      warnings: loaded.warnings.map((w) => w.code),
      endStep: at,
      finishReason: natural === null ? null : natural.reason,
      checkpoints,
      analytics: {
        durationS: report.durationS,
        objectsActivated: report.objectsActivated,
        activatableCount: report.activatableCount,
        chainReactions: report.chainReactions,
        longestChain: report.longestChain,
        success: report.success,
        removedCount: report.removedCount,
        efficiencyScore: report.efficiencyScore,
        finalHash: report.finalHash,
      },
    },
  };
}

/** Playwright's entry point. Returns measurements; it never decides anything. */
window.__runGolden = async (plan) => {
  const out = { crossOriginIsolated: window.crossOriginIsolated === true, scenes: {}, meta: null };
  statusEl.textContent = 'running';
  for (const name of plan.scenes) {
    log(`${name}: running ${plan.steps} steps…`);
    const measured = await runScene('/worker.js', name, plan);
    out.scenes[name] = measured.result;
    out.meta ??= { transport: measured.transport, engineVersion: measured.engineVersion, physicsBuild: measured.physicsBuild };
    log(
      `${name}: ${measured.result.endStep} steps, ${measured.result.bodyCount} bodies, ` +
        `final ${measured.result.analytics.finalHash} (${measured.ms.toFixed(0)} ms, ${measured.transport})`,
    );
  }
  statusEl.textContent = 'done';
  return out;
};

log(`page loaded — crossOriginIsolated: ${window.crossOriginIsolated === true}`);
