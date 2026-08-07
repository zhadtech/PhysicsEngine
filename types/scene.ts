/**
 * Forwarding stub — the scene format moved to its package at P1.
 *
 * The source of truth is now `packages/scene-format/src/scene.ts`, alongside
 * `packages/scene-format/scene.schema.json`, the migration runner and the shared
 * validation gate (12-ROADMAP §3 P1).
 *
 * This file stays because the other ten design-phase type files still live in
 * `types/` and migrate into their own packages at their own phases
 * (`protocol.ts` → `packages/engine` at P2, `editor.ts` → `apps/web` at P3, and
 * so on). Rewriting their imports now would point them at a path that moves
 * again next phase; one stub keeps exactly one place to update. It is a pure
 * re-export by design — no declaration may be added here.
 */
export * from '../packages/scene-format/src/scene';
