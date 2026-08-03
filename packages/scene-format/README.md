# @physics/scene-format

Scene document schema, TypeScript types, validation gate and schemaVersion migrations — the one definition of a valid scene, imported by client and server alike.

- **Contract:** `docs/02-SCENE-FORMAT.md` — the normative spec this package implements.
- **Roadmap phase:** **P1** (`docs/12-ROADMAP.md` §3).

## Status

Skeleton only. P1 moves `scene.schema.json` + `types/scene.ts` in here and adds the migration runner (10 §5.2). No design work remains — P1 is packaging.

The definition of done for P1 is an **existing** CI gate, not a new criterion
(`docs/12-ROADMAP.md` §5) — implementation wires stubbed steps to real package
output and never redraws the finish line.
