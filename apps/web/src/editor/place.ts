/**
 * Placement and linking gestures — 04 §5.2, §6.4, §7.1.
 *
 * Placement writes **nothing but what the author chose**: a new object carries
 * its id, type and position and no `props` at all, because every catalog value
 * it would carry is the default and the strict writer would drop it anyway (02
 * §2). Building it "with defaults filled in" and then stripping them on save is
 * the same document by a longer road, and it makes the reset dot in the
 * inspector (04 §8.2) lie — a field that was never touched would render as set.
 *
 * The two gestures with real geometry in them are here as pure functions over
 * the path or the endpoints, so the domino run's spacing and the gear snap's
 * auto-mesh are testable without a pointer.
 */

import type { Id, Link, LinkType, ObjectType, SceneObject, Vec2 } from '@physics/scene-format';
import { ACTIVATABLE_TYPES, AXLE_ATTACHABLE_TYPES, PROP_DEFAULTS } from '@physics/scene-format';
import type { SceneDoc } from './document.js';
import type { IdAllocator } from './ids.js';
import { EDITOR, type EditorCommand } from './model.js';
import type { GeometryView } from './snap.js';
import { gearSnapAt, gearsAreMeshed } from './snap.js';
import { q } from './write.js';

/** A freshly placed object: id, type, pos, and a rotation only if non-zero. */
export function newObject(id: Id, type: ObjectType, pos: Vec2, rot = 0): SceneObject {
  const obj: Record<string, unknown> = { id, type, pos: [q(pos[0]), q(pos[1])] };
  if (q(rot) !== 0) obj['rot'] = q(rot);
  return obj as unknown as SceneObject;
}

/** One click of an armed place tool (04 §5.2). The tool stays armed; that is UI. */
export function placeCommand(ids: IdAllocator, type: ObjectType, pos: Vec2, rot = 0): EditorCommand {
  return { op: 'add', objects: [newObject(ids.nextFor(type), type, pos, rot)], links: [] };
}

// ---------------------------------------------------------------------------
// The domino run (04 §5.2) — the signature tool
// ---------------------------------------------------------------------------

export interface RunStep {
  pos: Vec2;
  /** Degrees: the domino's width axis lies along the path, so its face is
   *  perpendicular to it — which is the orientation that falls forward. */
  rot: number;
}

/**
 * Resample a drawn path into domino placements.
 *
 * Spacing is `factor × h` (default 0.75 × 0.08 = 6 cm, matching 02 §10.1's
 * worked example) measured as **arc length along the path**, not as chord
 * distance between consecutive dominoes: on a curve the chord is shorter than
 * the arc, and spacing by chord would bunch the run up exactly where the author
 * is steering hardest.
 */
export function dominoRun(path: readonly Vec2[], h: number, factor = EDITOR.DOMINO_RUN_SPACING_FACTOR): RunStep[] {
  const [lo, hi] = EDITOR.DOMINO_RUN_SPACING_RANGE as unknown as [number, number];
  const spacing = Math.max(lo, Math.min(hi, factor)) * h;
  if (path.length < 2 || !(spacing > 0)) return [];

  const out: RunStep[] = [];
  // Arc length, measured from the start of the path, at which the next domino
  // goes. Carried across segment boundaries — that is what makes the spacing a
  // property of the path rather than of how the pointer happened to be sampled.
  let nextAt = 0;
  let travelled = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i] as Vec2;
    const b = path[i + 1] as Vec2;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const ux = dx / len;
    const uy = dy / len;
    const rot = q((Math.atan2(dy, dx) * 180) / Math.PI);
    while (nextAt <= travelled + len + 1e-9) {
      const s = nextAt - travelled;
      out.push({ pos: [q(a[0] + ux * s), q(a[1] + uy * s)], rot });
      nextAt += spacing;
    }
    travelled += len;
  }
  return out;
}

/** Shift constrains the drag to a straight line (04 §5.2). */
export function straightPath(from: Vec2, to: Vec2): Vec2[] {
  return [from, to];
}

/** The whole run as one composite undo step (04 §5.2, §9). */
export function dominoRunCommand(
  ids: IdAllocator,
  path: readonly Vec2[],
  h: number = PROP_DEFAULTS.domino.h,
  factor = EDITOR.DOMINO_RUN_SPACING_FACTOR,
): EditorCommand {
  const steps = dominoRun(path, h, factor);
  const objects = steps.map((s) => {
    const obj = newObject(ids.nextFor('domino'), 'domino', s.pos, s.rot) as unknown as Record<string, unknown>;
    // Only write `h` when the author moved it off the catalog default.
    if (q(h) !== PROP_DEFAULTS.domino.h) obj['props'] = { h: q(h) };
    return obj as unknown as SceneObject;
  });
  return { op: 'composite', label: `Domino run (${objects.length})`, commands: [{ op: 'add', objects, links: [] }] };
}

// ---------------------------------------------------------------------------
// Links (04 §7.1) — validity is 02 §8, not a second opinion
// ---------------------------------------------------------------------------

export type LinkRefusal = 'self' | 'type' | 'missing';

/**
 * Whether a link of this type may join these two objects (02 §8, 04 §7.1).
 *
 * The dimming in the link tool and the inline refusal are the same predicate,
 * so a link the UI offers is never one the gate rejects — that is 04 §8.5's
 * claim that errors are nearly impossible, implemented rather than hoped for.
 */
export function linkValidity(type: LinkType, a: ObjectType, b: ObjectType): true | LinkRefusal {
  if (type === 'gearMesh') return a === 'gear' && b === 'gear' ? true : 'type';
  if (type === 'axle') {
    return AXLE_ATTACHABLE_TYPES.includes(a) && AXLE_ATTACHABLE_TYPES.includes(b) ? true : 'type';
  }
  // rope / springLink / weld attach to anything; endpoints on statics and
  // fields resolve to the ground body at load (03 §6).
  return true;
}

export interface LinkEndpointPick {
  obj: Id;
  anchor?: string;
  at?: Vec2;
}

/** Create a link with defaults (04 §7.1 step 3). */
export function createLinkCommand(
  doc: SceneDoc,
  ids: IdAllocator,
  type: LinkType,
  a: LinkEndpointPick,
  b: LinkEndpointPick,
  via: readonly Id[] = [],
): EditorCommand | LinkRefusal {
  const objA = doc.object(a.obj);
  const objB = doc.object(b.obj);
  if (!objA || !objB) return 'missing';
  if (a.obj === b.obj) return 'self';
  const ok = linkValidity(type, objA.type, objB.type);
  if (ok !== true) return ok;

  const endpoint = (p: LinkEndpointPick): Record<string, unknown> => {
    const e: Record<string, unknown> = { obj: p.obj };
    if (p.at !== undefined) e['at'] = [q(p.at[0]), q(p.at[1])];
    else if (p.anchor !== undefined && p.anchor !== 'center') e['anchor'] = p.anchor;
    return e;
  };

  const link: Record<string, unknown> = { id: ids.nextFor(type), type, a: endpoint(a), b: endpoint(b) };
  if (type === 'rope' && via.length > 0) link['props'] = { via: [...via] };
  return { op: 'add', objects: [], links: [link as unknown as Link] };
}

/** 04 §7.3: which objects highlight when picking `trigger.targets`. */
export function isActivatable(type: ObjectType): boolean {
  return ACTIVATABLE_TYPES.includes(type);
}

// ---------------------------------------------------------------------------
// Gear snap → auto-`gearMesh` (04 §6.4, D9)
// ---------------------------------------------------------------------------

/** A `gearMesh` with no explicit `ratio` is *geometric* — the editor owns it. */
export function isGeometricMesh(link: Link): boolean {
  return link.type === 'gearMesh' && (link.props as { ratio?: number } | undefined)?.ratio === undefined;
}

/**
 * Move a gear, and let the editor manage the geometric meshes that implies
 * (04 §6.4).
 *
 * Both halves of D9's rule are here, and they are one composite so a single
 * undo puts everything back:
 *
 *   - coming *into* tolerance snaps the centre distance to exactly `rA + rB` and
 *     creates a `gearMesh` with `props` omitted — unless the pair already has
 *     one, which would be W11;
 *   - going *out* of tolerance deletes a geometric mesh. A mesh with an explicit
 *     `ratio` is manual (a belt drive) and is never auto-removed, which is what
 *     makes the distinction survive save/reload with no sidecar state.
 */
export function gearMoveCommand(
  doc: SceneDoc,
  view: GeometryView,
  ids: IdAllocator,
  gearId: Id,
  desired: Vec2,
): { command: EditorCommand; snappedTo: Id | null } {
  const moving = view.object(gearId);
  if (!moving || moving.type !== 'gear') {
    return {
      command: {
        op: 'transform',
        deltas: [{ id: gearId, before: doc.placement(gearId) ?? { pos: desired, rot: 0 }, after: { pos: desired, rot: doc.placement(gearId)?.rot ?? 0 } }],
      },
      snappedTo: null,
    };
  }

  const radius = (moving.props as { r: number }).r;
  const snap = gearSnapAt(view, gearId, desired, radius);
  const pos: Vec2 = snap ? snap.pos : [q(desired[0]), q(desired[1])];
  const before = doc.placement(gearId) ?? { pos: moving.pos, rot: 0 };
  const commands: EditorCommand[] = [
    { op: 'transform', deltas: [{ id: gearId, before, after: { pos, rot: before.rot } }] },
  ];

  const meshWith = (other: Id): Link | undefined =>
    doc.links.find(
      (l) =>
        l.type === 'gearMesh' &&
        ((l.a.obj === gearId && l.b.obj === other) || (l.b.obj === gearId && l.a.obj === other)),
    );

  // Drop geometric meshes this move pulls apart. Evaluated against the *new*
  // position, which is why the whole thing is one command rather than a snap
  // followed by a cleanup pass that could be undone separately.
  const stale: Link[] = [];
  for (const link of doc.links) {
    if (link.type !== 'gearMesh' || !isGeometricMesh(link)) continue;
    const other = link.a.obj === gearId ? link.b.obj : link.b.obj === gearId ? link.a.obj : null;
    if (other === null) continue;
    const partner = view.object(other);
    if (!partner) continue;
    const movedSelf = { ...moving, pos };
    if (!gearsAreMeshed(movedSelf, partner)) stale.push(link);
  }
  if (stale.length > 0) {
    commands.push({
      op: 'remove',
      objects: [],
      links: stale,
      refEdits: [],
      at: { objects: [], links: stale.map((l) => doc.linkIndex(l.id)) },
    });
  }

  if (snap && !meshWith(snap.partner)) {
    // `props` omitted: ratio defaults to −rA/rB, which is what makes this a
    // geometric mesh the editor may later remove (04 §6.4).
    const link = { id: ids.nextFor('gearMesh'), type: 'gearMesh', a: { obj: gearId }, b: { obj: snap.partner } };
    commands.push({ op: 'add', objects: [], links: [link as unknown as Link] });
  }

  const label = snap ? `Mesh ${gearId} ⚙ ${snap.partner}` : 'Move gear';
  return {
    command: commands.length === 1 ? (commands[0] as EditorCommand) : { op: 'composite', label, commands },
    snappedTo: snap?.partner ?? null,
  };
}
