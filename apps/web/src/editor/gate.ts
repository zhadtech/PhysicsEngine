/**
 * Entering Test — 04 §10.1, and the copy table in §8.6.
 *
 * "serialize (strict writer: fill-nothing, omit defaults, quantize) → local
 * validation gate — **errors block** with the panel open; warnings proceed →
 * `load`".
 *
 * The important word is *serialize*. Test mode is a full round trip through the
 * file format, not a shortcut that hands the live store to the worker: 04 §15
 * decision 5 says "what plays is exactly what saves", and the only way to mean
 * it is to make Play consume the same bytes Export produces. It also means the
 * gate the worker will apply has already run here, so an `E_SCHEMA` coming back
 * from the worker is a bug in this function rather than a user-facing state.
 *
 * The gate itself is `@physics/scene-format`'s — the same code the server runs
 * (05 §5.3) and the same code the engine runs at load. Three implementations of
 * "valid" would be three chances to disagree.
 */

import type { Finding, GateResult, Scene } from '@physics/scene-format';
import { validateScene } from '@physics/scene-format';
import type { SceneDoc } from './document.js';
import { serializedBytes, writeScene } from './write.js';

export interface GateOutcome {
  /** True when Test may proceed. Warnings never block (04 §8.5). */
  ok: boolean;
  /** The document as serialized; what `load` receives when `ok`. */
  scene: Scene;
  /** Empty on success — the gate returns errors *instead of* a document. */
  errors: readonly Finding[];
  /** W9–W12: normal working state, surfaced as chips (04 §10.1). */
  warnings: readonly Finding[];
  /** The gate's own verdict, for the panel's "jump to offender" (04 §8.5). */
  result: GateResult;
}

/** Serialize the store and run the shared validation gate (04 §10.1). */
export function gateForTest(doc: SceneDoc): GateOutcome {
  const scene = writeScene(doc);
  const result = validateScene(scene, { bytes: serializedBytes(doc) });
  return {
    ok: result.ok,
    scene,
    errors: result.ok ? [] : result.findings,
    warnings: result.warnings,
    result,
  };
}

/**
 * Worker/gate codes → the user-facing sentences 04 §8.6 fixes.
 *
 * A table rather than strings scattered through components: §8.6 is normative
 * copy, and `verify-web.mjs` holds this map to the document, so a reworded
 * sentence in one place fails the build rather than quietly diverging.
 * `{placeholder}`s are filled by `copyFor`.
 */
export const ERROR_COPY: Record<string, string> = {
  E_SCHEMA: "This scene file isn't valid — details below.",
  E_SEMANTIC: "This scene file isn't valid — details below.",
  E_SCHEMA_NEWER: 'Made with a newer version of the app. Refresh to update.',
  E_LIMITS: 'Too many moving parts: {n} of {MAX_DYNAMIC_BODIES} bodies. Segmented ropes are the usual culprit.',
  E_INTERNAL: 'Simulation crashed — this is our bug. Reset to try again.',
  W_LEVER_ROT_OUTSIDE_LIMITS: '{id}: arm starts outside its rotation limits.',
  W_ROPE_VIA_SEGMENTS_CONFLICT: "{id}: routed ropes can't be segmented — using ideal rope.",
  W_AXLE_ANCHOR_MISMATCH: "{id}: the two anchor points are {d} cm apart; the axle joins at side A's.",
  W_ROPE_STARTS_VIOLATED: '{id}: rope is shorter than the gap it spans — it will yank on play.',
};

/** Fill `{placeholder}`s in a §8.6 sentence. */
export function copyFor(code: string, values: Readonly<Record<string, string | number>> = {}): string {
  const template = ERROR_COPY[code];
  if (template === undefined) return code;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));
}
