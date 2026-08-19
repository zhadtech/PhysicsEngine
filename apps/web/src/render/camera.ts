/**
 * The workshop-table camera — 04 §4.
 *
 * "Perspective, 'workshop table': pan (X/Y), dolly zoom, and pitch **tilt
 * clamped 0–35°** (default **15°**). No yaw orbit, no roll — the 2D mental model
 * survives (01 §3.2)."
 *
 * The rig has exactly three degrees of freedom (`target`, `distance`, `tilt`)
 * because that is what 04 allows; there is no orbit angle to get lost in and no
 * way to end up looking at the board edge-on. The one rotation that *is* applied
 * about the view axis is `planeAngle` roll, which is a property of the scene
 * rather than of the user's navigation — see `viewRollDeg`.
 *
 * Everything here is ordinary `Math`. Nothing the camera computes reaches a
 * document, a hash or the simulation (DET-1 is about what SimCore steps, and the
 * camera never touches it) — unlike the editor's placement math, whose output
 * *is* authored into the file and therefore goes through `dmath`.
 *
 * ## Two silences 04 §4 leaves, filled here (D8 mechanism, 04 §17)
 *
 * 1. **Field of view.** §4 says "perspective" and gives a zoom range in
 *    *pixels* ("~1 cm spanning ~50 px"), which is only a distance once a vertical
 *    FOV exists. `EDITOR.CAMERA_FOV_DEG = 50` — Three.js's own default, so the
 *    number is not invented so much as adopted, and the zoom limits below are
 *    derived from it rather than tuned.
 * 2. **What "fit bounds" fits.** §4 says the far limit is "fit-bounds + 20%
 *    margin"; a perspective camera at a tilt sees a *trapezoid* of the board, so
 *    "fits" is taken as: the bounds rectangle fits the view frustum measured in
 *    the board plane through the target, on both axes. Tilting therefore does not
 *    silently change how far out you may zoom.
 *
 * Contract: docs/04-BUILDER-UX.md §4.
 */

import type { Vec2 } from '@physics/scene-format';
import { EDITOR } from '../editor/model.js';

const DEG = Math.PI / 180;

/** A 3D point in render space: board X/Y, with +Z out of the board toward the viewer. */
export type Vec3 = readonly [number, number, number];

export interface Viewport {
  widthPx: number;
  heightPx: number;
}

/**
 * The camera, in board coordinates.
 *
 * `target` is the board point at the centre of the screen — the thing pan moves
 * and zoom converges on. `distance` is metres along the view ray from the target
 * to the eye; `tiltDeg` is the pitch above the board plane.
 */
export interface CameraState {
  target: Vec2;
  distance: number;
  tiltDeg: number;
}

/** `C` cycles these two (04 §4). */
export const CAMERA_PRESETS = {
  front: 0,
  table: EDITOR.CAMERA_TILT_DEFAULT_DEG,
} as const;

export type CameraPreset = keyof typeof CAMERA_PRESETS;

export const clampTilt = (deg: number): number => Math.min(EDITOR.CAMERA_TILT_MAX_DEG, Math.max(0, deg));

/** Half-height of the view at the target plane, metres. */
export function viewHalfHeight(distance: number): number {
  return distance * Math.tan((EDITOR.CAMERA_FOV_DEG * DEG) / 2);
}

/** Metres per screen pixel at the target plane — the number the zoom limits are stated in. */
export function metersPerPixel(cam: CameraState, viewport: Viewport): number {
  return (2 * viewHalfHeight(cam.distance)) / Math.max(1, viewport.heightPx);
}

/**
 * Closest the camera may come: "~1 cm spanning ~50 px" (04 §4).
 *
 * Stated as a resolution rather than a distance, so it depends on the viewport —
 * a taller window may dolly closer before hitting the same pixels-per-centimetre.
 */
export function minDistance(viewport: Viewport): number {
  const mPerPx = EDITOR.CAMERA_MIN_SPAN_M / EDITOR.CAMERA_MIN_SPAN_PX;
  const halfHeight = (mPerPx * Math.max(1, viewport.heightPx)) / 2;
  return halfHeight / Math.tan((EDITOR.CAMERA_FOV_DEG * DEG) / 2);
}

/**
 * Farthest the camera may go: the bounds rectangle plus a 20 % margin, fitted on
 * whichever axis is tighter.
 */
export function fitDistance(bounds: Vec2, viewport: Viewport): number {
  const aspect = Math.max(1e-6, viewport.widthPx / Math.max(1, viewport.heightPx));
  const margin = 1 + EDITOR.CAMERA_FIT_MARGIN;
  const halfH = (bounds[1] / 2) * margin;
  const halfW = (bounds[0] / 2) * margin;
  const needed = Math.max(halfH, halfW / aspect);
  return needed / Math.tan((EDITOR.CAMERA_FOV_DEG * DEG) / 2);
}

/**
 * Clamp a distance into 04 §4's range.
 *
 * A window narrow enough that the near limit exceeds the fit distance would give
 * an empty interval; the near limit wins, because being unable to zoom *in* to
 * the stated resolution is a worse failure than seeing past the table edge.
 */
export function clampDistance(distance: number, bounds: Vec2, viewport: Viewport): number {
  const near = minDistance(viewport);
  const far = Math.max(near, fitDistance(bounds, viewport));
  return Math.min(far, Math.max(near, distance));
}

/**
 * View roll from the scene's plane angle — 04 §4.
 *
 * "The renderer rolls the view by `−planeAngle` clamped to ±25° (a 90° wall-run
 * scene rendered fully rolled would be unusable)." Takes **degrees**, the unit
 * the document carries; the canonical world holds radians, so a caller with a
 * `CanonicalWorld` converts once at the boundary rather than this function
 * guessing.
 */
export function viewRollDeg(planeAngleDeg: number): number {
  const clamp = EDITOR.PLANE_ROLL_CLAMP_DEG;
  const roll = Math.min(clamp, Math.max(-clamp, -planeAngleDeg));
  // Negating a zero plane angle yields −0, which is the same rotation but not
  // the same value — and 02 §2 already made the editor care about that
  // distinction once (the strict writer normalizes it), so it is normalized here
  // rather than left to surprise a comparison downstream.
  return Object.is(roll, -0) ? 0 : roll;
}

/**
 * Which way the gravity compass points on screen (04 §4: "a gravity compass
 * arrow is always visible while `planeAngle ≠ 0`").
 *
 * Board-frame gravity is `rotate((0, −1), planeAngle)` (02 §1); the view is
 * rolled by `viewRollDeg`, so the arrow's screen direction is the board vector
 * turned by the roll. When the roll is *clamped* the arrow no longer points
 * straight down — which is the point of showing it.
 */
export function compassDir(planeAngleDeg: number): Vec2 {
  const g = planeAngleDeg * DEG;
  const board: Vec2 = [Math.sin(g), -Math.cos(g)];
  const r = viewRollDeg(planeAngleDeg) * DEG;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [board[0] * c - board[1] * s, board[0] * s + board[1] * c];
}

export const compassVisible = (planeAngleDeg: number): boolean => planeAngleDeg !== 0;

// ---------------------------------------------------------------------------
// The rig: eye position and the cursor ray
// ---------------------------------------------------------------------------

/**
 * Eye position for a state. At tilt 0 the camera faces the board head-on; at
 * tilt θ it rises by `d·sin θ` and pulls back by `d·cos θ`, which is a pitch
 * about the board's X axis and nothing else — no yaw is representable.
 */
export function eyePosition(cam: CameraState): Vec3 {
  const t = clampTilt(cam.tiltDeg) * DEG;
  return [cam.target[0], cam.target[1] - cam.distance * Math.sin(t), cam.distance * Math.cos(t)];
}

/** Orthonormal camera basis: right, up, and the forward the eye looks along. */
export function cameraBasis(cam: CameraState): { right: Vec3; up: Vec3; forward: Vec3 } {
  const t = clampTilt(cam.tiltDeg) * DEG;
  // Pitch about board X only: `right` is invariant, which is the geometric form
  // of 04 §4's "no yaw orbit" — there is no angle here that could introduce one.
  return {
    right: [1, 0, 0],
    up: [0, Math.cos(t), Math.sin(t)],
    forward: [0, Math.sin(t), -Math.cos(t)],
  };
}

/** Screen pixel → normalized device coordinates, +Y up. */
export function toNdc(px: number, py: number, viewport: Viewport): Vec2 {
  return [(px / Math.max(1, viewport.widthPx)) * 2 - 1, 1 - (py / Math.max(1, viewport.heightPx)) * 2];
}

/**
 * The board point under a screen pixel.
 *
 * Returns `null` when the ray runs parallel to (or away from) the board — which
 * a 0–35° tilt cannot produce, but the caller should not have to know that.
 */
export function pickBoardPoint(cam: CameraState, viewport: Viewport, px: number, py: number): Vec2 | null {
  const [ndcX, ndcY] = toNdc(px, py, viewport);
  const tanHalf = Math.tan((EDITOR.CAMERA_FOV_DEG * DEG) / 2);
  const aspect = viewport.widthPx / Math.max(1, viewport.heightPx);
  const { right, up, forward } = cameraBasis(cam);
  const sx = ndcX * aspect * tanHalf;
  const sy = ndcY * tanHalf;
  const dir: Vec3 = [
    forward[0] + right[0] * sx + up[0] * sy,
    forward[1] + right[1] * sx + up[1] * sy,
    forward[2] + right[2] * sx + up[2] * sy,
  ];
  const eye = eyePosition(cam);
  if (Math.abs(dir[2]) < 1e-9) return null;
  const t = -eye[2] / dir[2];
  if (!(t > 0)) return null;
  return [eye[0] + dir[0] * t, eye[1] + dir[1] * t];
}

// ---------------------------------------------------------------------------
// The gestures 04 §4 names
// ---------------------------------------------------------------------------

/** Space+drag / middle-drag / two-finger: move the target across the board. */
export function pan(cam: CameraState, dxPx: number, dyPx: number, viewport: Viewport): CameraState {
  const mpp = metersPerPixel(cam, viewport);
  // Dragging right moves the board right, i.e. the camera left. The vertical
  // axis is divided by cos(tilt) because a tilted view foreshortens board Y:
  // without it, a drag at 35° moves the scene visibly less than the pointer.
  const cosTilt = Math.max(1e-3, Math.cos(clampTilt(cam.tiltDeg) * DEG));
  return {
    ...cam,
    target: [cam.target[0] - dxPx * mpp, cam.target[1] + (dyPx * mpp) / cosTilt],
  };
}

/**
 * Wheel: dolly toward or away, keeping the board point under the cursor fixed
 * (04 §4 "wheel = zoom to cursor").
 *
 * `factor` < 1 moves in. The fixed-point trick is the standard one: pick the
 * board point before the dolly, dolly, pick again, and shift the target by the
 * difference — which works for a perspective camera at any tilt without solving
 * anything.
 */
export function zoomToCursor(
  cam: CameraState,
  factor: number,
  px: number,
  py: number,
  bounds: Vec2,
  viewport: Viewport,
): CameraState {
  const before = pickBoardPoint(cam, viewport, px, py);
  const zoomed: CameraState = { ...cam, distance: clampDistance(cam.distance * factor, bounds, viewport) };
  if (!before) return zoomed;
  const after = pickBoardPoint(zoomed, viewport, px, py);
  if (!after) return zoomed;
  return { ...zoomed, target: [zoomed.target[0] + before[0] - after[0], zoomed.target[1] + before[1] - after[1]] };
}

export interface Extent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * `F` frames the selection, or the world bounds when nothing is selected (04 §4).
 * A degenerate extent (a single marble) still frames legibly because the
 * distance is clamped to the near limit rather than collapsing to zero.
 */
export function frameExtent(cam: CameraState, extent: Extent, bounds: Vec2, viewport: Viewport): CameraState {
  const w = Math.max(1e-6, extent.maxX - extent.minX);
  const h = Math.max(1e-6, extent.maxY - extent.minY);
  return {
    ...cam,
    target: [(extent.minX + extent.maxX) / 2, (extent.minY + extent.maxY) / 2],
    distance: clampDistance(fitDistance([w, h], viewport), bounds, viewport),
  };
}

/** `0` resets: origin, table tilt, fit the whole board. */
export function resetCamera(bounds: Vec2, viewport: Viewport): CameraState {
  return {
    target: [0, 0],
    distance: clampDistance(fitDistance(bounds, viewport), bounds, viewport),
    tiltDeg: CAMERA_PRESETS.table,
  };
}

/** `C` cycles Front (0°) ⇄ Table (15°). */
export function cyclePreset(cam: CameraState): CameraState {
  const atTable = Math.abs(cam.tiltDeg - CAMERA_PRESETS.table) < Math.abs(cam.tiltDeg - CAMERA_PRESETS.front);
  return { ...cam, tiltDeg: atTable ? CAMERA_PRESETS.front : CAMERA_PRESETS.table };
}

/** Free tilt (drag), clamped to 04 §4's 0–35°. */
export function setTilt(cam: CameraState, deg: number): CameraState {
  return { ...cam, tiltDeg: clampTilt(deg) };
}
