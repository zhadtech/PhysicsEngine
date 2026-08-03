# @physics/procgen

Seeded procedural machine generation: the stage grammar, serpentine layout CSP, and the verify-by-simulation self-check (gates G1–G6) that reuses the headless SimCore.

- **Contract:** `docs/06-PROCGEN.md` — the normative spec this package implements.
- **Roadmap phase:** **P5** (`docs/12-ROADMAP.md` §3).

## Status

Skeleton only. P5. Depends on a working `@physics/engine` for its self-check; `types/procgen.ts` moves in here.

The definition of done for P5 is an **existing** CI gate, not a new criterion
(`docs/12-ROADMAP.md` §5) — implementation wires stubbed steps to real package
output and never redraws the finish line.
