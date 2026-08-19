/**
 * The editor store — 04 §9 (history), §5.3 (selection), §3.1 (status bar state).
 *
 * "The store is law" (04 §1 pillar 5): rendering, validation, undo, autosave and
 * serialization all derive from this object. It is deliberately framework-free —
 * P3c wraps it in Zustand per ADR-0003 — because every rule in 04 §9 is a
 * property of the *history*, not of React, and this way they are tested as such.
 *
 * Three rules from §9 that are easy to state and easy to get wrong:
 *
 *   - **One command per gesture.** No time-window merging: a drag commits on
 *     pointer-up, a scrub on release, typing on blur. Predictable granularity
 *     beats clever coalescing, so the store offers no merge at all — callers
 *     build one command and hand it over.
 *   - **Dirty is a pointer comparison, not a flag.** Undoing back to the last
 *     save makes the document clean again, which a boolean cannot express.
 *   - **Editing is rejected in test mode** (01 §3.3 rule 2). The UI disables the
 *     affordances, so a command arriving here during a run is a bug; it throws
 *     rather than being dropped.
 */

import type { Id, Scene } from '@physics/scene-format';
import { applyCommand, createdIds, undoCommand, type Touched } from './commands.js';
import { SceneDoc } from './document.js';
import { IdAllocator } from './ids.js';
import { EDITOR, type EditorCommand, type EditorMode, type Selection, type ToolId } from './model.js';

/** Thrown when an editing command arrives while the run is live (04 §9). */
export class EditRejectedError extends Error {
  constructor(op: string) {
    super(`editing is disabled in test mode (04 §9, 01 §3.3): rejected "${op}"`);
    this.name = 'EditRejectedError';
  }
}

interface HistoryEntry {
  seq: number;
  cmd: EditorCommand;
}

const EMPTY_SELECTION: Selection = { objects: [], links: [] };

export class EditorStore {
  readonly doc: SceneDoc;
  readonly ids: IdAllocator;

  mode: EditorMode = 'edit';
  tool: ToolId = 'select';
  selection: Selection = EMPTY_SELECTION;
  /** Status-bar snap step, meters (04 §6.1). */
  snapStep: number = EDITOR.POS_SNAP_DEFAULT_M;
  /** `G` toggles grid + snap together (04 §13.1). */
  gridOn = true;

  private readonly past: HistoryEntry[] = [];
  private readonly future: HistoryEntry[] = [];
  private seq = 0;
  /** The `seq` at the top of `past` when the document was last saved; 0 = as loaded. */
  private mark = 0;
  /**
   * The `seq` of the newest command that has fallen out of the ring, 0 if none.
   * Emptying `past` by undoing does *not* return the document to its loaded
   * state once anything has been evicted — those edits are applied and no longer
   * reachable — so the cursor bottoms out here, not at 0.
   */
  private evicted = 0;

  constructor(scene: Scene) {
    this.doc = SceneDoc.clone(scene);
    this.ids = new IdAllocator(this.doc.allIds());
  }

  // -- history --------------------------------------------------------------

  /** Apply one command and push it onto the history (04 §9). */
  apply(cmd: EditorCommand): Touched {
    if (this.mode === 'test') throw new EditRejectedError(cmd.op);
    const touched = applyCommand(this.doc, cmd);
    this.syncIds(cmd, 'forward');
    this.past.push({ seq: ++this.seq, cmd });
    // Ring, not a stack: 200 commands of history, then the oldest falls off and
    // can never be undone to again — including, deliberately, a save mark that
    // has scrolled out (the document then stays dirty, which is the truth).
    while (this.past.length > EDITOR.HISTORY_CAP) this.evicted = (this.past.shift() as HistoryEntry).seq;
    this.future.length = 0;
    return touched;
  }

  get canUndo(): boolean {
    return this.mode === 'edit' && this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.mode === 'edit' && this.future.length > 0;
  }

  /** Undo one command; re-selects the ids it touched (04 §5.3). */
  undo(): Touched | null {
    if (!this.canUndo) return null;
    const entry = this.past.pop() as HistoryEntry;
    const touched = undoCommand(this.doc, entry.cmd);
    this.syncIds(entry.cmd, 'backward');
    this.future.push(entry);
    this.selection = { objects: [...touched.objects], links: [...touched.links] };
    return touched;
  }

  redo(): Touched | null {
    if (!this.canRedo) return null;
    const entry = this.future.pop() as HistoryEntry;
    const touched = applyCommand(this.doc, entry.cmd);
    this.syncIds(entry.cmd, 'forward');
    this.past.push(entry);
    this.selection = { objects: [...touched.objects], links: [...touched.links] };
    return touched;
  }

  /** Commands available to undo — the ring's current depth. */
  get historyDepth(): number {
    return this.past.length;
  }

  /** Label of the command undo would run, for the menu item. */
  undoLabel(): string | null {
    const top = this.past[this.past.length - 1];
    if (!top) return null;
    return top.cmd.op === 'composite' ? top.cmd.label : top.cmd.op;
  }

  // -- dirty tracking (04 §9, §14) ------------------------------------------

  /** Where the history cursor stands: the top of `past`, or the ring's floor. */
  private get cursorSeq(): number {
    return this.past[this.past.length - 1]?.seq ?? this.evicted;
  }

  /** Dirty ⇔ the history cursor is not where it was when we last saved. */
  get dirty(): boolean {
    return this.cursorSeq !== this.mark;
  }

  /** Call after a successful save/export — pins the current point as clean. */
  markSaved(): void {
    this.mark = this.cursorSeq;
  }

  // -- selection (04 §5.3) --------------------------------------------------

  select(sel: Partial<Selection>): void {
    this.selection = { objects: [...(sel.objects ?? [])], links: [...(sel.links ?? [])] };
  }

  toggleSelected(id: Id): void {
    const isLink = this.doc.link(id) !== undefined;
    const current = [...(isLink ? this.selection.links : this.selection.objects)];
    const at = current.indexOf(id);
    if (at >= 0) current.splice(at, 1);
    else current.push(id);
    this.selection = isLink
      ? { objects: [...this.selection.objects], links: current }
      : { objects: current, links: [...this.selection.links] };
  }

  clearSelection(): void {
    this.selection = EMPTY_SELECTION;
  }

  /** Drop ids that no longer exist — after an import or an external reload. */
  pruneSelection(): void {
    this.selection = {
      objects: this.selection.objects.filter((id) => this.doc.object(id) !== undefined),
      links: this.selection.links.filter((id) => this.doc.link(id) !== undefined),
    };
  }

  // -- mode (04 §2, §9) -----------------------------------------------------

  /**
   * Enter/leave test mode. History survives the round trip untouched: leaving
   * test never merges the run's world back into the store (04 §9) — the world
   * is discarded, and the document is exactly what it was at Play.
   */
  setMode(mode: EditorMode): void {
    this.mode = mode;
  }

  // -- snap step (04 §6.1) --------------------------------------------------

  /** `[` and `]` cycle the step through `POS_SNAP_CHOICES_M`, clamped at the ends. */
  cycleSnapStep(direction: -1 | 1): number {
    const choices: readonly number[] = EDITOR.POS_SNAP_CHOICES_M;
    const at = choices.indexOf(this.snapStep);
    const next = Math.max(0, Math.min(choices.length - 1, (at < 0 ? 1 : at) + direction));
    this.snapStep = choices[next] as number;
    return this.snapStep;
  }

  // -- internals ------------------------------------------------------------

  /**
   * Keep the id allocator in step with what exists.
   *
   * Without this an undone add leaves its id reserved, so the next domino is
   * `dom8` when `dom7` is free — a small wrongness that 04 §5.2's "smallest
   * unused positive integer" rules out, and that shows up in every screenshot.
   */
  private syncIds(cmd: EditorCommand, dir: 'forward' | 'backward'): void {
    switch (cmd.op) {
      case 'add': {
        const ids = createdIds(cmd);
        for (const id of ids) (dir === 'forward' ? this.ids.reserve(id) : this.ids.release(id));
        return;
      }
      case 'remove': {
        const ids = [...cmd.objects.map((o) => o.id), ...cmd.links.map((l) => l.id)];
        for (const id of ids) (dir === 'forward' ? this.ids.release(id) : this.ids.reserve(id));
        return;
      }
      case 'rename': {
        const [free, take] = dir === 'forward' ? [cmd.from, cmd.to] : [cmd.to, cmd.from];
        this.ids.release(free);
        this.ids.reserve(take);
        return;
      }
      case 'composite': {
        const children = dir === 'forward' ? cmd.commands : [...cmd.commands].reverse();
        for (const child of children) this.syncIds(child, dir);
        return;
      }
      default:
        return;
    }
  }
}
