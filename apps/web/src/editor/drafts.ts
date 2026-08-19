/**
 * Local drafts — 04 §14.
 *
 * "Autosave: serialized snapshot to IndexedDB every 30 s and on tab blur, ring
 * of 5; on open, a newer local draft than the server copy prompts
 * restore/discard."
 *
 * At P3 there *is* no server copy — the builder ships as a purely local sandbox
 * (12-ROADMAP §3) — so the restore decision is written against an optional
 * remote timestamp that is simply absent until P4 adds save/share. Writing it
 * that way now costs nothing and means P4 supplies a number rather than a
 * mechanism.
 *
 * Storage is an injected interface rather than `indexedDB` directly. Two
 * reasons: the ring's behaviour (eviction order, clock handling, the
 * restore/discard rule) is the part worth testing and it is pure; and 04 §14's
 * "on tab blur" scheduling belongs to the app shell, not to the data structure.
 */

import type { Scene } from '@physics/scene-format';
import { EDITOR } from './model.js';

/** One autosaved revision. `scene` is strict-writer output (02 §2). */
export interface Draft {
  /** Which document this is a draft *of* — the local scene id, or "new". */
  key: string;
  /** Epoch milliseconds. Supplied by the caller so tests own the clock. */
  savedAt: number;
  /** Monotonic within a key, so equal timestamps still order. */
  seq: number;
  scene: Scene;
  title: string;
}

/** The persistence the ring needs — one IndexedDB object store, or a Map. */
export interface DraftStore {
  list(key: string): Promise<Draft[]>;
  put(draft: Draft): Promise<void>;
  delete(key: string, seq: number): Promise<void>;
}

/** In-memory `DraftStore`, for tests and for a browser with storage denied. */
export class MemoryDraftStore implements DraftStore {
  private readonly rows = new Map<string, Draft[]>();

  async list(key: string): Promise<Draft[]> {
    return [...(this.rows.get(key) ?? [])];
  }

  async put(draft: Draft): Promise<void> {
    const rows = this.rows.get(draft.key) ?? [];
    rows.push(draft);
    this.rows.set(draft.key, rows);
  }

  async delete(key: string, seq: number): Promise<void> {
    this.rows.set(key, (this.rows.get(key) ?? []).filter((d) => d.seq !== seq));
  }
}

/**
 * The ring of 5 (04 §14).
 *
 * Eviction is by `seq`, not by timestamp: two autosaves inside the same
 * millisecond are ordinary on a fast machine, and a ring that evicted by a tied
 * clock would drop an arbitrary one of them.
 */
export class DraftRing {
  private seq = 0;

  constructor(
    private readonly store: DraftStore,
    private readonly key: string,
    private readonly capacity: number = EDITOR.AUTOSAVE_RING,
  ) {}

  /** Newest first. */
  async list(): Promise<Draft[]> {
    const rows = await this.store.list(this.key);
    return rows.sort((a, b) => b.seq - a.seq);
  }

  async newest(): Promise<Draft | null> {
    return (await this.list())[0] ?? null;
  }

  /** Write one revision and evict anything past the capacity. */
  async save(scene: Scene, now: number, title = scene.meta?.title ?? 'Untitled'): Promise<Draft> {
    const existing = await this.list();
    this.seq = Math.max(this.seq, existing[0]?.seq ?? 0) + 1;
    const draft: Draft = { key: this.key, savedAt: now, seq: this.seq, scene, title };
    await this.store.put(draft);
    for (const stale of [draft, ...existing].sort((a, b) => b.seq - a.seq).slice(this.capacity)) {
      await this.store.delete(this.key, stale.seq);
    }
    return draft;
  }

  async clear(): Promise<void> {
    for (const d of await this.list()) await this.store.delete(this.key, d.seq);
  }
}

/**
 * Whether opening a document should offer to restore (04 §14).
 *
 * A draft is only worth offering when it is *newer* than the copy being opened.
 * With no remote copy — every scene at P3 — any draft is newer than nothing,
 * which is what makes a crashed tab recoverable in the local sandbox.
 */
export function shouldOfferRestore(draft: Draft | null, remoteSavedAt: number | null): boolean {
  if (!draft) return false;
  return remoteSavedAt === null || draft.savedAt > remoteSavedAt;
}

/** Milliseconds between periodic autosaves (04 §14: 30 s). */
export const AUTOSAVE_INTERVAL_MS = EDITOR.AUTOSAVE_INTERVAL_S * 1000;
