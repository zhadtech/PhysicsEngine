// P2a companion check — prefab geometry and anchors (03 §6, 02 §6.3).
//
// This is the module the renderer shares with SimCore (03 §5.3), so a mistake
// here is not a wrong picture *or* wrong physics — it is both at once, and they
// agree with each other, which is the hardest kind to notice. The tests below
// therefore check the properties an author would notice: a domino stands on the
// floor it was placed on, a lever turns about its pivot, a flipped ramp is
// still solid, an arc actually has the radius it claims.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPAND,
  anchorNames,
  canonicalize,
  objectGeometry,
  rampVertices,
  resolveAnchor,
  sceneGeometry,
  tessellateCurve,
} from '../dist/src/index.js';
import { NAMED_ANCHORS, OBJECT_TYPES } from '@physics/scene-format';

const close = (a, b, eps = 1e-12) => Math.abs(a - b) <= eps;
const closeVec = (v, [x, y], eps = 1e-12) =>
  close(v[0], x, eps) && close(v[1], y, eps);

/** One canonical object of the given type, with optional props/pose. */
function obj(type, { pos = [0, 0], rot = 0, props } = {}) {
  const doc = {
    schemaVersion: 1,
    engineVersion: '0.1.0',
    world: {},
    objects: [{ id: 'x', type, pos, rot, ...(props ? { props } : {}) }],
  };
  return canonicalize(doc).objects[0];
}

test('every catalog type expands to something, in §6 table order', () => {
  for (const type of OBJECT_TYPES) {
    const g = objectGeometry(obj(type));
    assert.equal(g.type, type);
    const fieldType = type === 'fan' || type === 'magnet';
    assert.equal(g.pieces.length === 0, fieldType, `${type}: fields have no bodies, everything else does`);
    for (const piece of g.pieces) {
      assert.ok(Number.isFinite(piece.pose.pos[0]) && Number.isFinite(piece.pose.pos[1]), `${type} pose`);
      assert.ok(Number.isFinite(piece.pose.rot), `${type} rot`);
      if (piece.kind !== 'sensor') assert.ok(piece.colliders.length > 0, `${type} has colliders`);
    }
  }
});

test('the pieces each prefab expands to are the ones §6 names', () => {
  const pieces = (type, props) => objectGeometry(obj(type, props ? { props } : {})).pieces.map((p) => p.piece);
  assert.deepEqual(pieces('platform'), ['main']);
  assert.deepEqual(pieces('spring'), ['main', 'plate']);
  assert.deepEqual(pieces('piston'), ['main', 'head']);
  assert.deepEqual(pieces('pendulum'), ['main'], 'rod arm is one body');
  assert.deepEqual(pieces('pendulum', { arm: 'rope' }), ['bob'], 'rope arm is a free ball');
  // Sensors are bodies with no contact response.
  assert.equal(objectGeometry(obj('trigger')).pieces[0].kind, 'sensor');
  assert.equal(objectGeometry(obj('goal')).pieces[0].kind, 'sensor');
  // CCD is on exactly where §6 says: marbles and pendulum bobs.
  assert.equal(objectGeometry(obj('marble')).pieces[0].ccd, true);
  assert.equal(objectGeometry(obj('pendulum')).pieces[0].ccd, true);
  assert.equal(objectGeometry(obj('crate')).pieces[0].ccd, undefined);
});

test('a domino stands on the surface it was placed on', () => {
  // Reference point = centre of the base edge (02 §5.3), so the body centre is
  // half a height above `pos` — get this wrong and every domino run sinks into
  // the floor by half a domino.
  const h = 0.08;
  const g = objectGeometry(obj('domino', { pos: [1, 2] }));
  const [body] = g.pieces;
  assert.ok(closeVec(body.pose.pos, [1, 2 + h / 2]), `centre at ${body.pose.pos}`);
  const [box] = body.colliders;
  assert.equal(box.hy, h / 2);
  assert.equal(box.hx, (h * EXPAND.DOMINO_W_OVER_H) / 2, 'width is h/5');

  // Tipped 90°, the offset follows the rotation rather than staying vertical.
  const tipped = objectGeometry(obj('domino', { pos: [0, 0], rot: 90 })).pieces[0];
  assert.ok(closeVec(tipped.pose.pos, [-h / 2, 0]), `centre at ${tipped.pose.pos}`);
});

test('a lever pivots where the author put it', () => {
  const len = 0.4;
  // pivot 0.5 = seesaw: the body centre and the reference point coincide.
  assert.ok(closeVec(objectGeometry(obj('lever', { pos: [1, 1] })).pieces[0].pose.pos, [1, 1]));
  // pivot 0 = the pivot is the left end, so the arm extends to the right.
  const end = objectGeometry(obj('lever', { pos: [0, 0], props: { pivot: 0 } })).pieces[0];
  assert.ok(closeVec(end.pose.pos, [len / 2, 0]), `centre at ${end.pose.pos}`);
  const o = obj('lever', { pos: [0, 0], props: { pivot: 0.25 } });
  assert.ok(closeVec(resolveAnchor(o, { anchor: 'endA' }).world, [-0.1, 0]));
  assert.ok(closeVec(resolveAnchor(o, { anchor: 'endB' }).world, [0.3, 0]));
  assert.ok(closeVec(resolveAnchor(o, { anchor: 'pivot' }).world, [0, 0]));
});

test('ramp vertices are wound CCW whether or not the ramp is flipped', () => {
  const area = (v) => {
    let s = 0;
    for (let i = 0; i < v.length; i++) {
      const [x1, y1] = v[i];
      const [x2, y2] = v[(i + 1) % v.length];
      s += x1 * y2 - x2 * y1;
    }
    return s / 2;
  };
  // A CW-wound "convex" polygon is a degenerate collider in most engines rather
  // than an error — objects fall straight through it.
  assert.ok(area(rampVertices(0.5, 0.3, false)) > 0, 'default winding');
  assert.ok(area(rampVertices(0.5, 0.3, true)) > 0, 'flipped winding');
  // Flipping mirrors x and nothing else: the flipped vertex set is exactly the
  // original set with x negated (the order differs — that is the re-winding).
  const key = (v) => [...v].map(([x, y]) => `${x},${y}`).sort().join(' ');
  const mirrored = rampVertices(0.5, 0.3, false).map(([x, y]) => [-x, y]);
  assert.equal(key(rampVertices(0.5, 0.3, true)), key(mirrored));
  assert.equal(objectGeometry(obj('ramp')).pieces[0].colliders[0].kind, 'polygon');
});

test('curve tessellation follows the §6 formula and stays on the arc', () => {
  // N = max(4, ceil(sweep_deg / 7.5)).
  assert.equal(tessellateCurve(0.4, 90, 0.03, false).segments.length, 12);
  assert.equal(tessellateCurve(0.4, 15, 0.03, false).segments.length, 4, 'the floor of 4 bites');
  assert.equal(tessellateCurve(0.4, 180, 0.03, false).segments.length, 24);
  assert.equal(tessellateCurve(0.4, 91, 0.03, false).segments.length, 13, 'ceil, not round');

  const { points, segments } = tessellateCurve(0.4, 90, 0.03, false);
  for (const [x, y] of points) assert.ok(close(Math.sqrt(x * x + y * y), 0.4, 1e-12), 'point off the arc');
  // Starts at −90° (straight down from the centre) and sweeps CCW.
  assert.ok(closeVec(points[0], [0, -0.4]));
  assert.ok(closeVec(points[points.length - 1], [0.4, 0]));
  // Flipped sweeps the other way from the same start.
  const flipped = tessellateCurve(0.4, 90, 0.03, true);
  assert.ok(closeVec(flipped.points[0], [0, -0.4]));
  assert.ok(closeVec(flipped.points[flipped.points.length - 1], [-0.4, 0]));
  for (const seg of segments) {
    assert.equal(seg.hy, 0.015, 'half thickness');
    assert.ok(seg.hx > 0);
  }
});

test('spring and piston seat their moving part on their base', () => {
  const seatSpring = (EXPAND.SPRING_BASE_H + EXPAND.SPRING_PLATE_H) / 2;
  // passive: starts extended by `travel`, ready to be compressed.
  const passive = objectGeometry(obj('spring', { pos: [0, 0] })).pieces[1];
  assert.ok(closeVec(passive.pose.pos, [0, seatSpring + 0.08]), `plate at ${passive.pose.pos}`);
  // triggered: starts latched flat against the base.
  const triggered = objectGeometry(obj('spring', { props: { mode: 'triggered' } })).pieces[1];
  assert.ok(closeVec(triggered.pose.pos, [0, seatSpring]));
  // rot turns the launch direction; at 90° the plate sits to the left.
  const sideways = objectGeometry(obj('spring', { rot: 90, props: { mode: 'triggered' } })).pieces[1];
  assert.ok(closeVec(sideways.pose.pos, [-seatSpring, 0]), `plate at ${sideways.pose.pos}`);

  const head = objectGeometry(obj('piston')).pieces[1];
  assert.ok(closeVec(head.pose.pos, [0, EXPAND.PISTON_BASE_H]), 'head seated, both modes start retracted');
});

test('prismatic and field axes are unit vectors pointing where §6/§7 say', () => {
  assert.ok(closeVec(objectGeometry(obj('spring')).derived.axis, [0, 1]), 'rot 0 launches up');
  assert.ok(closeVec(objectGeometry(obj('piston', { rot: 90 })).derived.axis, [-1, 0]));
  assert.ok(closeVec(objectGeometry(obj('conveyor')).derived.axis, [1, 0]), 'belt tangent along +X');
  assert.ok(closeVec(objectGeometry(obj('conveyor', { rot: 180 })).derived.axis, [-1, 0]));
  const fan = objectGeometry(obj('fan', { rot: 90 }));
  assert.ok(closeVec(fan.derived.axis, [0, 1]), 'rot 0 blows +X, so 90° blows up');
  // cosHalf is the cone test constant, dcos(spread) — 25° by default.
  assert.ok(close(fan.derived.cosHalf, Math.cos((25 * Math.PI) / 180), 1e-15));
});

test('a pendulum hangs its bob below the pivot, both arm kinds', () => {
  const rod = objectGeometry(obj('pendulum', { pos: [0, 1] })).pieces[0];
  assert.ok(closeVec(rod.pose.pos, [0, 1]), 'rod body origin is the pivot');
  const [ball, arm] = rod.colliders;
  assert.ok(closeVec(ball.offset, [0, -0.3]));
  assert.ok(closeVec(arm.offset, [0, -0.15]));
  assert.equal(arm.hy, 0.15);

  const rope = objectGeometry(obj('pendulum', { pos: [0, 1], props: { arm: 'rope' } })).pieces[0];
  assert.ok(closeVec(rope.pose.pos, [0, 0.7]), 'free bob starts at arm length below');

  // rot displaces the arm from straight down.
  const swung = objectGeometry(obj('pendulum', { pos: [0, 0], rot: 90, props: { arm: 'rope' } })).pieces[0];
  assert.ok(closeVec(swung.pose.pos, [0.3, 0]), `bob at ${swung.pose.pos}`);
});

test('the anchor table matches the format’s NAMED_ANCHORS for every type', () => {
  for (const type of OBJECT_TYPES) {
    assert.deepEqual(
      [...anchorNames(type)].sort(),
      [...NAMED_ANCHORS[type]].sort(),
      `${type}: the builder offers anchors the engine must be able to resolve`,
    );
  }
});

test('every named anchor on every type resolves to a finite world point', () => {
  for (const type of OBJECT_TYPES) {
    const o = obj(type, { pos: [0.5, -0.25], rot: 30 });
    for (const anchor of NAMED_ANCHORS[type]) {
      const r = resolveAnchor(o, { anchor });
      assert.ok(Number.isFinite(r.world[0]) && Number.isFinite(r.world[1]), `${type}.${anchor}`);
    }
    // "center" and an explicit [0,0] offset are the same point, by definition.
    assert.deepEqual(resolveAnchor(o, { anchor: 'center' }).world, resolveAnchor(o, { at: [0, 0] }).world);
    assert.deepEqual(resolveAnchor(o, {}).world, resolveAnchor(o, { at: [0, 0] }).world);
  }
  assert.throws(() => resolveAnchor(obj('marble'), { anchor: 'top' }), RangeError);
});

test('box anchors land on the edge midpoints, rotated with the object', () => {
  const crate = obj('crate', { pos: [1, 1], props: { w: 0.2, h: 0.1 } });
  assert.ok(closeVec(resolveAnchor(crate, { anchor: 'top' }).world, [1, 1.05]));
  assert.ok(closeVec(resolveAnchor(crate, { anchor: 'right' }).world, [1.1, 1]));
  const turned = obj('crate', { pos: [0, 0], rot: 90, props: { w: 0.2, h: 0.1 } });
  assert.ok(closeVec(resolveAnchor(turned, { anchor: 'right' }).world, [0, 0.1]));

  // A domino's box sits above its reference point, so its anchors do too.
  const d = obj('domino', { pos: [0, 0] });
  assert.ok(closeVec(resolveAnchor(d, { anchor: 'bottom' }).world, [0, 0]));
  assert.ok(closeVec(resolveAnchor(d, { anchor: 'top' }).world, [0, 0.08]));
  assert.ok(closeVec(resolveAnchor(d, { anchor: 'left' }).world, [-0.008, 0.04]));
});

test('anchors name the piece they belong to, so links attach to the right body', () => {
  assert.equal(resolveAnchor(obj('piston'), { anchor: 'head' }).piece, 'head');
  assert.equal(resolveAnchor(obj('piston'), { anchor: 'base' }).piece, 'main');
  assert.equal(resolveAnchor(obj('spring'), { anchor: 'plate' }).piece, 'plate');
  assert.equal(resolveAnchor(obj('pendulum', { props: { arm: 'rope' } }), { anchor: 'bob' }).piece, 'bob');
  assert.equal(resolveAnchor(obj('pendulum'), { anchor: 'bob' }).piece, 'main', 'rod: bob is part of the arm body');
  // Fields have no body at all — 03 §6 sends those attachments to `ground`.
  assert.equal(resolveAnchor(obj('fan'), {}).piece, null);
  assert.equal(resolveAnchor(obj('magnet'), {}).piece, null);
});

test('curve endpoints resolve to the ends of the arc', () => {
  const c = obj('curve', { pos: [1, 1], props: { r: 0.4, sweep: 90 } });
  assert.ok(closeVec(resolveAnchor(c, { anchor: 'endA' }).world, [1, 0.6]));
  assert.ok(closeVec(resolveAnchor(c, { anchor: 'endB' }).world, [1.4, 1]));
});

test('sceneGeometry walks the whole scene in id order', () => {
  const doc = {
    schemaVersion: 1,
    engineVersion: '0.1.0',
    world: {},
    objects: [
      { id: 'z', type: 'marble', pos: [0, 0] },
      { id: 'a', type: 'platform', pos: [0, -1] },
    ],
  };
  assert.deepEqual(sceneGeometry(canonicalize(doc)).map((g) => g.id), ['a', 'z']);
});
