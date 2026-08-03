# @physics/web

React builder (place/move/rotate/link, snap, anchors), Three.js InstancedMesh renderer, play-mode UI over the 03 §5 worker protocol, analytics panel, IndexedDB local drafts.

- **Contract:** `docs/04-BUILDER-UX.md` — the normative spec this package implements.
- **Roadmap phase:** **P3** (`docs/12-ROADMAP.md` §3).

## Status

Skeleton only. P3 ships this as a purely local sandbox with no backend at all (Alpha). Save/share is added at P4. `types/editor.ts` and `types/perf.ts` move in here.

The definition of done for P3 is an **existing** CI gate, not a new criterion
(`docs/12-ROADMAP.md` §5) — implementation wires stubbed steps to real package
output and never redraws the finish line.
