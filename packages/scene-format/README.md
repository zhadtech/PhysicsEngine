# @physics/scene-format

Scene document schema, TypeScript types, validation gate and schemaVersion migrations — the one definition of a valid scene, imported by client and server alike.

- **Contract:** `docs/02-SCENE-FORMAT.md` — the normative spec this package implements.
- **Roadmap phase:** **P1** (`docs/12-ROADMAP.md` §3) — shipped.

## What is in here

| Path | What it is |
|---|---|
| `scene.schema.json` | The normative JSON Schema (draft 2020-12), one strict variant per object/link type. |
| `src/scene.ts` | The TypeScript mirror: discriminated unions, defaults, limits, classification tables, type guards. |
| `src/validate.ts` | **The gate.** 05 §5.3 steps 3–6, in that order: caps → version/migrate → schema → semantics. |
| `src/semantic.ts` | The 02 §8 rules the schema cannot express (E1–E8, W9–W12). |
| `src/migrate.ts` | The forward-only `schemaVersion` runner and its registry (empty at v1). |
| `src/findings.ts` | The finding vocabulary all of the above speak. |

```ts
import { validateScene } from '@physics/scene-format';

const result = validateScene(doc, { bytes });
if (!result.ok) return reject(result.code, result.findings);
store(result.doc);        // the migrated document (05 §5.3 step 4)
show(result.warnings);    // W-rules: accepted, but surfaced
```

There is one implementation because there must be one verdict: the builder's
validation panel (04 §7), the API write path (05 §5.3), procgen's G1 gate
(06 §8.1) and the AI repair loop (07 §4) all call this function, so the server
can never be more lenient than the client (ADR-0004, ADR-0005).

## Build and test

The package **emits** (`dist/`), unlike the design-phase type files. `ci.yml`'s
`unit` job runs the tests on Node 20 as well as 22, and Node 20 cannot strip
TypeScript — so the suites import emitted JS and need no test-runner
dependency beyond `node:test`. `turbo.json` gives `test` a self-edge on `build`
for the same reason: without it, `pnpm run test` would pass locally against a
stale `dist/` and fail on a fresh clone.

`tsc` emits with `rootDir` at the package root rather than `src/`, so the
normative `scene.schema.json` — which `src/validate.ts` imports — lands beside
the code in `dist/` and the relative specifier resolves identically from source
and from `dist`. The `dist/src/` nesting that produces is invisible to
consumers, who go through the `exports` map.

```bash
pnpm --filter @physics/scene-format build
pnpm --filter @physics/scene-format test
```

## What checks it

- `tools/verify-scene.mjs` — the format corpus (schema compiles ajv-strict, the
  spec's example scenes validate, 15 negatives reject, 3 positive edge cases
  accept) **plus part T**, the three-way tie between the spec prose, the schema
  and `src/scene.ts` (catalogs, size limits, id grammar, anchor tables, entry
  point coverage), with a 7-case mutation battery.
- `test/` — the gate and the migration runner, including a proof that every
  rule declared in `RULES` is produced by at least one corpus document.
- `types/scene.typecheck.ts` — the compile ties across the package boundary:
  findings fit `ApiFinding`, gate codes are a subset of `ApiErrorCode`, and the
  W10 bounds margin equals the engine's DET-10 removal margin.
