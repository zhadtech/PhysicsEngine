/**
 * Forwarding stub — the builder/editor model moved to its app at P3.
 *
 * The source of truth is now `apps/web/src/editor/model.ts`, alongside the
 * store, the command algebra, the snapping system and the strict writer
 * (12-ROADMAP §3 P3).
 *
 * Same arrangement `types/scene.ts` got at P1 and `types/protocol.ts` at P2, and
 * for the same reason: the remaining design-phase type files still import
 * `./editor`, and they migrate into their own packages at their own phases
 * (`api.ts` → `apps/api` at P4, `procgen.ts` → `packages/procgen` at P5, and so
 * on). Rewriting their imports now would point them at a path that moves again
 * next phase; one stub keeps exactly one place to update. It is a pure re-export
 * by design — no declaration may be added here.
 */
export * from '../apps/web/src/editor/model';
