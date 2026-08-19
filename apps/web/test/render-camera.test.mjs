// 04 §4: the workshop-table camera, the grid, and the planeAngle roll.
//
// The camera is three numbers and a clamp; the value of testing it is that every
// one of 04 §4's constraints ("no yaw orbit", "tilt clamped 0–35°", "wheel =
// zoom to cursor", "minor pitch follows the snap step") is a property that can
// be violated without anyone noticing on screen for weeks.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAMERA_PRESETS,
  EDITOR,
  cameraBasis,
  clampDistance,
  clampTilt,
  compassDir,
  compassVisible,
  cyclePreset,
  eyePosition,
  fitDistance,
  formatDegrees,
  formatMeters,
  frameExtent,
  gridLines,
  metersPerPixel,
  minDistance,
  outOfBounds,
  pan,
  pickBoardPoint,
  resetCamera,
  setTilt,
  tableEdge,
  viewRollDeg,
  zoomToCursor,
} from '../dist/src/index.js';

const VIEWPORT = { widthPx: 1600, heightPx: 900 };
const BOUNDS = [10, 10];
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

test('tilt is clamped to 04 §4’s 0–35°, and the presets are inside it', () => {
  assert.equal(clampTilt(-40), 0);
  assert.equal(clampTilt(90), EDITOR.CAMERA_TILT_MAX_DEG);
  assert.equal(clampTilt(15), 15);
  assert.equal(CAMERA_PRESETS.front, 0);
  assert.equal(CAMERA_PRESETS.table, EDITOR.CAMERA_TILT_DEFAULT_DEG);
  assert.ok(CAMERA_PRESETS.table <= EDITOR.CAMERA_TILT_MAX_DEG);
});

test('there is no yaw: the camera’s right vector never leaves board X', () => {
  for (let deg = 0; deg <= EDITOR.CAMERA_TILT_MAX_DEG; deg += 5) {
    const { right } = cameraBasis({ target: [3, -2], distance: 4, tiltDeg: deg });
    assert.deepEqual([...right], [1, 0, 0], `tilt ${deg}`);
  }
});

test('the eye rises and pulls back as it tilts, and always looks at the target', () => {
  const flat = eyePosition({ target: [0, 0], distance: 5, tiltDeg: 0 });
  assert.ok(near(flat[1], 0) && near(flat[2], 5), 'front view is head-on');
  const tilted = eyePosition({ target: [0, 0], distance: 5, tiltDeg: 35 });
  assert.ok(tilted[2] < 5 && tilted[1] < 0, 'the table view sits below and closer in Z');
  assert.ok(near(Math.hypot(tilted[1], tilted[2]), 5, 1e-9), 'the distance is preserved');
});

test('the zoom range is the one 04 §4 states, in the units it states it in', () => {
  const min = minDistance(VIEWPORT);
  const cam = { target: [0, 0], distance: min, tiltDeg: 15 };
  const mpp = metersPerPixel(cam, VIEWPORT);
  assert.ok(
    near(mpp * EDITOR.CAMERA_MIN_SPAN_PX, EDITOR.CAMERA_MIN_SPAN_M, 1e-12),
    `1 cm spans 50 px at the near limit (got ${mpp * EDITOR.CAMERA_MIN_SPAN_PX} m)`,
  );
  const far = fitDistance(BOUNDS, VIEWPORT);
  const visibleHalfHeight = metersPerPixel({ ...cam, distance: far }, VIEWPORT) * (VIEWPORT.heightPx / 2);
  assert.ok(
    visibleHalfHeight >= (BOUNDS[1] / 2) * (1 + EDITOR.CAMERA_FIT_MARGIN) - 1e-9,
    'the fit distance shows the bounds plus a 20 % margin',
  );
  assert.equal(clampDistance(1e9, BOUNDS, VIEWPORT), far, 'clamped out');
  assert.equal(clampDistance(0, BOUNDS, VIEWPORT), min, 'clamped in');
});

test('a portrait window may dolly closer than a landscape one for the same pixels-per-cm', () => {
  assert.ok(minDistance({ widthPx: 800, heightPx: 1600 }) > minDistance({ widthPx: 1600, heightPx: 800 }));
});

test('the cursor picks the board point under it, at any tilt', () => {
  for (const tiltDeg of [0, 15, 35]) {
    const cam = { target: [1.5, -0.5], distance: 3, tiltDeg };
    const centre = pickBoardPoint(cam, VIEWPORT, VIEWPORT.widthPx / 2, VIEWPORT.heightPx / 2);
    assert.ok(centre, 'the screen centre hits the board');
    assert.ok(near(centre[0], cam.target[0], 1e-9) && near(centre[1], cam.target[1], 1e-9), `tilt ${tiltDeg}`);
  }
});

test('the wheel zooms to the cursor: the point under it does not move', () => {
  const cam = { target: [0, 0], distance: 4, tiltDeg: 15 };
  const px = 1200;
  const py = 300;
  const before = pickBoardPoint(cam, VIEWPORT, px, py);
  const zoomed = zoomToCursor(cam, 0.8, px, py, BOUNDS, VIEWPORT);
  const after = pickBoardPoint(zoomed, VIEWPORT, px, py);
  assert.ok(zoomed.distance < cam.distance, 'it zoomed in');
  assert.ok(near(before[0], after[0], 1e-6) && near(before[1], after[1], 1e-6), `${before} vs ${after}`);
});

test('zooming to the cursor still respects the distance clamp', () => {
  const cam = { target: [0, 0], distance: minDistance(VIEWPORT), tiltDeg: 15 };
  assert.equal(zoomToCursor(cam, 0.1, 800, 450, BOUNDS, VIEWPORT).distance, cam.distance);
});

test('pan moves the board with the pointer, and compensates for foreshortening', () => {
  const base = { target: [0, 0], distance: 4, tiltDeg: 0 };
  const right = pan(base, 100, 0, VIEWPORT);
  assert.ok(right.target[0] < 0, 'dragging right moves the camera left, i.e. the board right');
  assert.ok(near(right.target[0], -100 * metersPerPixel(base, VIEWPORT), 1e-12), 'horizontally, one pixel is one pixel');

  const flatUp = pan(base, 0, 100, VIEWPORT).target[1];
  const tiltedUp = pan({ ...base, tiltDeg: 35 }, 0, 100, VIEWPORT).target[1];
  assert.ok(tiltedUp > flatUp, 'a tilted view foreshortens board Y, so the same drag must travel further');
  assert.ok(
    near(tiltedUp / flatUp, 1 / Math.cos((35 * Math.PI) / 180), 1e-9),
    `the correction is exactly 1/cos(tilt) (got ${tiltedUp / flatUp})`,
  );
  assert.equal(pan(base, 0, 0, VIEWPORT).target[1], 0, 'no drag, no move');
});

test('F frames an extent; a degenerate extent still frames legibly', () => {
  const cam = { target: [0, 0], distance: 8, tiltDeg: 15 };
  const framed = frameExtent(cam, { minX: 1, minY: 1, maxX: 3, maxY: 2 }, BOUNDS, VIEWPORT);
  assert.deepEqual(framed.target, [2, 1.5]);
  assert.ok(framed.distance < cam.distance, 'it moved in on a small selection');
  const point = frameExtent(cam, { minX: 1, minY: 1, maxX: 1, maxY: 1 }, BOUNDS, VIEWPORT);
  assert.equal(point.distance, minDistance(VIEWPORT), 'a single object bottoms out at the near limit');
});

test('0 resets to the table preset showing the whole board', () => {
  const reset = resetCamera(BOUNDS, VIEWPORT);
  assert.deepEqual(reset.target, [0, 0]);
  assert.equal(reset.tiltDeg, CAMERA_PRESETS.table);
  assert.equal(reset.distance, clampDistance(fitDistance(BOUNDS, VIEWPORT), BOUNDS, VIEWPORT));
});

test('C cycles Front ⇄ Table from wherever the tilt currently is', () => {
  assert.equal(cyclePreset({ target: [0, 0], distance: 4, tiltDeg: 15 }).tiltDeg, CAMERA_PRESETS.front);
  assert.equal(cyclePreset({ target: [0, 0], distance: 4, tiltDeg: 0 }).tiltDeg, CAMERA_PRESETS.table);
  assert.equal(cyclePreset({ target: [0, 0], distance: 4, tiltDeg: 30 }).tiltDeg, CAMERA_PRESETS.front);
  assert.equal(setTilt({ target: [0, 0], distance: 4, tiltDeg: 0 }, 99).tiltDeg, EDITOR.CAMERA_TILT_MAX_DEG);
});

test('the view rolls by −planeAngle, clamped to ±25° (04 §4)', () => {
  assert.equal(viewRollDeg(0), 0);
  assert.equal(viewRollDeg(10), -10);
  assert.equal(viewRollDeg(-10), 10);
  assert.equal(viewRollDeg(90), -EDITOR.PLANE_ROLL_CLAMP_DEG, 'a wall-run scene is not rendered fully rolled');
  assert.equal(viewRollDeg(-90), EDITOR.PLANE_ROLL_CLAMP_DEG);
});

test('the gravity compass points straight down until the roll clamps, then does not', () => {
  assert.equal(compassVisible(0), false);
  assert.equal(compassVisible(12), true);
  const unclamped = compassDir(10);
  assert.ok(near(unclamped[0], 0, 1e-12) && near(unclamped[1], -1, 1e-12), 'inside the clamp the arrow is screen-down');
  const clamped = compassDir(90);
  assert.ok(Math.abs(clamped[0]) > 0.5, 'past the clamp it tells you where gravity really is');
  assert.ok(near(Math.hypot(clamped[0], clamped[1]), 1, 1e-12), 'and it stays a unit vector');
});

test('the grid pitch is the snap step — what you see is what you snap to', () => {
  const view = { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  for (const step of EDITOR.POS_SNAP_CHOICES_M) {
    const grid = gridLines(view, step);
    assert.equal(grid.pitch, step, `pitch follows ${step}`);
    for (const line of grid.vertical) {
      assert.ok(near(Math.abs(line.at / step - Math.round(line.at / step)), 0, 1e-9), 'lines sit on snap points');
    }
  }
});

test('majors are counted from the origin, so panning slides the grid', () => {
  const a = gridLines({ minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 }, 0.01);
  const b = gridLines({ minX: 0.13, minY: -0.5, maxX: 1.13, maxY: 0.5 }, 0.01);
  const majorsOf = (g) => g.vertical.filter((l) => l.major).map((l) => Number(l.at.toFixed(6)));
  for (const at of [...majorsOf(a), ...majorsOf(b)]) {
    assert.ok(near(Math.abs(at / (0.01 * EDITOR.GRID_MAJOR_EVERY) - Math.round(at / (0.01 * EDITOR.GRID_MAJOR_EVERY))), 0, 1e-6));
  }
  assert.ok(majorsOf(a).includes(0), 'the origin is always a major line');
});

test('a fine grid zoomed far out is promoted rather than drawn as a grey wash', () => {
  const grid = gridLines({ minX: -50, minY: -50, maxX: 50, maxY: 50 }, 0.005, 400);
  assert.ok(grid.pitch > 0.005, 'the pitch was promoted');
  assert.ok(grid.vertical.length <= 401, `bounded line count (${grid.vertical.length})`);
});

test('the table edge is world.bounds centred on the origin, and W10 tests the extent', () => {
  assert.deepEqual(tableEdge([4, 2]), { minX: -2, minY: -1, maxX: 2, maxY: 1 });
  assert.equal(outOfBounds({ minX: -1, minY: -0.5, maxX: 1, maxY: 0.5 }, [4, 2]), false);
  assert.equal(
    outOfBounds({ minX: 1.5, minY: -0.5, maxX: 2.5, maxY: 0.5 }, [4, 2]),
    true,
    'a platform centred inside with half its length over the edge is out of bounds',
  );
});

test('coordinates read out in the units 04 §4 states', () => {
  assert.equal(formatMeters(0.5), '0.5');
  assert.equal(formatMeters(0.123456), '0.1235', 'four decimals, matching 02 §2 quantization');
  assert.equal(formatMeters(-0), '0');
  assert.equal(formatDegrees(15), '15°');
});
