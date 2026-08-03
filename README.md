# Physics Sandbox Platform

A deterministic 2.5D physics sandbox: build Rube-Goldberg machines from a prefab
catalog, hit Play, and get the *same* simulation on every machine — which is what
makes shareable scenes, procedural generation, AI generation and verified
leaderboards possible at all.

> **Working title.** Naming is a later decision.

## Start here

| If you want to… | Read |
|---|---|
| know the current state of the project | **[`docs/00-PROGRESS.md`](docs/00-PROGRESS.md)** — the single source of truth |
| know what is being built and why | [`docs/01-ARCHITECTURE.md`](docs/01-ARCHITECTURE.md), [`docs/adr/`](docs/adr) |
| know what is built next | [`docs/12-ROADMAP.md`](docs/12-ROADMAP.md) — build phases P0–P8 |
| understand the scene file format | [`docs/02-SCENE-FORMAT.md`](docs/02-SCENE-FORMAT.md) + [`scene.schema.json`](scene.schema.json) |

The design phase (M0–M11) is complete: eleven normative specs, machine-checked
where checkable. Implementation follows the roadmap's phases; **P0 (repo
bring-up) is done** and P1 (`packages/scene-format`) is next.

## Layout

```
docs/            the eleven specs, the brief, the tracker, adr/
packages/        scene-format (P1) · engine (P2) · procgen (P5) · ai (P6) · shared
apps/            web (P3) · api (P4)
tools/           the verify-*.mjs suites that gate every merge
types/           design-phase TypeScript surface, compile-tied to the specs
                 (each file migrates into its owning package as its phase lands)
scene.schema.json · openapi.yaml · schema.sql   contract artefacts, likewise
```

Each package's `README.md` names the spec it implements and the phase that fills
it in. Package skeletons are deliberately empty — a package gains code only when
its phase starts.

## Working on it

Requires Node ≥ 20 and [pnpm](https://pnpm.io) (`corepack enable`).

```bash
pnpm install
```

```bash
pnpm run ci
```

`pnpm run ci` is what `.github/workflows/ci.yml` runs: a strict typecheck plus
the five verify suites. They are fast, hermetic and need no services.

| Command | Checks |
|---|---|
| `pnpm run typecheck` | `tsc` strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) over the type surface and every package |
| `pnpm run verify:workspace` | the monorepo skeleton matches the canonical layout and the roadmap's phase table; `.env.example` matches the secrets inventory |
| `pnpm run verify:scene` | `scene.schema.json` compiles ajv-strict; the spec's examples validate; 15 negative cases reject |
| `pnpm run verify:backend` | `openapi.yaml` ↔ `types/api.ts` ↔ `schema.sql` ↔ the scene schema agree; the DDL parses under the real PostgreSQL grammar |
| `pnpm run verify:infra` | CI workflow structure, the three-way-pinned U9 determinism matrix, the migration runner, the isolation predicate |
| `pnpm run verify:roadmap` | every open question is disposed, every brief deliverable traced, the phase order topologically valid |

The heavier cross-platform golden-hash gate lives in
`.github/workflows/determinism-matrix.yml` and becomes real at P2.

## Configuration

Configuration is environment variables only (12-factor), so the same image
promotes dev → staging → prod. Copy [`.env.example`](.env.example) to `.env`;
every secret it names is server-only and no value is ever committed.
