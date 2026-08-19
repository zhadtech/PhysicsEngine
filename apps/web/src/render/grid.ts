/**
 * The board: grid, table edge, and the out-of-bounds tint — 04 §4.
 *
 * "Grid. Rendered on the physics plane, origin center, minor/major lines; minor
 * line pitch follows the current snap step (§6.1) — *what you see is what you
 * snap to*. `world.bounds` renders as the table edge; objects outside bounds get
 * the W10 tint (02 §8)."
 *
 * The load-bearing sentence is the italicised one. A grid drawn at a fixed pitch
 * while the snap step is something else is worse than no grid: it tells the
 * author their object landed between lines when it landed exactly on a snap
 * point. So the pitch is not a render setting — it is `snapStep`, read straight
 * off the store, and `gridLines` takes it as an argument rather than owning a
 * default it could drift from.
 *
 * Contract: docs/04-BUILDER-UX.md §4, §6.1; docs/02-SCENE-FORMAT.md §8 (W10).
 */

import type { Vec2 } from '@physics/scene-format';
import type { Aabb } from '../editor/shapes.js';
import { EDITOR } from '../editor/model.js';

export interface GridLine {
  /** Board coordinate of the line along its axis. */
  at: number;
  major: boolean;
}

export interface Grid {
  pitch: number;
  vertical: readonly GridLine[];
  horizontal: readonly GridLine[];
}

/**
 * Lines covering `view`, at `snapStep` pitch, with a major line every
 * `GRID_MAJOR_EVERY` (04 §4 names minor/major but not the ratio — filled at P3b,
 * 04 §17).
 *
 * Majors are decided by the line's index from the **origin**, not from the left
 * edge of the view, so panning slides the grid rather than reshuffling which
 * lines are heavy — the origin stays visibly the origin (04 §4 "origin center").
 *
 * `maxLines` bounds the work when the camera is zoomed far out with a fine snap
 * step: past it the pitch is promoted to the major spacing and the minors are
 * dropped, because a grid denser than the screen is a grey wash, not a grid.
 */
export function gridLines(view: Aabb, snapStep: number, maxLines = 4000): Grid {
  let pitch = Math.max(1e-4, snapStep);
  const span = Math.max(view.maxX - view.minX, view.maxY - view.minY);
  while (span / pitch > maxLines) pitch *= EDITOR.GRID_MAJOR_EVERY;

  const axis = (min: number, max: number): GridLine[] => {
    const out: GridLine[] = [];
    const first = Math.ceil(min / pitch);
    const last = Math.floor(max / pitch);
    for (let i = first; i <= last; i++) out.push({ at: i * pitch, major: i % EDITOR.GRID_MAJOR_EVERY === 0 });
    return out;
  };
  return { pitch, vertical: axis(view.minX, view.maxX), horizontal: axis(view.minY, view.maxY) };
}

/** The table edge: `world.bounds` is a full width/height centred on the origin (02 §1). */
export function tableEdge(bounds: Vec2): Aabb {
  return { minX: -bounds[0] / 2, minY: -bounds[1] / 2, maxX: bounds[0] / 2, maxY: bounds[1] / 2 };
}

/**
 * W10 (02 §8): an object whose extent leaves the table gets the warning tint.
 *
 * Tested on the object's **extent**, not its reference point — a platform
 * centred inside the bounds with half its length hanging over the edge is
 * exactly the case the warning is for, and a centre test would miss it.
 */
export function outOfBounds(extent: Aabb, bounds: Vec2): boolean {
  const edge = tableEdge(bounds);
  return extent.minX < edge.minX || extent.minY < edge.minY || extent.maxX > edge.maxX || extent.maxY > edge.maxY;
}

/**
 * Board coordinates for display — 04 §4: "Meters with up to 4 decimals (matches
 * the quantization rule 02 §2)".
 *
 * Trailing zeros are dropped: `0.5` reads better than `0.5000`, and the point of
 * the rule is that no *more* than four decimals can be meaningful, not that four
 * must always be shown.
 */
export function formatMeters(x: number): string {
  const rounded = Number(x.toFixed(4));
  return `${Object.is(rounded, -0) ? 0 : rounded}`;
}

/** Angles are degrees in the UI, as they are in the file (02 §2). */
export function formatDegrees(deg: number): string {
  const rounded = Number(deg.toFixed(2));
  return `${Object.is(rounded, -0) ? 0 : rounded}°`;
}
