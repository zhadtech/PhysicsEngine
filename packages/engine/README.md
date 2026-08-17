# @physics/engine

Deterministic simulation core: the pinned Rapier2D wrapper, Web-Worker host + SAB triple-buffer transport, dmath, the custom force and Gauss-Seidel constraint layers, analytics and snapshot/reset. The same core runs in Node for CI and replay.

- **Contract:** `docs/03-SIMULATION-CORE.md` — the normative spec this package implements.
- **Roadmap phase:** **P2** (`docs/12-ROADMAP.md` §3) — the project keystone, in progress.

## Status: P2a shipped — the Rapier-free half

P2 is large enough to land in slices (`docs/00-PROGRESS.md` §3b). **P2a** is
everything derivable from a scene document *without* a physics engine — which
is also where the determinism risk in our own code lives, since Rapier's WASM is
deterministic by DET-2 and our JavaScript is not deterministic by default.

| Path | What it is |
|---|---|
| `src/sim/dmath.ts` | **DET-5.** `dsin`/`dcos`/`datan2`, built only from operations ECMA-262 pins, because the platform's are not bit-identical across engines. |
| `src/sim/rng.ts` | **DET-6.** The single seeded PCG32, snapshot-able; procgen draws from the same algorithm at P5 (06 PG-2). |
| `src/sim/hash.ts` | **§12.** FNV-1a 32 state hash — the number `determinism-matrix.yml` compares across platforms. |
| `src/sim/canonical.ts` | **DET-3/DET-4.** Id ordering, 4-digit quantization, defaults filled, radians past the load boundary. |
| `src/sim/geometry.ts` | **§6, 02 §6.3.** Prefab shapes, poses and anchors — shared with the renderer, per §5.3. |
| `src/protocol.ts` | The worker contract (moved here from `types/protocol.ts` at P2). Also its own entry point: `@physics/engine/protocol`. |
| `goldens/dmath.golden.json` | The committed cross-engine digest and its spot values. |

**Still to come:** the Rapier world and §6 joints, the §4 step pipeline, the §7
force layer, the §8 custom constraints, §10 analytics, §11 snapshot/reset (P2b);
the worker shell and SAB transport, and the browser triple (P2c).

## Why this package computes its own sine

DET-5 asserts that JavaScript's `Math.sin`/`cos`/`atan2` cannot be trusted to
agree across engines. P2a measured it rather than citing it. Over 20 000 samples
across this engine's angle domain, V8 (Node 24) and JavaScriptCore (the WebKit
leg of the browser triple) disagree in the last bit on **4.62 %** of `sin`
samples, **4.58 %** of `cos`, and **16.71 %** of `atan2`; `sqrt`, `*` and `+`
agree exactly, as specified.

One ULP is not a rounding detail in a physics engine. It is a different run: the
golden hash is over quantized positions, so two platforms fork the moment the
difference reaches 0.1 mm, which takes a few hundred steps. That failure would
have surfaced as a red `webkit` leg at the P2 exit gate with no other symptom.

`dmath` — an fdlibm port using only the pinned operations — produces digest
`d859ce99` on **both** engines. `tools/verify-engine.mjs` re-runs that probe
under whichever engines the host has and holds them to the committed golden.

## Build & test

Emits to `dist/` and tests the emitted JS with `node:test` (**D30**): `ci.yml`'s
`unit` job spans Node 20, which cannot strip TypeScript. `rootDir` is the package
root so `goldens/` keeps one relative path valid from both `src/` and `dist/`.

```bash
pnpm run build          # tsc -> dist/
pnpm run test           # node --test over dist/
pnpm run verify:engine  # the discipline lint + cross-engine goldens + 03 correspondence
```

The definition of done for P2 is an **existing** CI gate, not a new criterion
(`docs/12-ROADMAP.md` §5): `determinism-matrix.yml` green with **real** golden
hashes across both ISAs and the browser triple, which is where U9/U26 close
empirically. `verify-engine.mjs` is a check *inside* `ci.yml`, not a finish line.
