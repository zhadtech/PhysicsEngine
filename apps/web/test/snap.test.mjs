// P3a — the snapping system (04 §6) and the placement gestures (§5.2, §6.4).
//
// The surface seat is the one worth staring at. 04 §5.2 calls it
// "reference-point aware: a domino lands on its base", and the temptation is a
// per-type table of how far each reference point sits above the bottom. There
// isn't one here: the cast starts at the ghost's *support* along gravity, which
// is the same answer for a domino (base), a marble (centre, minus r) and a
// rotated crate (a corner), and which keeps working on a tilted board where
// "down" is not −Y.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EDITOR,
  GeometryView,
  dominoRun,
  gearMoveCommand,
  gearSnapAt,
  gearsAreMeshed,
  ghostGeometry,
  linkValidity,
  nudgeDistance,
  resolveSnap,
  smartGuides,
  snapRotation,
  snapToGrid,
  surfaceSeat,
  EditorStore,
  applyCommand,
  isGeometricMesh,
} from '../dist/src/index.js';
import { fixtureScene, floorScene } from './fixtures.mjs';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('grid and rotation snap (04 §6.1)', () => {
  assert.deepEqual(snapToGrid([0.123, -0.077], 0.01), [0.12, -0.08]);
  assert.deepEqual(snapToGrid([0.123, -0.077], 0.05), [0.1, -0.1]);
  assert.deepEqual(snapToGrid([0.123, -0.077], 0), [0.123, -0.077], 'step 0 = no snapping');
  assert.equal(snapRotation(37), 30);
  assert.equal(snapRotation(37, true), 37);
  assert.equal(snapRotation(-37), -30);
});

test('nudge scales by modifier (04 §5.4)', () => {
  assert.equal(nudgeDistance(0.01), 0.01);
  assert.equal(nudgeDistance(0.01, { shift: true }), 0.01 * EDITOR.NUDGE_LARGE_FACTOR);
  assert.equal(nudgeDistance(0.01, { alt: true }), EDITOR.NUDGE_FINE_M);
});

// ---------------------------------------------------------------------------
// Surface seat (04 §5.2)
// ---------------------------------------------------------------------------

test('a domino seats its base on a platform top', () => {
  const view = new GeometryView(floorScene());
  // Floor spans y ∈ [−0.05, 0.05]; drop the domino from 1 cm above it.
  const ghost = ghostGeometry('domino', [0.3, 0.06], 0);
  const seat = surfaceSeat(view, ghost);
  assert.ok(seat, 'the cast found the floor');
  assert.equal(seat.on, 'floor');
  assert.ok(near(seat.pos[1], 0.05, 1e-6), `base landed at ${seat.pos[1]}`);
  assert.ok(near(seat.pos[0], 0.3));
});

test('a marble seats its rim, not its centre', () => {
  const view = new GeometryView(floorScene());
  const ghost = ghostGeometry('marble', [0, 0.08], 0);
  const seat = surfaceSeat(view, ghost);
  assert.ok(seat);
  // Default radius is 0.025; a resting marble's centre sits r above the top.
  assert.ok(near(seat.pos[1], 0.075, 1e-6), `centre landed at ${seat.pos[1]}`);
});

test('the cast reaches exactly SURFACE_SNAP_RANGE_M and no further', () => {
  const view = new GeometryView(floorScene());
  const justInside = ghostGeometry('domino', [0, 0.05 + EDITOR.SURFACE_SNAP_RANGE_M * 0.9], 0);
  const justOutside = ghostGeometry('domino', [0, 0.05 + EDITOR.SURFACE_SNAP_RANGE_M * 1.1], 0);
  assert.ok(surfaceSeat(view, justInside));
  assert.equal(surfaceSeat(view, justOutside), null);
});

test('dynamic bodies are never seat targets', () => {
  const view = new GeometryView({
    schemaVersion: 1,
    engineVersion: '0.1.0',
    world: {},
    objects: [{ id: 'box', type: 'crate', pos: [0, 0], props: { w: 1, h: 0.1 } }],
  });
  assert.equal(surfaceSeat(view, ghostGeometry('domino', [0, 0.06], 0)), null);
});

test('the seat follows gravity on a tilted board', () => {
  const scene = floorScene();
  scene.world = { planeAngle: 90 };
  const view = new GeometryView(scene);
  // planeAngle 90° turns gravity to +X, so a ghost to the left of the slab
  // falls onto its −X face (the slab spans x ∈ [−2, 2]).
  const ghost = ghostGeometry('marble', [-2.04, 0], 0);
  const seat = surfaceSeat(view, ghost);
  assert.ok(seat, 'seated along the rotated gravity direction');
  assert.ok(near(seat.pos[0], -2.025, 1e-6), `landed at ${seat && seat.pos[0]}`);
  assert.ok(near(seat.pos[1], 0, 1e-9), 'did not move across gravity');
});

// ---------------------------------------------------------------------------
// The §6.2 ladder
// ---------------------------------------------------------------------------

test('the ladder is surface > grid > alignment > spacing', () => {
  const view = new GeometryView(floorScene());
  const nearFloor = ghostGeometry('domino', [0.1234, 0.06], 0);
  assert.equal(resolveSnap(view, nearFloor, { step: 0.01, gridOn: true }).kind, 'surface');

  const inAir = ghostGeometry('domino', [0.1234, 1.5], 0);
  assert.equal(resolveSnap(view, inAir, { step: 0.01, gridOn: true }).kind, 'grid');
  assert.deepEqual(resolveSnap(view, inAir, { step: 0.01, gridOn: true }).pos, [0.12, 1.5]);

  assert.equal(resolveSnap(view, nearFloor, { step: 0.01, gridOn: true, bypass: true }).kind, 'none');
});

test('alignment guides are computed even when the grid wins', () => {
  const view = new GeometryView(fixtureScene());
  // dom2 sits at x = −0.54; a ghost a fraction away should see a guide.
  const ghost = ghostGeometry('domino', [-0.5385, 0.3], 0);
  const result = resolveSnap(view, ghost, { step: 0.01, gridOn: true });
  assert.equal(result.kind, 'grid');
  assert.ok(result.guides.guides.length > 0, 'guides are still reported for the canvas');
});

test('with the grid off, alignment captures within ALIGN_SNAP_M', () => {
  const view = new GeometryView(fixtureScene());
  const ghost = ghostGeometry('domino', [-0.5385, 0.3], 0);
  const result = resolveSnap(view, ghost, { step: 0.01, gridOn: false });
  assert.equal(result.kind, 'alignment');
  assert.ok(near(result.pos[0], -0.54, 1e-6), `snapped to ${result.pos[0]}`);
});

test('equal spacing offers the continuation of a run (04 §6.2)', () => {
  const view = new GeometryView(fixtureScene());
  // dom1 at −0.60 and dom2 at −0.54 are 6 cm apart; the next is at −0.48.
  const ghost = ghostGeometry('domino', [-0.48, 0], 0);
  const guides = smartGuides(view, ghost);
  assert.ok(guides.spacing, 'a spacing continuation was offered');
  assert.ok(near(guides.spacing.pos[0], -0.48, 1e-6), `offered ${guides.spacing.pos[0]}`);
  assert.ok(near(guides.spacing.distance, 0.06, 1e-9));
});

// ---------------------------------------------------------------------------
// The domino run (04 §5.2)
// ---------------------------------------------------------------------------

test('a straight run spaces dominoes at factor × h along the path', () => {
  const steps = dominoRun([[0, 0], [0.3, 0]], 0.08, 0.75);
  assert.ok(steps.length >= 5, `expected a run, got ${steps.length}`);
  for (let i = 1; i < steps.length; i++) {
    const d = Math.hypot(steps[i].pos[0] - steps[i - 1].pos[0], steps[i].pos[1] - steps[i - 1].pos[1]);
    assert.ok(near(d, 0.06, 1e-6), `gap ${i} was ${d}`);
  }
  assert.equal(steps[0].rot, 0, 'a run along +X leaves rot at 0');
});

test('a run turns its dominoes to face across the path', () => {
  const steps = dominoRun([[0, 0], [0, 0.3]], 0.08, 0.75);
  assert.ok(steps.length > 1);
  assert.ok(near(steps[1].rot, 90, 1e-6), `rot was ${steps[1].rot}`);
});

test('spacing stays measured along the arc across a corner', () => {
  const steps = dominoRun([[0, 0], [0.12, 0], [0.12, 0.12]], 0.08, 0.75);
  const total = steps.length;
  // 0.24 m of path at 0.06 m spacing → 5 placements (0, .06, .12, .18, .24).
  assert.equal(total, 5, `expected 5 dominoes, got ${total}`);
});

test('the spacing factor is clamped to its slider range', () => {
  const tight = dominoRun([[0, 0], [1, 0]], 0.08, 0.01);
  const loose = dominoRun([[0, 0], [1, 0]], 0.08, 5);
  const gap = (s) => Math.hypot(s[1].pos[0] - s[0].pos[0], s[1].pos[1] - s[0].pos[1]);
  assert.ok(near(gap(tight), 0.4 * 0.08, 1e-9));
  assert.ok(near(gap(loose), 0.95 * 0.08, 1e-9));
});

// ---------------------------------------------------------------------------
// Gear snap and the geometric mesh (04 §6.4, D9)
// ---------------------------------------------------------------------------

test('a gear inside tolerance snaps to exactly rA + rB', () => {
  const view = new GeometryView(fixtureScene());
  // gear1 is at (0.4, 0.3) with r = 0.1; a ghost 0.205 away is 5 mm outside a
  // perfect mesh, inside the 15 mm tolerance, and snaps to exactly 0.2.
  const snap = gearSnapAt(view, 'gearX', [0.605, 0.3], 0.1);
  assert.ok(snap, 'snapped');
  assert.equal(snap.partner, 'gear1');
  const d = Math.hypot(snap.pos[0] - 0.4, snap.pos[1] - 0.3);
  assert.ok(near(d, 0.2, 1e-6), `centre distance ${d}`);
});

test('a gear outside tolerance does not snap', () => {
  const view = new GeometryView(fixtureScene());
  assert.equal(gearSnapAt(view, 'gearX', [0.9, 0.3], 0.1), null);
});

test('moving a gear into mesh creates a props-less gearMesh, once', () => {
  const store = new EditorStore(fixtureScene());
  const view = new GeometryView(store.doc.toScene());
  // Move gear2 away first so the fixture's mesh1 is the only existing one.
  const { command, snappedTo } = gearMoveCommand(store.doc, view, store.ids, 'gear2', [0.6, 0.3]);
  assert.equal(snappedTo, 'gear1');
  store.apply(command);
  const meshes = store.doc.links.filter((l) => l.type === 'gearMesh');
  assert.equal(meshes.length, 1, 'no duplicate mesh (W11)');
});

test('dragging a geometric mesh apart deletes it; a manual one survives', () => {
  const store = new EditorStore(fixtureScene());
  assert.equal(isGeometricMesh(store.doc.link('mesh1')), true);

  const view = new GeometryView(store.doc.toScene());
  const away = gearMoveCommand(store.doc, view, store.ids, 'gear2', [1.5, 0.3]);
  store.apply(away.command);
  assert.equal(store.doc.link('mesh1'), undefined, 'the geometric mesh went with the drag');

  // Same move, but the mesh carries an explicit ratio → manual, never removed.
  const manual = new EditorStore(fixtureScene());
  applyCommand(manual.doc, { op: 'props', deltas: [{ id: 'mesh1', key: 'props.ratio', before: undefined, after: 2 }] });
  assert.equal(isGeometricMesh(manual.doc.link('mesh1')), false);
  const view2 = new GeometryView(manual.doc.toScene());
  manual.apply(gearMoveCommand(manual.doc, view2, manual.ids, 'gear2', [1.5, 0.3]).command);
  assert.ok(manual.doc.link('mesh1'), 'a manual mesh is never auto-removed');
});

test('gearsAreMeshed matches the §6.4 tolerance', () => {
  const view = new GeometryView(fixtureScene());
  assert.equal(gearsAreMeshed(view.object('gear1'), view.object('gear2')), true);
  const far = new GeometryView({
    schemaVersion: 1,
    engineVersion: '0.1.0',
    world: {},
    objects: [
      { id: 'a', type: 'gear', pos: [0, 0], props: { r: 0.1 } },
      { id: 'b', type: 'gear', pos: [0.5, 0], props: { r: 0.1 } },
    ],
  });
  assert.equal(gearsAreMeshed(far.object('a'), far.object('b')), false);
});

// ---------------------------------------------------------------------------
// Link validity (04 §7.1 / 02 §8)
// ---------------------------------------------------------------------------

test('link validity mirrors 02 §8, so the UI cannot offer an invalid link', () => {
  assert.equal(linkValidity('gearMesh', 'gear', 'gear'), true);
  assert.equal(linkValidity('gearMesh', 'gear', 'crate'), 'type');
  assert.equal(linkValidity('axle', 'lever', 'gear'), true);
  assert.equal(linkValidity('axle', 'platform', 'gear'), 'type');
  assert.equal(linkValidity('rope', 'platform', 'fan'), true);
  assert.equal(linkValidity('weld', 'goal', 'magnet'), true);
});
