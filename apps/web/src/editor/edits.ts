/**
 * Gesture → command builders — 04 §5.5 (delete, duplicate, copy/paste) and
 * §5.2 (rename).
 *
 * These are the places where "the interaction model keeps errors nearly
 * impossible" (04 §8.5) is actually implemented. A delete that left a link
 * hanging off a removed object is 02 §8 rule 2, an *error* — not a warning —
 * and the only thing standing between a user and one is that the delete
 * gesture builds a command which takes the link with it.
 *
 * Every builder is pure: it reads the document and returns a command. Nothing
 * here mutates, so a gesture can be previewed, cancelled, or replayed, and the
 * command that lands in the history is the same object that was inspected.
 */

import type { Id, Link, SceneObject, Vec2 } from '@physics/scene-format';
import { LIMITS } from '@physics/scene-format';
import type { SceneDoc } from './document.js';
import type { IdAllocator } from './ids.js';
import { isValidId } from './ids.js';
import { CLIP_FORMAT, ID_PREFIX, type ClipboardPayload, type EditorCommand, type RefEdit, type Selection } from './model.js';
import { linkRefLists, objectRefLists, remapLinkRefs, remapObjectRefs } from './refs.js';
import { q } from './write.js';

/** Selection expanded to what a delete actually removes. */
export interface DeletePlan {
  objects: SceneObject[];
  links: Link[];
  refEdits: RefEdit[];
  at: { objects: number[]; links: number[] };
}

/**
 * What a delete of `selection` takes with it (04 §5.5).
 *
 * Three parts, and the second two are the ones a hand-rolled delete forgets:
 * the selected entities; every link with an endpoint on a removed object; and
 * every `targets`/`accepts`/`via` entry, anywhere in the document, naming a
 * removed id. The third is captured as `RefEdit`s so undo can put the entries
 * back at the positions they held — a trigger's target order is observable in
 * the activation chain.
 */
export function planDelete(doc: SceneDoc, selection: Selection): DeletePlan {
  const doomed = new Set<Id>(selection.objects.filter((id) => doc.object(id) !== undefined));
  const linkIds = new Set<Id>(selection.links.filter((id) => doc.link(id) !== undefined));
  for (const link of doc.links) {
    if (doomed.has(link.a.obj) || doomed.has(link.b.obj)) linkIds.add(link.id);
  }
  // A removed link's own id can be the target of nothing (links are never
  // activatable), but it *is* in the shared namespace, so references to it are
  // still searched for — cheap, and it means one rule covers both kinds.
  const removedIds = new Set<Id>([...doomed, ...linkIds]);

  const objects = [...doomed]
    .map((id) => ({ id, index: doc.objectIndex(id) }))
    .sort((a, b) => a.index - b.index);
  const links = [...linkIds]
    .map((id) => ({ id, index: doc.linkIndex(id) }))
    .sort((a, b) => a.index - b.index);

  const refEdits: RefEdit[] = [];
  const scan = (owner: Id, sites: readonly { owner: Id; list: 'targets' | 'accepts' | 'via'; ids: Id[] }[]): void => {
    if (removedIds.has(owner)) return; // going away anyway — nothing to restore
    for (const site of sites) {
      site.ids.forEach((id, index) => {
        if (removedIds.has(id)) refEdits.push({ owner: site.owner, list: site.list, index, removed: id });
      });
    }
  };
  for (const obj of doc.objects) scan(obj.id, objectRefLists(obj));
  for (const link of doc.links) scan(link.id, linkRefLists(link));

  return {
    objects: objects.map((o) => doc.object(o.id) as SceneObject),
    links: links.map((l) => doc.link(l.id) as Link),
    refEdits,
    at: { objects: objects.map((o) => o.index), links: links.map((l) => l.index) },
  };
}

/** The one undo step a delete gesture pushes (04 §5.5). */
export function deleteCommand(doc: SceneDoc, selection: Selection): EditorCommand {
  const plan = planDelete(doc, selection);
  return { op: 'remove', objects: plan.objects, links: plan.links, refEdits: plan.refEdits, at: plan.at };
}

// ---------------------------------------------------------------------------
// Duplicate / copy / paste (04 §5.5) — one boundary rule, three gestures
// ---------------------------------------------------------------------------

/**
 * The fragment a selection copies to.
 *
 * The boundary rule is the same for duplicate and copy, and it is asymmetric on
 * purpose: **links** need both endpoints inside the selection or they are
 * dropped (a link to something that is not coming along has nothing to attach
 * to), while **reference lists** keep their outside entries (a duplicated
 * trigger that keeps firing its original piston is almost always what was
 * wanted, 04 §5.5).
 */
export function copyPayload(doc: SceneDoc, selection: Selection): ClipboardPayload {
  const inside = new Set<Id>(selection.objects.filter((id) => doc.object(id) !== undefined));
  const objects = doc.objects.filter((o) => inside.has(o.id)).map((o) => structuredClone(o));
  const explicit = new Set<Id>(selection.links);
  const links = doc.links
    .filter((l) => (inside.has(l.a.obj) && inside.has(l.b.obj)) || (explicit.has(l.id) && inside.has(l.a.obj) && inside.has(l.b.obj)))
    .map((l) => structuredClone(l));
  return { clip: CLIP_FORMAT, objects, links };
}

/** A clipboard payload that came from somewhere else — validated shallowly. */
export function isClipboardPayload(value: unknown): value is ClipboardPayload {
  const v = value as Partial<ClipboardPayload> | null;
  return (
    !!v &&
    v.clip === CLIP_FORMAT &&
    Array.isArray(v.objects) &&
    Array.isArray(v.links) &&
    v.objects.every((o) => typeof (o as SceneObject)?.id === 'string')
  );
}

export interface PasteResult {
  command: EditorCommand;
  /** New id per source id — what the caller selects after the paste. */
  idMap: Map<Id, Id>;
  /**
   * Reference entries that named something outside the fragment and do not
   * exist here either. 04 §5.5: "refs that don't resolve in the target scene
   * are dropped with a toast" — this is the toast's content.
   */
  droppedRefs: { owner: Id; list: string; id: Id }[];
}

/**
 * Place a fragment into the document (04 §5.5).
 *
 * `at` is where the fragment's bounding-box centre lands; relative layout is
 * preserved by translating every position by the same vector. Ids are
 * regenerated because the target scene may already contain the source's — one
 * namespace, no exceptions (02 §2.1) — and internal references follow the new
 * ids while external ones are kept if they resolve and dropped if they do not.
 */
export function pasteCommand(
  doc: SceneDoc,
  ids: IdAllocator,
  payload: ClipboardPayload,
  at: Vec2,
): PasteResult {
  const objects = payload.objects.map((o) => structuredClone(o) as SceneObject);
  const links = payload.links.map((l) => structuredClone(l) as Link);

  // Translate so the fragment's bbox centre sits on the cursor.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const o of objects) {
    minX = Math.min(minX, o.pos[0]);
    maxX = Math.max(maxX, o.pos[0]);
    minY = Math.min(minY, o.pos[1]);
    maxY = Math.max(maxY, o.pos[1]);
  }
  const dx = objects.length > 0 ? at[0] - (minX + maxX) / 2 : 0;
  const dy = objects.length > 0 ? at[1] - (minY + maxY) / 2 : 0;
  for (const o of objects) o.pos = [q(o.pos[0] + dx), q(o.pos[1] + dy)];

  const idMap = new Map<Id, Id>();
  for (const o of objects) {
    const next = ids.nextLike(o.id, ID_PREFIX[o.type]);
    idMap.set(o.id, next);
    o.id = next;
  }
  for (const l of links) {
    const next = ids.nextLike(l.id, ID_PREFIX[l.type]);
    idMap.set(l.id, next);
    l.id = next;
  }
  for (const o of objects) remapObjectRefs(o, idMap);
  for (const l of links) remapLinkRefs(l, idMap);

  // Anything still naming an id that is neither in the fragment nor in the
  // document cannot be kept: 02 §8 rule 3 makes it an error, not a warning.
  const droppedRefs: { owner: Id; list: string; id: Id }[] = [];
  const resolves = (id: Id): boolean => doc.object(id) !== undefined || idMap.has(id) || [...idMap.values()].includes(id);
  const prune = (owner: Id, sites: readonly { list: string; ids: Id[] }[]): void => {
    for (const site of sites) {
      for (let i = site.ids.length - 1; i >= 0; i--) {
        const id = site.ids[i] as Id;
        if (resolves(id)) continue;
        droppedRefs.push({ owner, list: site.list, id });
        site.ids.splice(i, 1);
      }
    }
  };
  for (const o of objects) prune(o.id, objectRefLists(o));
  for (const l of links) prune(l.id, linkRefLists(l));

  return {
    command: { op: 'composite', label: 'Paste', commands: [{ op: 'add', objects, links }] },
    idMap,
    droppedRefs,
  };
}

/**
 * Duplicate in place (04 §5.5, `mod+D` / Alt-drag): the same fragment, offset
 * one snap step right and down. Y is up in the board frame (02 §2), so "down"
 * is −y.
 */
export function duplicateCommand(
  doc: SceneDoc,
  ids: IdAllocator,
  selection: Selection,
  snapStep: number,
): PasteResult {
  const payload = copyPayload(doc, selection);
  let cx = 0;
  let cy = 0;
  if (payload.objects.length > 0) {
    const xs = payload.objects.map((o) => o.pos[0]);
    const ys = payload.objects.map((o) => o.pos[1]);
    cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  }
  const result = pasteCommand(doc, ids, payload, [cx + snapStep, cy - snapStep]);
  return { ...result, command: { op: 'composite', label: 'Duplicate', commands: [result.command] } };
}

// ---------------------------------------------------------------------------
// Rename (04 §5.2)
// ---------------------------------------------------------------------------

export type RenameRefusal = 'invalid' | 'taken' | 'missing';

/**
 * Rename an entity, cascading every reference (04 §5.2). Refuses rather than
 * producing a document the gate would reject: the id grammar is 02 §2.1 and the
 * namespace is shared, so a duplicate is an error, not a warning.
 */
export function renameCommand(doc: SceneDoc, from: Id, to: Id): EditorCommand | RenameRefusal {
  if (!doc.object(from) && !doc.link(from)) return 'missing';
  if (!isValidId(to)) return 'invalid';
  if (to !== from && doc.hasId(to)) return 'taken';
  return { op: 'rename', from, to };
}

// ---------------------------------------------------------------------------
// Budget guards (04 §14) — the place-tool block at 100 %
// ---------------------------------------------------------------------------

/** Whether one more object/link fits under the 02 §7 document limits. */
export function fitsDocumentLimits(doc: SceneDoc, addObjects: number, addLinks: number): boolean {
  return (
    doc.objects.length + addObjects <= LIMITS.maxObjects && doc.links.length + addLinks <= LIMITS.maxLinks
  );
}
