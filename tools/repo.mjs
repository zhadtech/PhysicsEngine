// Repo-root anchoring for the verify suites (P0).
//
// Before P0 each verify*.mjs read its inputs from `./` and was run by copying
// the files it needed into a scratch directory (types/ flattened, docs beside
// it). That convention could not survive the monorepo layout — and it is why
// the shipped ci.yml `verify-backend` job would have failed on a fresh clone:
// it ran `node verify-backend.mjs` at the repo root, where `./api.ts` does not
// exist. Paths are now resolved from the repo root regardless of cwd, so the
// suites run in place (`pnpm verify`) and in CI identically.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/** Repo root — this file lives in <root>/tools/. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Absolute path for a repo-relative path. */
export const repoPath = (...parts) => join(ROOT, ...parts);

/** Read a repo-relative text file, with an actionable error if it moved. */
export function readRepo(rel) {
  try {
    return readFileSync(repoPath(rel), 'utf8');
  } catch {
    console.error(`missing ${rel} (looked in ${ROOT}) — has it moved? update tools/repo.mjs callers`);
    process.exit(2);
  }
}

/** Read + parse a repo-relative JSON file. */
export const readRepoJson = (rel) => JSON.parse(readRepo(rel));
