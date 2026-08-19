/**
 * Live budgets — 04 §14, the status bar's right-hand side.
 *
 * "objects/5000, links/1000, expanded **bodies** / 8000 — the editor computes the
 * exact expansion count (segmented ropes are the multiplier); amber at 80 %,
 * red + place-tool block at 100 % (E_LIMITS is never a surprise)."
 *
 * The load-bearing word is *exact*. A body count that is nearly right is worse
 * than none: it lets an author build past the cap and meet `E_LIMITS` at Play,
 * which is precisely the surprise this display exists to prevent. So the count
 * is not re-derived here — it is `countDynamicBodies` from the engine, the same
 * function the loader refuses on (03 §5.4), reachable without a physics build
 * because it lives in the Rapier-free `@physics/engine/geometry` entry point.
 *
 * The fourth budget, document bytes, is not in the status-bar sketch but is a
 * real limit (`LIMITS.maxJsonBytes`, R6) and the only one whose value depends on
 * the *writer* rather than the document — so it is measured on the strict
 * writer's output, not on whatever the store happens to hold.
 */

import type { Scene } from '@physics/scene-format';
import { LIMITS } from '@physics/scene-format';
import { SIM } from '@physics/engine/protocol';
import { canonicalize, countDynamicBodies } from '@physics/engine/geometry';
import type { SceneDoc } from './document.js';
import { EDITOR } from './model.js';
import { serializedBytes, writeScene } from './write.js';

export type BudgetLevel = 'ok' | 'warn' | 'full';

export interface Budget {
  used: number;
  limit: number;
  level: BudgetLevel;
}

export interface Budgets {
  objects: Budget;
  links: Budget;
  /** Expanded dynamic bodies — the number `E_LIMITS` reports (03 §5.4). */
  bodies: Budget;
  /** Serialized document size against `LIMITS.maxJsonBytes` (R6). */
  bytes: Budget;
  /** True if any budget is at or over its limit — the place tool blocks. */
  blocked: boolean;
}

function level(used: number, limit: number): BudgetLevel {
  if (used >= limit) return 'full';
  return used >= limit * EDITOR.BUDGET_WARN_FRACTION ? 'warn' : 'ok';
}

const budget = (used: number, limit: number): Budget => ({ used, limit, level: level(used, limit) });

/** Count expanded dynamic bodies for a document (04 §14, 03 §5.4). */
export function bodyCount(scene: Scene): number {
  return countDynamicBodies(canonicalize(scene));
}

/**
 * The whole status-bar budget row.
 *
 * This canonicalizes and serializes the document, so it is a per-edit
 * computation, not a per-frame one — 04 §8.5 already debounces validation at
 * `VALIDATE_DEBOUNCE_MS` and this belongs on the same tick.
 */
export function budgets(doc: SceneDoc): Budgets {
  const scene = writeScene(doc);
  const b = {
    objects: budget(doc.objects.length, LIMITS.maxObjects),
    links: budget(doc.links.length, LIMITS.maxLinks),
    bodies: budget(bodyCount(scene), SIM.MAX_DYNAMIC_BODIES),
    bytes: budget(serializedBytes(doc), LIMITS.maxJsonBytes),
  };
  return { ...b, blocked: Object.values(b).some((x) => x.level === 'full') };
}
