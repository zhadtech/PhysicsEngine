/**
 * Id generation — 04 §5.2.
 *
 * "`<prefix><n>` per `ID_PREFIX`, `n` = smallest unused positive integer for
 * that prefix." Objects and links share **one** namespace (02 §2.1), so the
 * allocator is scene-wide, not per-collection: a `rope1` link makes `rope1`
 * unavailable to anything else.
 *
 * The naive reading — scan from 1 on every allocation — is quadratic, and the
 * format's own ceiling is 5 000 objects. Placing a domino run of 400 would do
 * 80 000 set lookups for no reason. So each prefix keeps a *hint*: the smallest
 * integer that might still be free. Allocation scans up from the hint;
 * releasing an id pulls the hint back down to it. The hint is only ever a lower
 * bound on the answer, so the result is identical to the naive scan — which is
 * what `ids.test.mjs` asserts against a brute-force oracle.
 */

import type { Id, LinkType, ObjectType } from '@physics/scene-format';
import { ID_PATTERN } from '@physics/scene-format';
import { ID_PREFIX } from './model.js';

export class IdAllocator {
  private readonly taken = new Set<Id>();
  /** prefix → smallest n that may still be free (never above the true answer). */
  private readonly hint = new Map<string, number>();

  constructor(existing: Iterable<Id> = []) {
    for (const id of existing) this.taken.add(id);
  }

  has(id: Id): boolean {
    return this.taken.has(id);
  }

  /** Record an id as used (import, paste, rename, undo of a delete). */
  reserve(id: Id): void {
    this.taken.add(id);
  }

  /** Give an id back (delete, undo of an add). */
  release(id: Id): void {
    if (!this.taken.delete(id)) return;
    const m = /^([A-Za-z_-]*)([0-9]+)$/.exec(id);
    if (!m) return;
    const prefix = m[1] as string;
    const n = Number(m[2]);
    const h = this.hint.get(prefix);
    if (h === undefined || n < h) this.hint.set(prefix, n);
  }

  /** The next free `<prefix><n>`; does not reserve it. */
  peek(prefix: string): Id {
    let n = this.hint.get(prefix) ?? 1;
    if (n < 1) n = 1;
    while (this.taken.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }

  /** Allocate and reserve the next free `<prefix><n>`. */
  next(prefix: string): Id {
    const id = this.peek(prefix);
    this.taken.add(id);
    // Everything below the allocated n is now known-taken for this prefix.
    this.hint.set(prefix, Number(id.slice(prefix.length)) + 1);
    return id;
  }

  /** Allocate for a catalog type or link type, using its `ID_PREFIX`. */
  nextFor(type: ObjectType | LinkType): Id {
    return this.next(ID_PREFIX[type]);
  }

  /**
   * A free id derived from `wanted` — used when pasting a fragment whose ids
   * already exist here (04 §5.5: "ids regenerated"). Keeps the caller's prefix
   * so a pasted `dom7` becomes the next free `domN` rather than something
   * unrelated.
   */
  nextLike(wanted: Id, fallbackPrefix: string): Id {
    const prefix = /^([A-Za-z_-]*)[0-9]*$/.exec(wanted)?.[1] || fallbackPrefix;
    return this.next(prefix || fallbackPrefix);
  }
}

/** 02 §2.1's id grammar — the same check the rename field applies (04 §5.2). */
export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}
