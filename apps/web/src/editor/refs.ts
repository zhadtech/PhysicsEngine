/**
 * Where one id names another — the reference graph the editor has to keep
 * consistent (02 §8 rules 2–3, 04 §5.5, §7.3).
 *
 * Four places in the document hold an id that is not their own:
 *
 *   - `link.a.obj` / `link.b.obj` — a physical link's endpoints;
 *   - `trigger.props.targets[]` — what a trigger activates;
 *   - `goal.props.accepts[]` — which bodies count (or the literal `"any"`);
 *   - `rope.props.via[]` — the pulleys a rope routes through.
 *
 * Delete-cascade, rename-cascade and paste-remap are the same walk over those
 * four places with a different verb, so the walk is written once. Getting this
 * list wrong is not a cosmetic bug: a `targets` entry pointing at a deleted
 * object is 02 §8 rule 3, an error, and the builder's whole claim in 04 §8.5 is
 * that errors are "nearly impossible" because the interaction model prevents
 * them.
 */

import type { GoalObject, Id, Link, RopeLink, SceneObject, TriggerObject } from '@physics/scene-format';

/** The three id-list props, by the name `RefEdit.list` uses. */
export type RefList = 'targets' | 'accepts' | 'via';

/** One id-list found on an object or link, in a form callers can rewrite. */
export interface RefListSite {
  /** The object/link that owns the list. */
  owner: Id;
  list: RefList;
  ids: Id[];
}

function triggerTargets(obj: SceneObject): Id[] | null {
  if (obj.type !== 'trigger') return null;
  const props = (obj as TriggerObject).props;
  return Array.isArray(props?.targets) ? (props.targets as Id[]) : null;
}

function goalAccepts(obj: SceneObject): Id[] | null {
  if (obj.type !== 'goal') return null;
  const accepts = (obj as GoalObject).props?.accepts;
  // `"any"` is a scalar sentinel, not a list (02 §5.3) — nothing to cascade.
  return Array.isArray(accepts) ? (accepts as Id[]) : null;
}

function ropeVia(link: Link): Id[] | null {
  if (link.type !== 'rope') return null;
  const via = (link as RopeLink).props?.via;
  return Array.isArray(via) ? (via as Id[]) : null;
}

/** Every id-list an object carries (0 or 1 of them, in practice). */
export function objectRefLists(obj: SceneObject): RefListSite[] {
  const targets = triggerTargets(obj);
  if (targets) return [{ owner: obj.id, list: 'targets', ids: targets }];
  const accepts = goalAccepts(obj);
  if (accepts) return [{ owner: obj.id, list: 'accepts', ids: accepts }];
  return [];
}

/** Every id-list a link carries. */
export function linkRefLists(link: Link): RefListSite[] {
  const via = ropeVia(link);
  return via ? [{ owner: link.id, list: 'via', ids: via }] : [];
}

/** Both endpoints of a link, as ids. */
export function linkEndpoints(link: Link): readonly [Id, Id] {
  return [link.a.obj, link.b.obj];
}

/**
 * Rewrite every reference an object holds through `map`. Ids the map does not
 * mention are left alone. Mutates in place — callers own freshly cloned
 * documents (paste) or are inside a command (rename).
 */
export function remapObjectRefs(obj: SceneObject, map: ReadonlyMap<Id, Id>): void {
  for (const site of objectRefLists(obj)) {
    for (let i = 0; i < site.ids.length; i++) {
      const to = map.get(site.ids[i] as Id);
      if (to !== undefined) site.ids[i] = to;
    }
  }
}

/** Rewrite a link's endpoints and `via` list through `map`. */
export function remapLinkRefs(link: Link, map: ReadonlyMap<Id, Id>): void {
  const a = map.get(link.a.obj);
  if (a !== undefined) link.a.obj = a;
  const b = map.get(link.b.obj);
  if (b !== undefined) link.b.obj = b;
  for (const site of linkRefLists(link)) {
    for (let i = 0; i < site.ids.length; i++) {
      const to = map.get(site.ids[i] as Id);
      if (to !== undefined) site.ids[i] = to;
    }
  }
}
