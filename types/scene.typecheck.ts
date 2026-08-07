/**
 * Compile-time cross-check: the spec's example scenes must typecheck as `Scene`,
 * and the discriminated unions must narrow correctly. Not shipped; dev-only.
 *
 * P1 added the second half — the ties across the new package boundary. The
 * scene format now lives in `packages/scene-format` while the surfaces that
 * consume it (`api.ts`, `protocol.ts`) are still design-phase files here, so
 * this is the one place both sides are visible at once.
 */
import type { Scene, SceneObject, Link } from './scene';
import type { ApiErrorCode, ApiFinding } from './api';
import { SIM } from './protocol';
import type { Finding } from '../packages/scene-format/src/findings';
import type { GateErrorCode } from '../packages/scene-format/src/validate';
import { BOUNDS_WARN_MARGIN_M } from '../packages/scene-format/src/semantic';
import {
  MATERIAL_DEFAULTS,
  NAMED_ANCHORS,
  isObjectType,
  isDynamicType,
  LIMITS,
  WORLD_DEFAULTS,
} from './scene';

// Example 10.1 — minimal chain
const example1: Scene = {
  schemaVersion: 1,
  engineVersion: '0.1.0',
  meta: { title: 'First chain', tags: ['tutorial'], durationHint: 10 },
  world: { seed: 42 },
  objects: [
    { id: 'floor', type: 'platform', pos: [0, -0.025], props: { w: 3 } },
    { id: 'rmp', type: 'ramp', pos: [-1.1, 0.15], props: { w: 0.6, h: 0.3 } },
    { id: 'm1', type: 'marble', pos: [-1.35, 0.34] },
    { id: 'd1', type: 'domino', pos: [-0.6, 0] },
    { id: 'd2', type: 'domino', pos: [-0.54, 0] },
    { id: 'd3', type: 'domino', pos: [-0.48, 0] },
    { id: 'd4', type: 'domino', pos: [-0.42, 0] },
    { id: 'g1', type: 'goal', pos: [-0.2, 0.05], props: { accepts: ['d4'] } },
  ],
};

// Example 10.2 — mechanism showcase
const example2: Scene = {
  schemaVersion: 1,
  engineVersion: '0.1.0',
  meta: { title: 'Mechanism showcase', durationHint: 30 },
  world: { seed: 7, bounds: [6, 3] },
  objects: [
    { id: 'floor', type: 'platform', pos: [0, -0.025], props: { w: 6 } },
    { id: 'gearA', type: 'gear', pos: [-2, 0.6], props: { r: 0.15, motorSpeed: 90 } },
    { id: 'gearB', type: 'gear', pos: [-1.75, 0.6], props: { r: 0.1 } },
    { id: 'lev', type: 'lever', pos: [-1, 0.3], props: { len: 0.6, pivot: 0.4 } },
    { id: 'pul', type: 'pulley', pos: [0.5, 1.2] },
    { id: 'box', type: 'crate', pos: [0.5, 0.04], props: { magnetic: true } },
    { id: 'mag', type: 'magnet', pos: [1.6, 0.5], props: { strength: -4, active: false } },
    { id: 'fan1', type: 'fan', pos: [-0.2, 0.1], rot: 45, props: { strength: 3, range: 1 } },
    { id: 'tr1', type: 'trigger', pos: [1.2, 0.05], props: { targets: ['pis', 'mag'] } },
    { id: 'pis', type: 'piston', pos: [2.2, 0.03], rot: -90, props: { mode: 'triggered', stroke: 0.3 } },
    { id: 'g1', type: 'goal', pos: [2.8, 0.1], props: { accepts: ['box'] } },
  ],
  links: [
    { id: 'mesh1', type: 'gearMesh', a: { obj: 'gearA' }, b: { obj: 'gearB' } },
    { id: 'r1', type: 'rope', a: { obj: 'lev', anchor: 'endB' }, b: { obj: 'box', anchor: 'top' }, props: { via: ['pul'] } },
  ],
};

// Discriminated-union narrowing
function describe(o: SceneObject): string {
  switch (o.type) {
    case 'domino':
      return `domino h=${o.props?.h ?? 0.08}`;
    case 'gear':
      return `gear motor=${o.props?.motorSpeed ?? 0} deg/s`;
    case 'goal':
      return `goal accepts=${o.props?.accepts === undefined ? 'any' : o.props.accepts}`;
    default:
      return o.type;
  }
}

function linkInfo(l: Link): string {
  if (l.type === 'rope') return `rope via ${l.props?.via?.length ?? 0} pulley(s)`;
  if (l.type === 'gearMesh') return `mesh ratio=${l.props?.ratio ?? 'auto'}`;
  return l.type;
}

// Exhaustiveness: every dynamic type has material defaults
const dominoDefaults = MATERIAL_DEFAULTS.domino.density;

// Anchor table covers all 18 types (Record<ObjectType, ...> enforces it)
const anchorCount = Object.keys(NAMED_ANCHORS).length;

// Guards
const t = 'marble';
const flag = isObjectType(t) && isDynamicType(t);

// ---------------------------------------------------------------------------
// P1 ties: the scene-format package ↔ the surfaces that consume it
// ---------------------------------------------------------------------------

/**
 * Every finding the gate produces is a finding the API can carry (05 §5.2).
 * `ApiFinding` is the wire shape; `Finding` is what `validateScene` returns.
 * Widening one without the other stops compiling here.
 */
const _findingTie: Finding extends ApiFinding ? true : never = true;

/**
 * The gate may only fail with a code the API already declares.
 * `verify-backend.mjs` holds `ApiErrorCode` to a three-way equality with the
 * OpenAPI enum and the 05 §5.2 table, so this keeps the gate inside a set that
 * is checked end to end — inventing an `E_MIGRATION` here would fail to build
 * rather than surface as an undocumented status code in production.
 */
const _gateCodeTie: GateErrorCode extends ApiErrorCode ? true : never = true;

/**
 * W10 warns exactly where DET-10 deletes the body (03 §3). The margins are two
 * numbers in two packages; if the engine moves its removal boundary, the
 * builder's "outside the table" warning must move with it, or the panel starts
 * lying about which objects survive the run.
 */
const _marginTie: typeof BOUNDS_WARN_MARGIN_M extends typeof SIM.REMOVAL_MARGIN_M ? true : never = true;

void _findingTie;
void _gateCodeTie;
void _marginTie;

export const _check = [
  example1,
  example2,
  describe(example1.objects[0]!),
  linkInfo(example2.links![0]!),
  dominoDefaults,
  anchorCount,
  flag,
  LIMITS.maxObjects,
  WORLD_DEFAULTS.gravity,
] as const;
