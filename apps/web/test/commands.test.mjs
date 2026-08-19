// P3a — the command algebra and the history (04 §9, §5.3, §5.5).
//
// The property under test is exactness: applying a command and then running it
// backwards must leave the document byte-identical, *including* the things a
// naive undo loses — the position an object sat at, the order of a trigger's
// targets, and the links a delete cascaded through. Every case below is written
// as "do it, undo it, compare the whole document", because a per-field
// assertion cannot see the field the implementation forgot.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EDITOR,
  EditRejectedError,
  EditorStore,
  SceneDoc,
  applyCommand,
  deleteCommand,
  copyPayload,
  duplicateCommand,
  invertCommand,
  pasteCommand,
  planDelete,
  renameCommand,
  undoCommand,
} from '../dist/src/index.js';
import { fixtureScene, sameJson } from './fixtures.mjs';

const docOf = () => SceneDoc.clone(fixtureScene());
const shot = (doc) => JSON.stringify(doc.toScene());

/** Apply, undo, and assert the document came back exactly. */
function roundTrip(doc, cmd, label) {
  const before = shot(doc);
  applyCommand(doc, cmd);
  assert.notEqual(shot(doc), before, `${label}: the command changed nothing`);
  undoCommand(doc, cmd);
  assert.equal(shot(doc), before, `${label}: undo did not restore the document exactly`);
}

test('add / remove / transform / props / world / meta / rename all round-trip', () => {
  const doc = docOf();
  roundTrip(doc, { op: 'add', objects: [{ id: 'new1', type: 'marble', pos: [1, 1] }], links: [] }, 'add');
  roundTrip(doc, deleteCommand(doc, { objects: ['dom1'], links: [] }), 'remove');
  roundTrip(
    doc,
    { op: 'transform', deltas: [{ id: 'mar1', before: doc.placement('mar1'), after: { pos: [0.5, 0.5], rot: 30 } }] },
    'transform',
  );
  roundTrip(doc, { op: 'props', deltas: [{ id: 'mar1', key: 'props.r', before: undefined, after: 0.04 }] }, 'props');
  roundTrip(doc, { op: 'world', before: doc.world, after: { seed: 9, gravity: 1.62 } }, 'world');
  roundTrip(doc, { op: 'meta', before: doc.meta, after: { title: 'Moon' } }, 'meta');
  roundTrip(doc, { op: 'rename', from: 'gear1', to: 'driver' }, 'rename');
});

test('a delete takes its links and its inbound references with it', () => {
  const doc = docOf();
  const plan = planDelete(doc, { objects: ['gear1'], links: [] });

  assert.deepEqual(plan.objects.map((o) => o.id), ['gear1']);
  // mesh1 has an endpoint on gear1 and must go too (02 §8 rule 2).
  assert.deepEqual(plan.links.map((l) => l.id), ['mesh1']);
  // tri1.targets named gear1 at index 1 (02 §8 rule 3).
  assert.deepEqual(plan.refEdits, [{ owner: 'tri1', list: 'targets', index: 1, removed: 'gear1' }]);

  const cmd = { op: 'remove', objects: plan.objects, links: plan.links, refEdits: plan.refEdits, at: plan.at };
  applyCommand(doc, cmd);
  assert.equal(doc.object('gear1'), undefined);
  assert.equal(doc.link('mesh1'), undefined);
  assert.deepEqual(doc.object('tri1').props.targets, ['fan1']);
});

test('undoing a delete restores document order, not just content', () => {
  const doc = docOf();
  const before = shot(doc);
  // Delete something from the middle; a naive undo would re-append it.
  const cmd = deleteCommand(doc, { objects: ['dom1'], links: [] });
  applyCommand(doc, cmd);
  undoCommand(doc, cmd);
  assert.equal(shot(doc), before);
  assert.equal(doc.objectIndex('dom1'), 3);
});

test('a multi-entry reference removal comes back in the original order', () => {
  const doc = docOf();
  const before = shot(doc);
  // goal1 accepts [mar1, cra1]; deleting both strips two entries from one list.
  const cmd = deleteCommand(doc, { objects: ['mar1', 'cra1'], links: [] });
  applyCommand(doc, cmd);
  assert.deepEqual(doc.object('goal1').props.accepts, []);
  undoCommand(doc, cmd);
  assert.equal(shot(doc), before);
  assert.deepEqual(doc.object('goal1').props.accepts, ['mar1', 'cra1']);
});

test('rename cascades through endpoints, targets, accepts and via', () => {
  const doc = docOf();
  applyCommand(doc, { op: 'rename', from: 'pul1', to: 'wheel' });
  assert.deepEqual(doc.link('rope1').props.via, ['wheel']);
  applyCommand(doc, { op: 'rename', from: 'cra1', to: 'box' });
  assert.equal(doc.link('rope1').a.obj, 'box');
  assert.deepEqual(doc.object('goal1').props.accepts, ['mar1', 'box']);
});

test('rename refuses an invalid, taken or missing id rather than producing a bad document', () => {
  const doc = docOf();
  assert.equal(renameCommand(doc, 'dom1', 'has space'), 'invalid');
  assert.equal(renameCommand(doc, 'dom1', 'dom2'), 'taken');
  assert.equal(renameCommand(doc, 'nope', 'fine'), 'missing');
  assert.deepEqual(renameCommand(doc, 'dom1', 'first'), { op: 'rename', from: 'dom1', to: 'first' });
});

test('a composite undoes its children in reverse', () => {
  const doc = docOf();
  const before = shot(doc);
  const cmd = {
    op: 'composite',
    label: 'Move and mesh',
    commands: [
      { op: 'transform', deltas: [{ id: 'gear2', before: doc.placement('gear2'), after: { pos: [0.7, 0.3], rot: 0 } }] },
      { op: 'add', objects: [], links: [{ id: 'mesh2', type: 'gearMesh', a: { obj: 'gear1' }, b: { obj: 'gear2' } }] },
    ],
  };
  applyCommand(doc, cmd);
  assert.ok(doc.link('mesh2'));
  undoCommand(doc, cmd);
  assert.equal(shot(doc), before);
});

test('invertCommand refuses `remove` instead of returning a lossy inverse', () => {
  assert.throws(
    () => invertCommand({ op: 'remove', objects: [], links: [], refEdits: [], at: { objects: [], links: [] } }),
    /no inverse inside the union/,
  );
});

// ---------------------------------------------------------------------------
// Duplicate / copy / paste (04 §5.5)
// ---------------------------------------------------------------------------

test('copy keeps links inside the selection and drops links crossing it', () => {
  const doc = docOf();
  const both = copyPayload(doc, { objects: ['gear1', 'gear2'], links: [] });
  assert.deepEqual(both.links.map((l) => l.id), ['mesh1']);
  const one = copyPayload(doc, { objects: ['gear1'], links: ['mesh1'] });
  assert.deepEqual(one.links, []);
});

test('duplicate remaps internal references and keeps external ones', () => {
  const doc = docOf();
  const store = new EditorStore(fixtureScene());
  const result = duplicateCommand(store.doc, store.ids, { objects: ['tri1', 'gear1'], links: [] }, 0.01);
  store.apply(result.command);
  const copy = store.doc.object(result.idMap.get('tri1'));
  // gear1 came along → remapped; fan1 did not → kept (04 §5.5).
  assert.deepEqual(copy.props.targets, ['fan1', result.idMap.get('gear1')]);
});

test('paste regenerates ids, preserves relative layout and reports dropped refs', () => {
  const store = new EditorStore(fixtureScene());
  const payload = copyPayload(store.doc, { objects: ['dom1', 'dom2'], links: [] });
  const spacing = payload.objects[1].pos[0] - payload.objects[0].pos[0];
  const result = pasteCommand(store.doc, store.ids, payload, [1, 1]);
  store.apply(result.command);

  const a = store.doc.object(result.idMap.get('dom1'));
  const b = store.doc.object(result.idMap.get('dom2'));
  assert.notEqual(a.id, 'dom1');
  assert.ok(Math.abs(b.pos[0] - a.pos[0] - spacing) < 1e-9, 'relative layout preserved');
  assert.ok(Math.abs((a.pos[0] + b.pos[0]) / 2 - 1) < 1e-9, 'fragment centred on the cursor');

  const orphan = {
    clip: 'physics-sandbox/objects@1',
    objects: [{ id: 'tri9', type: 'trigger', pos: [0, 0], props: { targets: ['ghost'] } }],
    links: [],
  };
  const second = pasteCommand(store.doc, store.ids, orphan, [0, 0]);
  assert.deepEqual(second.droppedRefs, [{ owner: second.idMap.get('tri9'), list: 'targets', id: 'ghost' }]);
});

// ---------------------------------------------------------------------------
// The store: history ring, dirty pointer, test-mode rejection (04 §9)
// ---------------------------------------------------------------------------

test('undo/redo re-selects what the command touched', () => {
  const store = new EditorStore(fixtureScene());
  store.select({ objects: ['floor'] });
  store.apply({ op: 'transform', deltas: [{ id: 'mar1', before: store.doc.placement('mar1'), after: { pos: [0, 1], rot: 0 } }] });
  assert.deepEqual(store.selection.objects, ['floor'], 'a plain edit leaves the selection alone');
  store.undo();
  assert.deepEqual(store.selection.objects, ['mar1']);
  store.redo();
  assert.deepEqual(store.selection.objects, ['mar1']);
});

test('dirty is a pointer comparison: undoing back to the save point is clean again', () => {
  const store = new EditorStore(fixtureScene());
  assert.equal(store.dirty, false);
  store.apply({ op: 'meta', before: store.doc.meta, after: { title: 'A' } });
  assert.equal(store.dirty, true);
  store.markSaved();
  assert.equal(store.dirty, false);
  store.apply({ op: 'meta', before: store.doc.meta, after: { title: 'B' } });
  assert.equal(store.dirty, true);
  store.undo();
  assert.equal(store.dirty, false, 'back at the saved point');
  store.redo();
  assert.equal(store.dirty, true);
});

test('history is a ring of HISTORY_CAP commands', () => {
  const store = new EditorStore(fixtureScene());
  for (let i = 0; i < EDITOR.HISTORY_CAP + 25; i++) {
    store.apply({ op: 'meta', before: store.doc.meta, after: { title: `t${i}` } });
  }
  assert.equal(store.historyDepth, EDITOR.HISTORY_CAP);
  let undone = 0;
  while (store.undo()) undone++;
  assert.equal(undone, EDITOR.HISTORY_CAP);
  assert.equal(store.dirty, true, 'the save point scrolled out of the ring, so it stays dirty');
});

test('a new command clears the redo stack', () => {
  const store = new EditorStore(fixtureScene());
  store.apply({ op: 'meta', before: store.doc.meta, after: { title: 'A' } });
  store.undo();
  assert.equal(store.canRedo, true);
  store.apply({ op: 'meta', before: store.doc.meta, after: { title: 'B' } });
  assert.equal(store.canRedo, false);
});

test('editing is rejected in test mode and history survives the round trip', () => {
  const store = new EditorStore(fixtureScene());
  store.apply({ op: 'meta', before: store.doc.meta, after: { title: 'A' } });
  store.setMode('test');
  assert.throws(() => store.apply({ op: 'meta', before: store.doc.meta, after: { title: 'B' } }), EditRejectedError);
  assert.equal(store.canUndo, false, 'undo/redo are disabled in test');
  store.setMode('edit');
  assert.equal(store.historyDepth, 1);
  assert.equal(store.canUndo, true);
});

test('the id allocator follows undo, so an undone add frees its id', () => {
  const store = new EditorStore(fixtureScene());
  const first = store.ids.nextFor('marble');
  store.apply({ op: 'add', objects: [{ id: first, type: 'marble', pos: [0, 0] }], links: [] });
  store.undo();
  assert.equal(store.ids.peek('mar'), first, 'the id came back');
});

test('the fixture round-trips through a full edit session unchanged', () => {
  const store = new EditorStore(fixtureScene());
  const before = shot(store.doc);
  store.apply(deleteCommand(store.doc, { objects: ['gear1', 'mar1'], links: ['weld1'] }));
  store.apply({ op: 'rename', from: 'dom2', to: 'second' });
  const dup = duplicateCommand(store.doc, store.ids, { objects: ['cra1'] , links: [] }, 0.01);
  store.apply(dup.command);
  while (store.undo());
  assert.ok(sameJson(JSON.parse(shot(store.doc)), JSON.parse(before)));
  assert.equal(shot(store.doc), before);
});
