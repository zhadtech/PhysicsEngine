/**
 * Forwarding stub — the worker protocol moved to its package at P2.
 *
 * The source of truth is now `packages/engine/src/protocol.ts`, alongside the
 * deterministic math, the canonicalizer and the shared geometry module
 * (12-ROADMAP §3 P2).
 *
 * Same arrangement `types/scene.ts` got at P1, and for the same reason: the
 * remaining design-phase type files still import `./protocol`, and they migrate
 * into their own packages at their own phases (`editor.ts` → `apps/web` at P3,
 * `api.ts` → `apps/api` at P4, and so on). Rewriting their imports now would
 * point them at a path that moves again next phase; one stub keeps exactly one
 * place to update. It is a pure re-export by design — no declaration may be
 * added here.
 */
export * from '../packages/engine/src/protocol';
