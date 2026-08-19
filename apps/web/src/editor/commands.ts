/**
 * The command algebra — 04 §9.
 *
 * Every store mutation is an `EditorCommand`, and undo runs one backwards. That
 * is a stronger claim than "there is an undo stack", and it is the one worth
 * testing: for any command `c` applied to a document `d`,
 *
 *     undo(c, apply(c, d)) ≡ d
 *
 * byte-for-byte, including the reference lists a delete cascaded through and
 * the array positions things sat at. `commands.test.mjs` asserts exactly that
 * over every op, because "undo mostly works" is how editors lose people's work.
 *
 * Applying a command also reports the ids it touched: 04 §5.3 says undo/redo
 * re-selects them, so the user is looking at what just changed rather than
 * hunting for it.
 *
 * **`remove` is the one op with no inverse inside the union.** Putting entities
 * back needs their captured content, their document positions *and* their
 * reference edits together, and `add` carries none of those. Widening the union
 * with a `restore` op no gesture ever produces would be worse than what the
 * command pattern actually says, which is that a command knows how to run
 * itself backwards. So `undoCommand` is the entry point and `invertCommand`
 * serves the ops whose inverse really is another command.
 */

import type { Id, Link, SceneObject } from '@physics/scene-format';
import type { SceneDoc } from './document.js';
import type { EditorCommand, RefEdit } from './model.js';
import { linkRefLists, objectRefLists, remapLinkRefs, remapObjectRefs } from './refs.js';

/** Ids a command touched — what undo/redo re-selects (04 §5.3). */
export interface Touched {
  objects: Id[];
  links: Id[];
}

const none = (): Touched => ({ objects: [], links: [] });

function merge(into: Touched, from: Touched): Touched {
  for (const id of from.objects) if (!into.objects.includes(id)) into.objects.push(id);
  for (const id of from.links) if (!into.links.includes(id)) into.links.push(id);
  return into;
}

/** The id-list a `RefEdit` names, on whichever entity owns it. */
function refSite(doc: SceneDoc, edit: RefEdit): { ids: Id[] } | undefined {
  const link = doc.link(edit.owner);
  const sites = link ? linkRefLists(link) : (() => {
    const obj = doc.object(edit.owner);
    return obj ? objectRefLists(obj) : [];
  })();
  return sites.find((s) => s.list === edit.list);
}

/**
 * Put removed references back where they were.
 *
 * `RefEdit.index` is a position in the list *before* the delete pass ran, so
 * restoring goes in ascending index order — the mirror of the descending pass
 * in `reapplyRefEdits`. Restoring in the other order puts a two-entry removal
 * back in the wrong places, which stays invisible until someone's trigger fires
 * its targets in a different order.
 */
function restoreRefs(doc: SceneDoc, refEdits: readonly RefEdit[]): void {
  for (const edit of refEdits) {
    const site = refSite(doc, edit);
    if (!site) continue;
    site.ids.splice(Math.min(edit.index, site.ids.length), 0, edit.removed);
  }
}

/** Re-strip the references a `remove` recorded — used when redoing the delete. */
function reapplyRefEdits(doc: SceneDoc, refEdits: readonly RefEdit[]): void {
  // Descending, so earlier indices stay valid as later entries are spliced out.
  for (let i = refEdits.length - 1; i >= 0; i--) {
    const edit = refEdits[i] as RefEdit;
    const site = refSite(doc, edit);
    if (site && site.ids[edit.index] === edit.removed) site.ids.splice(edit.index, 1);
  }
}

/** Apply a command to the document, returning the ids it touched. */
export function applyCommand(doc: SceneDoc, cmd: EditorCommand): Touched {
  switch (cmd.op) {
    case 'add': {
      for (const obj of cmd.objects) doc.insertObject(obj);
      for (const link of cmd.links) doc.insertLink(link);
      return { objects: cmd.objects.map((o) => o.id), links: cmd.links.map((l) => l.id) };
    }

    case 'remove': {
      reapplyRefEdits(doc, cmd.refEdits);
      // Links first: a link whose endpoint object is about to go must not be
      // left dangling even for one intermediate state (02 §8 rule 2).
      for (const link of cmd.links) doc.removeLink(link.id);
      for (const obj of cmd.objects) doc.removeObject(obj.id);
      return { objects: cmd.objects.map((o) => o.id), links: cmd.links.map((l) => l.id) };
    }

    case 'transform': {
      for (const d of cmd.deltas) doc.setPlacement(d.id, d.after);
      return { objects: cmd.deltas.map((d) => d.id), links: [] };
    }

    case 'props': {
      const touched = none();
      for (const d of cmd.deltas) {
        const isLink = doc.link(d.id) !== undefined;
        doc.setPath(d.id, d.key, d.after);
        const bucket = isLink ? touched.links : touched.objects;
        if (!bucket.includes(d.id)) bucket.push(d.id);
      }
      return touched;
    }

    case 'world': {
      doc.world = structuredClone(cmd.after);
      return none();
    }

    case 'meta': {
      doc.meta = structuredClone(cmd.after);
      return none();
    }

    case 'rename': {
      const map = new Map<Id, Id>([[cmd.from, cmd.to]]);
      doc.retag(cmd.from, cmd.to);
      // 04 §5.2: "renames cascade through all references as one command".
      for (const obj of doc.objects) remapObjectRefs(obj, map);
      for (const link of doc.links) remapLinkRefs(link, map);
      return doc.link(cmd.to) ? { objects: [], links: [cmd.to] } : { objects: [cmd.to], links: [] };
    }

    case 'composite': {
      const touched = none();
      for (const child of cmd.commands) merge(touched, applyCommand(doc, child));
      return touched;
    }
  }
}

/**
 * The inverse command, for the ops that have one.
 *
 * Throws for `remove` and for any `composite` containing a `remove`: those go
 * through `undoCommand`, which can run a capture backwards. Throwing beats
 * returning something almost right — a silently lossy undo is the failure this
 * whole module exists to prevent.
 */
export function invertCommand(cmd: EditorCommand): EditorCommand {
  switch (cmd.op) {
    case 'add':
      // `applyCommand` always appends, so undoing an add needs no positions and
      // nothing can have been cascaded through the entities it created yet.
      return { op: 'remove', objects: cmd.objects, links: cmd.links, refEdits: [], at: { objects: [], links: [] } };

    case 'remove':
      throw new TypeError('invertCommand: `remove` has no inverse inside the union — use undoCommand (04 §9)');

    case 'transform':
      return { op: 'transform', deltas: cmd.deltas.map((d) => ({ id: d.id, before: d.after, after: d.before })) };

    case 'props':
      return { op: 'props', deltas: cmd.deltas.map((d) => ({ id: d.id, key: d.key, before: d.after, after: d.before })) };

    case 'world':
      return { op: 'world', before: cmd.after, after: cmd.before };

    case 'meta':
      return { op: 'meta', before: cmd.after, after: cmd.before };

    case 'rename':
      return { op: 'rename', from: cmd.to, to: cmd.from };

    case 'composite':
      // Children undo in reverse order — the second half of a composite may
      // depend on the first (gear snap: move, *then* create the mesh).
      return { op: 'composite', label: cmd.label, commands: [...cmd.commands].reverse().map(invertCommand) };
  }
}

/** Run one command backwards against the document. */
export function undoCommand(doc: SceneDoc, cmd: EditorCommand): Touched {
  if (cmd.op === 'remove') {
    // Ascending recorded index, objects before links: every index was captured
    // against the pre-delete document, so reinserting in that order reproduces
    // it exactly.
    cmd.objects.forEach((obj, i) => doc.insertObject(obj, cmd.at.objects[i] ?? doc.objects.length));
    cmd.links.forEach((link, i) => doc.insertLink(link, cmd.at.links[i] ?? doc.links.length));
    restoreRefs(doc, cmd.refEdits);
    return { objects: cmd.objects.map((o) => o.id), links: cmd.links.map((l) => l.id) };
  }
  if (cmd.op === 'composite') {
    const touched = none();
    for (let i = cmd.commands.length - 1; i >= 0; i--) {
      merge(touched, undoCommand(doc, cmd.commands[i] as EditorCommand));
    }
    return touched;
  }
  return applyCommand(doc, invertCommand(cmd));
}

/** Entities a command creates, for id bookkeeping (`IdAllocator`). */
export function createdIds(cmd: EditorCommand): Id[] {
  switch (cmd.op) {
    case 'add':
      return [...cmd.objects.map((o: SceneObject) => o.id), ...cmd.links.map((l: Link) => l.id)];
    case 'composite':
      return cmd.commands.flatMap(createdIds);
    default:
      return [];
  }
}
