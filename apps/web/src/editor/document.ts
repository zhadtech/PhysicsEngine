/**
 * The editable document — "the store is law" (04 §1 pillar 5), minus the
 * framework.
 *
 * `SceneDoc` is a `Scene` with the two indexes every interaction needs (id →
 * object, id → link) and nothing else: no React, no Zustand, no DOM. P3c wraps
 * it in a Zustand store as ADR-0003 says; keeping the data model separate is
 * what lets the whole 04 §5/§6/§9 rulebook be tested under `node:test` instead
 * of under a renderer.
 *
 * **Document order is authored order, and is preserved.** DET-3 sorts by id at
 * load, so array order changes nothing about the physics — but 04 §14 promises
 * an export that round-trips, and 02 §10's own examples are not in id order
 * (`floor`, `rmp`, `m1`, `d1`). So the editor never reorders; commands that
 * remove carry the index back (04 §9, amended at P3a).
 *
 * Mutation is in place. A command is applied by mutating and inverted by
 * applying its inverse, which is what makes the history a ring of commands
 * rather than a ring of document snapshots — 5 000 objects × 200 history slots
 * is not a thing to copy per keystroke.
 */

import type { Id, Link, Scene, SceneMeta, SceneObject, World } from '@physics/scene-format';
import { SCHEMA_VERSION } from '@physics/scene-format';
import type { JsonValue, Placement } from './model.js';

/** A record with arbitrary keys — how prop bags are addressed by dot-path. */
type Bag = Record<string, unknown>;

export class SceneDoc {
  schemaVersion: typeof SCHEMA_VERSION = SCHEMA_VERSION;
  engineVersion: string;
  meta: SceneMeta;
  world: World;
  readonly objects: SceneObject[];
  readonly links: Link[];

  private readonly objAt = new Map<Id, number>();
  private readonly linkAt = new Map<Id, number>();

  private constructor(scene: Scene) {
    this.engineVersion = scene.engineVersion;
    this.meta = scene.meta ?? {};
    this.world = scene.world;
    this.objects = scene.objects;
    this.links = scene.links ?? [];
    this.reindex();
  }

  /** Adopt a validated/migrated document. The arrays are taken, not copied. */
  static adopt(scene: Scene): SceneDoc {
    return new SceneDoc(scene);
  }

  /** Deep-copy a document and adopt the copy (import, template, draft restore). */
  static clone(scene: Scene): SceneDoc {
    return new SceneDoc(structuredClone(scene) as Scene);
  }

  private reindex(): void {
    this.objAt.clear();
    this.linkAt.clear();
    for (let i = 0; i < this.objects.length; i++) this.objAt.set((this.objects[i] as SceneObject).id, i);
    for (let i = 0; i < this.links.length; i++) this.linkAt.set((this.links[i] as Link).id, i);
  }

  /** Reindex from `from` onward — an insert/remove only shifts the tail. */
  private reindexObjectsFrom(from: number): void {
    for (let i = from; i < this.objects.length; i++) this.objAt.set((this.objects[i] as SceneObject).id, i);
  }

  private reindexLinksFrom(from: number): void {
    for (let i = from; i < this.links.length; i++) this.linkAt.set((this.links[i] as Link).id, i);
  }

  // -- lookup ---------------------------------------------------------------

  object(id: Id): SceneObject | undefined {
    const i = this.objAt.get(id);
    return i === undefined ? undefined : this.objects[i];
  }

  link(id: Id): Link | undefined {
    const i = this.linkAt.get(id);
    return i === undefined ? undefined : this.links[i];
  }

  objectIndex(id: Id): number {
    return this.objAt.get(id) ?? -1;
  }

  linkIndex(id: Id): number {
    return this.linkAt.get(id) ?? -1;
  }

  /** One namespace for objects and links (02 §2.1). */
  hasId(id: Id): boolean {
    return this.objAt.has(id) || this.linkAt.has(id);
  }

  allIds(): Id[] {
    return [...this.objAt.keys(), ...this.linkAt.keys()];
  }

  /** Links with an endpoint on `id` — the inspector's Links section (04 §8.1). */
  linksTouching(id: Id): Link[] {
    return this.links.filter((l) => l.a.obj === id || l.b.obj === id);
  }

  // -- structure ------------------------------------------------------------

  insertObject(obj: SceneObject, at = this.objects.length): void {
    const i = Math.max(0, Math.min(at, this.objects.length));
    this.objects.splice(i, 0, obj);
    this.reindexObjectsFrom(i);
  }

  insertLink(link: Link, at = this.links.length): void {
    const i = Math.max(0, Math.min(at, this.links.length));
    this.links.splice(i, 0, link);
    this.reindexLinksFrom(i);
  }

  removeObject(id: Id): { object: SceneObject; index: number } | null {
    const i = this.objAt.get(id);
    if (i === undefined) return null;
    const [object] = this.objects.splice(i, 1) as [SceneObject];
    this.objAt.delete(id);
    this.reindexObjectsFrom(i);
    return { object, index: i };
  }

  removeLink(id: Id): { link: Link; index: number } | null {
    const i = this.linkAt.get(id);
    if (i === undefined) return null;
    const [link] = this.links.splice(i, 1) as [Link];
    this.linkAt.delete(id);
    this.reindexLinksFrom(i);
    return { link, index: i };
  }

  /** Change an entity's own id, index included. References are the caller's job. */
  retag(from: Id, to: Id): void {
    const oi = this.objAt.get(from);
    if (oi !== undefined) {
      (this.objects[oi] as SceneObject).id = to;
      this.objAt.delete(from);
      this.objAt.set(to, oi);
      return;
    }
    const li = this.linkAt.get(from);
    if (li !== undefined) {
      (this.links[li] as Link).id = to;
      this.linkAt.delete(from);
      this.linkAt.set(to, li);
    }
  }

  // -- placement ------------------------------------------------------------

  placement(id: Id): Placement | null {
    const obj = this.object(id);
    if (!obj) return null;
    return { pos: [obj.pos[0], obj.pos[1]], rot: obj.rot ?? 0 };
  }

  /**
   * Write a placement. `rot === 0` is stored as an omitted field, because the
   * strict writer omits defaults (02 §2) and the store is what it serializes —
   * keeping an explicit `rot: 0` around would make "did this object rotate?"
   * depend on whether it had ever been rotated back.
   */
  setPlacement(id: Id, p: Placement): void {
    const obj = this.object(id);
    if (!obj) return;
    obj.pos = [p.pos[0], p.pos[1]];
    if (p.rot === 0) delete obj.rot;
    else obj.rot = p.rot;
  }

  // -- dot-path fields (04 §9 `props` command) ------------------------------

  /**
   * Read a field by the dot-path `PropDelta.key` uses: `"skin"`, `"rot"`,
   * `"props.stiffness"`, `"a.anchor"`. One level of nesting is all the format
   * has, so one level is all this resolves.
   */
  getPath(id: Id, key: string): JsonValue | undefined {
    const root = this.entity(id);
    if (!root) return undefined;
    const dot = key.indexOf('.');
    if (dot < 0) return (root as unknown as Bag)[key] as JsonValue | undefined;
    const parent = (root as unknown as Bag)[key.slice(0, dot)] as Bag | undefined;
    return parent === undefined ? undefined : (parent[key.slice(dot + 1)] as JsonValue | undefined);
  }

  /**
   * Write a field by dot-path. `undefined` **deletes** it — that is what
   * `PropDelta` means by "omitted/default" (04 §9), and it is how the reset dot
   * in the inspector (04 §8.2) puts a field back to its default.
   */
  setPath(id: Id, key: string, value: JsonValue | undefined): void {
    const root = this.entity(id);
    if (!root) return;
    const dot = key.indexOf('.');
    if (dot < 0) {
      if (value === undefined) delete (root as unknown as Bag)[key];
      else (root as unknown as Bag)[key] = value;
      return;
    }
    const head = key.slice(0, dot);
    const tail = key.slice(dot + 1);
    let parent = (root as unknown as Bag)[head] as Bag | undefined;
    if (parent === undefined) {
      if (value === undefined) return;
      parent = {};
      (root as unknown as Bag)[head] = parent;
    }
    if (value === undefined) {
      delete parent[tail];
      // An emptied `props` is dropped rather than left as `{}`. The strict
      // writer omits an empty bag anyway (02 §2), so the two documents are the
      // same file — but they are not the same *object*, and undo is asserted on
      // the object. Resetting a field to its default has to leave exactly the
      // document that never had the field.
      if (Object.keys(parent).length === 0) delete (root as unknown as Bag)[head];
    } else {
      parent[tail] = value;
    }
  }

  private entity(id: Id): SceneObject | Link | undefined {
    return this.object(id) ?? this.link(id);
  }

  // -- serialization --------------------------------------------------------

  /**
   * The live document as a `Scene`. This is the *store's* view — not the file:
   * `write()` in `write.ts` is the strict writer (02 §2), and only it may
   * produce something to save, validate or hand to the worker.
   */
  toScene(): Scene {
    const scene: Scene = {
      schemaVersion: this.schemaVersion,
      engineVersion: this.engineVersion,
      world: this.world,
      objects: this.objects,
    };
    if (Object.keys(this.meta).length > 0) scene.meta = this.meta;
    if (this.links.length > 0) scene.links = this.links;
    return scene;
  }

  /** A detached deep copy — for autosave, thumbnails, or handing to a worker. */
  snapshot(): Scene {
    return structuredClone(this.toScene()) as Scene;
  }
}
