/**
 * The strict writer — 02 §2, 04 §8.2, §10.1, §14.
 *
 * Three rules, none of them optional:
 *
 *   1. **Quantize every number** to ≤ 4 fractional digits, with the *exact*
 *      function 02 §2 names — `Math.round(x · 1e4) / 1e4`, `−0` normalized. Not
 *      `toFixed(4)`: the two disagree on every negative value whose `× 1e4`
 *      product lands on a `.5` tie, and the reader (DET-4) uses `Math.round`.
 *      A writer that rounded the other way would break `expand(scene) ===
 *      expand(parse(serialize(scene)))`, which is 03 §12's round-trip identity.
 *      So the writer imports the engine's `quantize` rather than reimplementing
 *      it — one function, no chance of two.
 *   2. **Omit defaults.** A value equal to its default is not written. The
 *      defaults come from the format package's tables (`PROP_DEFAULTS`,
 *      `MATERIAL_DEFAULTS`, `STATIC_SURFACE_DEFAULTS`, `DYN_COMMON_DEFAULTS`,
 *      `LINK_PROP_DEFAULTS`, `WORLD_DEFAULTS`), which is where 02 §5.2 says they
 *      live and what DET-4 fills from — not from a second list kept here.
 *   3. **Never emit anything outside the spec** (02 §2, ADR-0005 rule 6). The
 *      output is assembled key by key from the catalog, so an unknown field a
 *      tolerant reader preserved in memory cannot leak into a saved file.
 *
 * `skin` is deliberately *not* subject to rule 2. 02 §5.1 gives it no default —
 * the per-type fallback in 04 §12.3 is what a *reader* does with an unknown or
 * absent name, which is a different thing from a value the writer may drop.
 *
 * The property that matters is not byte-equality with any particular file (02
 * §10's examples are hand-authored, with `active: true` written out and props
 * in reading order). It is that **writing cannot change what simulates**:
 *
 *     canonicalize(parse(serialize(doc))) ≡ canonicalize(doc)
 *
 * which is 04 §15 decision 5 — "what plays is exactly what saves" — stated as
 * something a test can run. `write.test.mjs` runs it over the whole §12 corpus.
 */

import type {
  Endpoint,
  Id,
  Link,
  LinkType,
  ObjectType,
  Scene,
  SceneMeta,
  SceneObject,
  Vec2,
  World,
} from '@physics/scene-format';
import {
  DYN_COMMON_DEFAULTS,
  LINK_PROP_DEFAULTS,
  MATERIAL_DEFAULTS,
  PROP_DEFAULTS,
  SCHEMA_VERSION,
  STATIC_SURFACE_DEFAULTS,
  WORLD_DEFAULTS,
} from '@physics/scene-format';
import { quantize } from '@physics/engine/geometry';
import type { SceneDoc } from './document.js';
import {
  DYN_MATERIAL_FIELDS,
  DYN_MOTION_FIELDS,
  LINK_PROP_FIELDS,
  MATERIAL_SECTION,
  STATIC_SURFACE_FIELDS,
  TYPE_PROP_FIELDS,
} from './model.js';

type Bag = Record<string, unknown>;

/** `Math.round(x·1e4)/1e4` with −0 → 0, via the engine so there is one of it. */
export const q = (x: number): number => quantize(x);

const qVec = (v: Vec2): Vec2 => [q(v[0]), q(v[1])];

function sameNumber(a: unknown, b: unknown): boolean {
  return typeof a === 'number' && typeof b === 'number' && q(a) === q(b);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  }
  if (typeof a === 'number' || typeof b === 'number') return sameNumber(a, b);
  return a === b;
}

/**
 * The defaults that apply to one object: its catalog props, plus whichever
 * material/motion block 04 §8.1 gives its type.
 */
function defaultsFor(type: ObjectType): Bag {
  const out: Bag = { ...(PROP_DEFAULTS[type] as Bag) };
  const section = MATERIAL_SECTION[type];
  if (section === 'dyn') {
    Object.assign(out, MATERIAL_DEFAULTS[type as keyof typeof MATERIAL_DEFAULTS], DYN_COMMON_DEFAULTS);
    // 02 §5.3: trigger targets and rope via default to [] but are absent from
    // the constant tables on purpose (a shared mutable array is a footgun).
  } else if (section === 'staticSurface') {
    Object.assign(out, STATIC_SURFACE_DEFAULTS);
  }
  return out;
}

/** Prop key order for a type: catalog fields, then material, then motion. */
function propOrder(type: ObjectType): string[] {
  const keys = TYPE_PROP_FIELDS[type].map((f) => f.key as string);
  const section = MATERIAL_SECTION[type];
  if (section === 'dyn') {
    keys.push(...DYN_MATERIAL_FIELDS.map((f) => f.key as string), ...DYN_MOTION_FIELDS.map((f) => f.key as string));
  } else if (section === 'staticSurface') {
    keys.push(...STATIC_SURFACE_FIELDS.map((f) => f.key as string));
  }
  // De-duplicate while keeping first appearance (w/h appear once each already,
  // but a future descriptor change should not silently emit a key twice).
  return [...new Set(keys)];
}

/** Quantize a prop value; lists and scalars pass through by shape. */
function writeValue(value: unknown): unknown {
  if (typeof value === 'number') return q(value);
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'number' ? q(v) : v));
  return value;
}

/** `[]` for `targets`/`via` is the default and is not written (02 §5.3, §6.2). */
function isEmptyListDefault(key: string, value: unknown): boolean {
  return (key === 'targets' || key === 'via') && Array.isArray(value) && value.length === 0;
}

function writeObject(obj: SceneObject): SceneObject {
  const defaults = defaultsFor(obj.type);
  const src = (obj.props ?? {}) as Bag;
  const props: Bag = {};
  for (const key of propOrder(obj.type)) {
    if (!(key in src)) continue;
    const value = src[key];
    if (value === undefined) continue;
    if (isEmptyListDefault(key, value)) continue;
    if (key in defaults && sameValue(value, defaults[key])) continue;
    props[key] = writeValue(value);
  }

  const out: Bag = { id: obj.id, type: obj.type, pos: qVec(obj.pos) };
  const rot = obj.rot ?? 0;
  if (q(rot) !== 0) out['rot'] = q(rot);
  if (obj.skin !== undefined) out['skin'] = obj.skin;
  if (Object.keys(props).length > 0) out['props'] = props;
  return out as unknown as SceneObject;
}

function writeEndpoint(e: Endpoint): Endpoint {
  const out: Bag = { obj: e.obj };
  // `anchor` and `at` are mutually exclusive (02 §6); "center" is the default
  // spelling of the local origin, so it carries no information.
  if (e.at !== undefined) out['at'] = qVec(e.at);
  else if (e.anchor !== undefined && e.anchor !== 'center') out['anchor'] = e.anchor;
  return out as unknown as Endpoint;
}

function writeLink(link: Link): Link {
  const defaults = LINK_PROP_DEFAULTS[link.type] as Bag;
  const src = (link.props ?? {}) as Bag;
  const props: Bag = {};
  for (const field of LINK_PROP_FIELDS[link.type as LinkType]) {
    const key = field.key as string;
    if (!(key in src)) continue;
    const value = src[key];
    if (value === undefined) continue;
    if (isEmptyListDefault(key, value)) continue;
    if (key in defaults && sameValue(value, defaults[key])) continue;
    props[key] = writeValue(value);
  }
  const out: Bag = { id: link.id, type: link.type, a: writeEndpoint(link.a), b: writeEndpoint(link.b) };
  if (Object.keys(props).length > 0) out['props'] = props;
  return out as unknown as Link;
}

function writeWorld(world: World): World {
  const out: Bag = {};
  if (!sameNumber(world.gravity ?? WORLD_DEFAULTS.gravity, WORLD_DEFAULTS.gravity)) out['gravity'] = q(world.gravity as number);
  if (!sameNumber(world.planeAngle ?? WORLD_DEFAULTS.planeAngle, WORLD_DEFAULTS.planeAngle)) {
    out['planeAngle'] = q(world.planeAngle as number);
  }
  if ((world.seed ?? WORLD_DEFAULTS.seed) !== WORLD_DEFAULTS.seed) out['seed'] = world.seed;
  if (world.bounds !== undefined && !sameValue(world.bounds, WORLD_DEFAULTS.bounds)) out['bounds'] = qVec(world.bounds);
  return out as World;
}

/** 02 §3 — `title` defaults to "Untitled" and is dropped when it still is. */
function writeMeta(meta: SceneMeta): SceneMeta | undefined {
  const out: Bag = {};
  if (meta.title !== undefined && meta.title !== 'Untitled' && meta.title !== '') out['title'] = meta.title;
  if (meta.description !== undefined && meta.description !== '') out['description'] = meta.description;
  if (meta.tags !== undefined && meta.tags.length > 0) out['tags'] = [...meta.tags];
  if (meta.durationHint !== undefined) out['durationHint'] = q(meta.durationHint);
  return Object.keys(out).length > 0 ? (out as SceneMeta) : undefined;
}

/**
 * The document as it goes to disk, to the validation gate and to `load` — the
 * one representation 04 §10.1 and §14 both mean by "serialize".
 */
export function writeScene(doc: SceneDoc): Scene {
  const scene: Scene = {
    schemaVersion: SCHEMA_VERSION,
    engineVersion: doc.engineVersion,
    world: writeWorld(doc.world),
    objects: doc.objects.map(writeObject),
  };
  const meta = writeMeta(doc.meta);
  if (meta !== undefined) scene.meta = meta;
  if (doc.links.length > 0) scene.links = doc.links.map(writeLink);
  // Key order follows 02 §1's document sketch, and `meta` sits before `world`
  // there — rebuild rather than assign out of order.
  const ordered: Bag = {
    schemaVersion: scene.schemaVersion,
    engineVersion: scene.engineVersion,
  };
  if (scene.meta !== undefined) ordered['meta'] = scene.meta;
  ordered['world'] = scene.world;
  ordered['objects'] = scene.objects;
  if (scene.links !== undefined) ordered['links'] = scene.links;
  return ordered as unknown as Scene;
}

/** The bytes 04 §14's Export downloads. */
export function serializeScene(doc: SceneDoc): string {
  return `${JSON.stringify(writeScene(doc), null, 2)}\n`;
}

/** Byte length of the serialized document — the `LIMITS.maxJsonBytes` budget. */
export function serializedBytes(doc: SceneDoc): number {
  return new TextEncoder().encode(serializeScene(doc)).length;
}

/** Ids the document defines, for the paste/import remap (04 §5.5). */
export function documentIds(scene: Scene): Id[] {
  return [...scene.objects.map((o) => o.id), ...(scene.links ?? []).map((l) => l.id)];
}
