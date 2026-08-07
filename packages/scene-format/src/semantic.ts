/**
 * Semantic validation — the 02 §8 rules, which live beyond what JSON Schema can
 * express (they need cross-references, the *type* of a referenced object, or
 * arithmetic between fields).
 *
 * Runs after schema validation (05 §5.3 step 6), so the input is already
 * structurally a `Scene`. E-rules reject the document; W-rules annotate an
 * accepted one and are surfaced in the builder's validation panel (04 §7) and
 * the API's `warnings` array (05 §5.3).
 *
 * Rule numbering is the spec's own: E1–E8, W9–W12.
 */

import type { Endpoint, Id, Link, Scene, SceneObject, Vec2 } from './scene.js';
import {
  ACTIVATABLE_TYPES,
  AXLE_ATTACHABLE_TYPES,
  ID_PATTERN,
  LIMITS,
  NAMED_ANCHORS,
  WORLD_DEFAULTS,
} from './scene.js';
import { finding, ptr, type Finding } from './findings.js';

/**
 * Margin around `world.bounds` beyond which an object earns W10.
 *
 * This is DET-10's removal margin (03 §3): bodies whose AABB lies fully outside
 * `bounds` inflated by this much are deleted mid-run as "fell off the table".
 * Warning exactly there is what makes W10 actionable rather than decorative —
 * an object past this line will not survive the first 15 steps. Tied to
 * `SIM.REMOVAL_MARGIN_M` by a compile assertion in `types/scene.typecheck.ts`;
 * the engine cannot move the line without this warning following it.
 */
export const BOUNDS_WARN_MARGIN_M = 2;

// ---------------------------------------------------------------------------
// Typed accessors — the props union is per type, so reads narrow through it.
// ---------------------------------------------------------------------------

const triggerTargets = (o: SceneObject): readonly Id[] | undefined =>
  o.type === 'trigger' ? o.props?.targets : undefined;

const goalAccepts = (o: SceneObject): 'any' | readonly Id[] | undefined =>
  o.type === 'goal' ? o.props?.accepts : undefined;

const ropeVia = (l: Link): readonly Id[] | undefined => (l.type === 'rope' ? l.props?.via : undefined);

const ropeLength = (l: Link): number | undefined => (l.type === 'rope' ? l.props?.length : undefined);

const leverAngles = (o: SceneObject): { min?: number | undefined; max?: number | undefined } =>
  o.type === 'lever' ? { min: o.props?.minAngle, max: o.props?.maxAngle } : {};

const endpoints = (l: Link): readonly (readonly [Endpoint, 'a' | 'b'])[] => [
  [l.a, 'a'],
  [l.b, 'b'],
];

// ---------------------------------------------------------------------------
// Number walking — E6 (finite) and W12 (writer quantization) share one pass.
// ---------------------------------------------------------------------------

/** Fractional digits in a number's shortest round-trip representation. */
export function fractionDigits(n: number): number {
  if (!Number.isFinite(n) || Number.isInteger(n)) return 0;
  const s = String(n);
  const e = s.search(/[eE]/);
  if (e >= 0) {
    const mantissa = s.slice(0, e);
    const exponent = Number(s.slice(e + 1));
    const dot = mantissa.indexOf('.');
    const mantissaFrac = dot < 0 ? 0 : mantissa.length - dot - 1;
    return Math.max(0, mantissaFrac - exponent);
  }
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

function walkNumbers(node: unknown, path: string, visit: (n: number, at: string) => void): void {
  if (typeof node === 'number') {
    visit(node, path);
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) walkNumbers(node[i], path + ptr(i), visit);
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walkNumbers(v, path + ptr(k), visit);
  }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Apply every 02 §8 rule. Returns findings in rule order; the caller splits
 * them by `severity` (05 §5.3 step 6). An empty error set means the document is
 * semantically valid.
 */
export function checkSemantics(doc: Scene): Finding[] {
  const out: Finding[] = [];
  const objects = doc.objects ?? [];
  const links = doc.links ?? [];
  const byId = new Map<Id, SceneObject>();
  for (const o of objects) if (!byId.has(o.id)) byId.set(o.id, o);
  const typeOf = (id: Id): SceneObject['type'] | undefined => byId.get(id)?.type;

  // -- E1: one id namespace, unique, pattern-matching -----------------------
  const seen = new Set<Id>();
  const claim = (id: Id, at: string): void => {
    if (!ID_PATTERN.test(id)) {
      out.push(finding('E1', `id "${id}" does not match ${String(ID_PATTERN)}`, at, [id]));
    }
    if (seen.has(id)) {
      out.push(finding('E1', `duplicate id "${id}" — objects and links share one namespace`, at, [id]));
    }
    seen.add(id);
  };
  objects.forEach((o, i) => claim(o.id, ptr('objects', i, 'id')));
  links.forEach((l, i) => claim(l.id, ptr('links', i, 'id')));

  // -- E2 / E3 / E4 / E5: link and reference integrity ----------------------
  links.forEach((l, i) => {
    const base = ptr('links', i);
    for (const [ep, side] of endpoints(l)) {
      const at = `${base}/${side}`;
      const t = typeOf(ep.obj);

      // E2 — the endpoint names an object that exists.
      if (t === undefined) {
        out.push(finding('E2', `${l.type} "${l.id}" endpoint ${side} names unknown object "${ep.obj}"`, `${at}/obj`, [l.id]));
        continue;
      }

      // E3 — the endpoint's type is one this link may attach to.
      if (l.type === 'gearMesh' && t !== 'gear') {
        out.push(finding('E3', `gearMesh "${l.id}" endpoint ${side} is a ${t}; both endpoints must be gears`, `${at}/obj`, [l.id, ep.obj]));
      }
      if (l.type === 'axle' && !AXLE_ATTACHABLE_TYPES.includes(t)) {
        out.push(finding('E3', `axle "${l.id}" endpoint ${side} is a ${t}, which has no dynamic body`, `${at}/obj`, [l.id, ep.obj]));
      }

      // E5 — a named anchor must exist on that type (02 §6.3).
      if (ep.anchor !== undefined && ep.anchor !== 'center' && !NAMED_ANCHORS[t].includes(ep.anchor)) {
        const known = [...NAMED_ANCHORS[t], 'center'].join(', ');
        out.push(finding('E5', `${t} has no anchor "${ep.anchor}" (has: ${known})`, `${at}/anchor`, [l.id, ep.obj]));
      }
    }

    // E4 — no self-links.
    if (l.a.obj === l.b.obj) {
      out.push(finding('E4', `link "${l.id}" connects "${l.a.obj}" to itself`, base, [l.id, l.a.obj]));
    }

    // E2/E3 — rope waypoints resolve, and route over pulleys.
    const via = ropeVia(l);
    via?.forEach((v, k) => {
      const at = ptr('links', i, 'props', 'via', k);
      const t = typeOf(v);
      if (t === undefined) out.push(finding('E2', `rope "${l.id}" routes via unknown object "${v}"`, at, [l.id]));
      else if (t !== 'pulley') out.push(finding('E3', `rope "${l.id}" routes via a ${t}; via entries must be pulleys`, at, [l.id, v]));
    });
  });

  // -- E2 / E7: object-level references and field arithmetic ----------------
  objects.forEach((o, i) => {
    triggerTargets(o)?.forEach((target, k) => {
      if (typeOf(target) === undefined) {
        out.push(finding('E2', `trigger "${o.id}" targets unknown object "${target}"`, ptr('objects', i, 'props', 'targets', k), [o.id]));
      }
    });

    const accepts = goalAccepts(o);
    if (Array.isArray(accepts)) {
      accepts.forEach((a, k) => {
        if (typeOf(a) === undefined) {
          out.push(finding('E2', `goal "${o.id}" accepts unknown object "${a}"`, ptr('objects', i, 'props', 'accepts', k), [o.id]));
        }
      });
    }

    // E7 — lever limits must describe a non-empty range.
    const { min, max } = leverAngles(o);
    if (min !== undefined && max !== undefined && !(min < max)) {
      out.push(finding('E7', `lever "${o.id}" has minAngle ${min} >= maxAngle ${max}`, ptr('objects', i, 'props'), [o.id]));
    }
  });

  // -- E6 / W12: every number, once ----------------------------------------
  const numberSections: readonly (readonly [unknown, string, Id | null])[] = [
    [doc.world, '/world', null],
    [doc.meta, '/meta', null],
    ...objects.map((o, i) => [o, ptr('objects', i), o.id] as const),
    ...links.map((l, i) => [l, ptr('links', i), l.id] as const),
  ];
  for (const [node, base, id] of numberSections) {
    if (node === undefined) continue;
    const ids = id === null ? undefined : [id];
    walkNumbers(node, base, (n, at) => {
      if (!Number.isFinite(n)) {
        out.push(finding('E6', `non-finite number (${String(n)})`, at, ids));
      } else if (fractionDigits(n) > LIMITS.maxFractionDigits) {
        out.push(finding('W12', `${n} carries more than ${LIMITS.maxFractionDigits} fractional digits; the save path re-quantizes`, at, ids));
      }
    });
  }

  // -- E8: the 02 §7 size limits -------------------------------------------
  if (objects.length > LIMITS.maxObjects) {
    out.push(finding('E8', `${objects.length} objects exceeds the limit of ${LIMITS.maxObjects}`, '/objects'));
  }
  if (links.length > LIMITS.maxLinks) {
    out.push(finding('E8', `${links.length} links exceeds the limit of ${LIMITS.maxLinks}`, '/links'));
  }
  objects.forEach((o, i) => {
    const targets = triggerTargets(o);
    if (targets !== undefined && targets.length > LIMITS.maxTargets) {
      out.push(finding('E8', `trigger "${o.id}" has ${targets.length} targets; the limit is ${LIMITS.maxTargets}`, ptr('objects', i, 'props', 'targets'), [o.id]));
    }
    const accepts = goalAccepts(o);
    if (Array.isArray(accepts) && accepts.length > LIMITS.maxTargets) {
      out.push(finding('E8', `goal "${o.id}" accepts ${accepts.length} ids; the limit is ${LIMITS.maxTargets}`, ptr('objects', i, 'props', 'accepts'), [o.id]));
    }
  });
  links.forEach((l, i) => {
    const via = ropeVia(l);
    if (via !== undefined && via.length > LIMITS.maxRopeVia) {
      out.push(finding('E8', `rope "${l.id}" routes via ${via.length} pulleys; the limit is ${LIMITS.maxRopeVia}`, ptr('links', i, 'props', 'via'), [l.id]));
    }
  });

  // -- W9: a trigger target that nothing happens to -------------------------
  objects.forEach((o, i) => {
    triggerTargets(o)?.forEach((target, k) => {
      const t = typeOf(target);
      if (t !== undefined && !ACTIVATABLE_TYPES.includes(t)) {
        out.push(finding('W9', `trigger "${o.id}" targets "${target}" (${t}), which has no activation effect`, ptr('objects', i, 'props', 'targets', k), [o.id, target]));
      }
    });
  });

  // -- W10: parked outside the table ---------------------------------------
  const bounds: Vec2 = doc.world.bounds ?? WORLD_DEFAULTS.bounds;
  const limitX = bounds[0] / 2 + BOUNDS_WARN_MARGIN_M;
  const limitY = bounds[1] / 2 + BOUNDS_WARN_MARGIN_M;
  objects.forEach((o, i) => {
    const [x, y] = o.pos;
    if (Math.abs(x) > limitX || Math.abs(y) > limitY) {
      out.push(finding('W10', `${o.type} "${o.id}" at [${x}, ${y}] is outside bounds [${bounds[0]}, ${bounds[1]}] plus the ${BOUNDS_WARN_MARGIN_M} m removal margin`, ptr('objects', i, 'pos'), [o.id]));
    }
  });

  // -- W11: duplicate meshes, and ropes that start taut ---------------------
  const meshPairs = new Map<string, Id>();
  links.forEach((l, i) => {
    if (l.type === 'gearMesh') {
      const key = [l.a.obj, l.b.obj].sort().join(' ');
      const first = meshPairs.get(key);
      if (first !== undefined) {
        out.push(finding('W11', `gearMesh "${l.id}" duplicates "${first}" between the same pair`, ptr('links', i), [l.id, first]));
      } else {
        meshPairs.set(key, l.id);
      }
    }

    const length = ropeLength(l);
    if (length === undefined) return;
    const a = byId.get(l.a.obj);
    const b = byId.get(l.b.obj);
    if (a === undefined || b === undefined) return;
    // Reference-point distance: exact anchor geometry is the engine's prefab
    // expansion (03 §6), which this package deliberately does not carry. A
    // W-rule may approximate; an E-rule may not.
    const dist = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]);
    if (Number.isFinite(dist) && length < dist) {
      out.push(finding('W11', `rope "${l.id}" length ${length} is shorter than the ${dist.toFixed(3)} m between its endpoints; it starts taut`, ptr('links', i, 'props', 'length'), [l.id]));
    }
  });

  return out;
}
