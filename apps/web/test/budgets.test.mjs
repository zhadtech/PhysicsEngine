// P3a — the status-bar budgets and the local draft ring (04 §14).
//
// The body count is the one that has to be *exact* rather than close: 04 §14's
// whole promise is that `E_LIMITS` is never a surprise at Play, and an editor
// that undercounts lets an author build a scene the loader will refuse. It is
// exact by construction — the count is the loader's own function — so what is
// tested here is that the multiplier cases actually reach it: a segmented rope
// contributes its segments, an anchored body contributes nothing, and a prefab
// with two pieces contributes one (only the moving half is dynamic).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DraftRing,
  MemoryDraftStore,
  SceneDoc,
  bodyCount,
  budgets,
  shouldOfferRestore,
} from '../dist/src/index.js';
import { LIMITS } from '@physics/scene-format';
import { SIM } from '@physics/engine/protocol';

const scene = (objects, links = []) => ({
  schemaVersion: 1,
  engineVersion: '0.1.0',
  world: {},
  objects,
  links,
});

test('the body count follows the expansion, not the object count', () => {
  assert.equal(bodyCount(scene([{ id: 'p', type: 'platform', pos: [0, 0] }])), 0, 'statics are not dynamic bodies');
  assert.equal(bodyCount(scene([{ id: 'd', type: 'domino', pos: [0, 0] }])), 1);
  assert.equal(
    bodyCount(scene([{ id: 'd', type: 'domino', pos: [0, 0], props: { anchored: true } }])),
    0,
    'anchored bodies are built fixed (03 §6)',
  );
  // A spring is a fixed base plus a dynamic plate — one body, two pieces.
  assert.equal(bodyCount(scene([{ id: 's', type: 'spring', pos: [0, 0] }])), 1);
});

test('a segmented rope is the multiplier 04 §14 warns about', () => {
  const withRope = scene(
    [
      { id: 'a', type: 'crate', pos: [0, 0] },
      { id: 'b', type: 'crate', pos: [1, 0] },
    ],
    [{ id: 'r', type: 'rope', a: { obj: 'a' }, b: { obj: 'b' }, props: { segments: 32 } }],
  );
  assert.equal(bodyCount(withRope), 2 + 32);

  // A routed rope cannot be segmented (W_ROPE_VIA_SEGMENTS_CONFLICT) and so
  // contributes nothing — the count must agree with that, not with the file.
  const routed = scene(
    [
      { id: 'a', type: 'crate', pos: [0, 0] },
      { id: 'b', type: 'crate', pos: [1, 0] },
      { id: 'p', type: 'pulley', pos: [0.5, 1] },
    ],
    [{ id: 'r', type: 'rope', a: { obj: 'a' }, b: { obj: 'b' }, props: { segments: 32, via: ['p'] } }],
  );
  assert.equal(bodyCount(routed), 2);
});

test('budget levels are ok / warn at 80 % / full at 100 %', () => {
  const objects = [];
  for (let i = 0; i < 10; i++) objects.push({ id: `d${i}`, type: 'domino', pos: [i * 0.1, 0] });
  const b = budgets(SceneDoc.clone(scene(objects)));
  assert.equal(b.objects.limit, LIMITS.maxObjects);
  assert.equal(b.links.limit, LIMITS.maxLinks);
  assert.equal(b.bodies.limit, SIM.MAX_DYNAMIC_BODIES);
  assert.equal(b.bytes.limit, LIMITS.maxJsonBytes);
  assert.equal(b.objects.level, 'ok');
  assert.equal(b.blocked, false);
});

test('a rope over the body cap blocks the place tool', () => {
  const over = scene(
    [
      { id: 'a', type: 'crate', pos: [0, 0] },
      { id: 'b', type: 'crate', pos: [1, 0] },
    ],
    Array.from({ length: 300 }, (_, i) => ({
      id: `r${i}`,
      type: 'rope',
      a: { obj: 'a' },
      b: { obj: 'b' },
      props: { segments: 64 },
    })),
  );
  const b = budgets(SceneDoc.clone(over));
  assert.equal(b.bodies.level, 'full');
  assert.equal(b.blocked, true);
});

// ---------------------------------------------------------------------------
// Drafts (04 §14)
// ---------------------------------------------------------------------------

test('the draft ring keeps the newest five', async () => {
  const ring = new DraftRing(new MemoryDraftStore(), 'scene-1');
  for (let i = 0; i < 8; i++) await ring.save(scene([{ id: `d${i}`, type: 'domino', pos: [0, 0] }]), 1000 + i);
  const rows = await ring.list();
  assert.equal(rows.length, 5);
  assert.equal(rows[0].scene.objects[0].id, 'd7', 'newest first');
  assert.equal(rows[4].scene.objects[0].id, 'd3', 'oldest survivor');
});

test('two saves in the same millisecond still order', async () => {
  const ring = new DraftRing(new MemoryDraftStore(), 'k');
  await ring.save(scene([{ id: 'a', type: 'domino', pos: [0, 0] }]), 5000);
  await ring.save(scene([{ id: 'b', type: 'domino', pos: [0, 0] }]), 5000);
  const rows = await ring.list();
  assert.equal(rows[0].scene.objects[0].id, 'b');
});

test('restore is offered only for a draft newer than the copy being opened', () => {
  const draft = { key: 'k', savedAt: 100, seq: 1, scene: scene([]), title: 'x' };
  assert.equal(shouldOfferRestore(null, null), false);
  assert.equal(shouldOfferRestore(draft, null), true, 'no remote copy yet — P3 is local-only');
  assert.equal(shouldOfferRestore(draft, 50), true);
  assert.equal(shouldOfferRestore(draft, 100), false);
  assert.equal(shouldOfferRestore(draft, 200), false);
});
