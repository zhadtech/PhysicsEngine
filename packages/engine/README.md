# @physics/engine

Deterministic simulation core: the pinned Rapier2D wrapper, Web-Worker host + SAB triple-buffer transport, dmath, the custom force and Gauss-Seidel constraint layers, analytics and snapshot/reset. The same core runs in Node for CI and replay.

- **Contract:** `docs/03-SIMULATION-CORE.md` — the normative spec this package implements.
- **Roadmap phase:** **P2** (`docs/12-ROADMAP.md` §3).

## Status

Skeleton only. P2 is the project keystone: its exit is `determinism-matrix.yml` green with **real** golden hashes across both ISAs and the browser triple, which is where U9/U26 close empirically. `types/protocol.ts` moves in here.

The definition of done for P2 is an **existing** CI gate, not a new criterion
(`docs/12-ROADMAP.md` §5) — implementation wires stubbed steps to real package
output and never redraws the finish line.
