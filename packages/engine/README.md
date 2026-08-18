# @physics/engine

Deterministic simulation core: the pinned Rapier2D wrapper, Web-Worker host + SAB triple-buffer transport, dmath, the custom force and Gauss-Seidel constraint layers, analytics and snapshot/reset. The same core runs in Node for CI and replay.

- **Contract:** `docs/03-SIMULATION-CORE.md` — the normative spec this package implements.
- **Roadmap phase:** **P2** (`docs/12-ROADMAP.md` §3) — the project keystone. **Complete.**

## Status: P2 complete — the keystone is settled

P2 landed in slices (`docs/00-PROGRESS.md` §3b). **P2a** built everything
derivable from a scene document *without* a physics engine — which is where the
determinism risk in our own code lives, since Rapier's WASM is deterministic by
DET-2 and our JavaScript is not deterministic by default. **P2b** turned that
into a world and produced the first real golden hashes. **P2c** put the same
core inside a real Web Worker behind a shared-memory transport and proved the
hashes survive the trip, in all three browser engines.

| Path | What it is |
|---|---|
| `src/sim/dmath.ts` | **DET-5.** `dsin`/`dcos`/`datan2`, built only from operations ECMA-262 pins, because the platform's are not bit-identical across engines. |
| `src/sim/rng.ts` | **DET-6.** The single seeded PCG32, snapshot-able; procgen draws from the same algorithm at P5 (06 PG-2). |
| `src/sim/hash.ts` | **§12.** FNV-1a 32 state hash — the number `determinism-matrix.yml` compares across platforms. |
| `src/sim/canonical.ts` | **DET-3/DET-4.** Id ordering, 4-digit quantization, defaults filled, radians past the load boundary. |
| `src/sim/geometry.ts` | **§6, 02 §6.3.** Prefab shapes, poses and anchors — shared with the renderer, per §5.3. |
| `src/sim/rapier.ts` | **§2, D7.** The exact-pinned physics build, imported in exactly one place. |
| `src/sim/expand.ts` | **§6.** Catalog types → bodies, colliders, joints, motors; the body registry; load warnings. |
| `src/sim/forces.ts` | **§7.** Fan cone, magnet inverse-square, conveyor surface impulses. |
| `src/sim/constraints.ts` | **§8.** The Gauss-Seidel layer: capped motors (§8.3), `gearMesh`, rope-over-pulley. |
| `src/sim/analytics.ts` | **§10.** Activation, the attribution forest, the report leaderboards rank on. |
| `src/sim/snapshot.ts` | **§11.** The `ExtraState` shape — every stateful thing outside Rapier. |
| `src/sim/step.ts` | **§4, §9.** `SimCore`: the pipeline, the lifecycle, `createSimCore()`. |
| `src/transport.ts` | **§5.4, §5.5.** The triple-buffered `SharedArrayBuffer`, its postMessage fallback, and the reader side with the interpolation rules. |
| `src/worker.ts` | **§5.** The Web Worker shell: the §5.1 lifecycle, the §5.2 commands, the §5.5 pacer. Written against an injected `WorkerEnv`, so the state machine is testable with a fake clock. |
| `src/protocol.ts` | The worker contract (moved here from `types/protocol.ts` at P2). Also its own entry point: `@physics/engine/protocol`. |
| `goldens/` | The §12 corpus, its run plan, the committed state hashes, and the cross-engine `dmath` digest. |

`transport.ts` and `worker.ts` are the only two files in the package that know a
browser exists (03 §1 rule 1); `verify-engine` enforces that boundary by
scanning every other file for browser globals.

## The browser leg (P2c) — what "determinism" now means empirically

`tools/golden-browser.mjs` replays the same corpus, with the same run plan,
against the same committed hashes — inside Chromium, Firefox and WebKit. Three
choices make the result mean something:

- **It hashes what came out of the transport, not the world.** The page reads
  the published frame — the four floats per body §5.4 carries — and runs the
  engine's §12 hash over them. A match is therefore evidence about the physics
  *and* the buffer that carries it. The other half of that claim is pinned in
  Node: `test/transport.test.mjs` asserts frame hash === live-body hash across
  the corpus.
- **It drives with `stepN`, never `play`.** `play` advances by wall clock
  (§5.5), so the step count would be a property of the CI runner's load.
- **Both transports run.** The corpus runs cross-origin isolated (the
  `SharedArrayBuffer` path); a second, deliberately un-isolated origin re-runs a
  subset over the postMessage fallback against the same goldens.

The verdict is `tools/golden-compare.mjs`, shared with the Node leg — one rule
for what agreement means, everywhere in the matrix.

```bash
pnpm run golden:browser                                   # the whole triple
node tools/golden-browser.mjs --browser=webkit --scenes=gear-chain
```

The one transformation between the legs is a bundler (esbuild, exact-pinned):
the shared validation gate depends on ajv, which is CommonJS, and module workers
have no import maps. The WASM is unaffected — D7 chose the `-compat` build
precisely so the physics bytes cannot vary with what packs the JS around them —
and the harness asserts the `ready` message reports the same `engineVersion` and
build string the goldens are keyed to.

## The goldens

`goldens/corpus.json` is the run plan — eight scenes, 3 600 steps each, a state
hash every 60. `goldens/state.golden.json` is what those runs produced, keyed to
`engineVersion` *and* the exact physics build. They are separate files on
purpose: `--update` rewrites the outputs, and if the run length lived there too,
shortening a run would look exactly like a hash changing.

```bash
pnpm run golden          # replay the corpus, compare against the committed hashes
pnpm run golden:update   # re-take them — a reviewed act, never a routine one
```

A diff in `state.golden.json` is either a deliberate engine change (which must
carry an `engineVersion` bump, §2) or a determinism incident. Checkpointing every
60 steps rather than only at the end is what makes the second case investigable:
the failure names the step the divergence *began* at.

## Why the motors are ours

`gear.maxTorque` and `piston.force` are user-facing numbers with units, and
`rapier.js` 0.19.3 cannot express them — the motor API is four `configureMotor*`
calls with no maximum-force parameter, at the binding and at the raw WASM
boundary alike, though the Rust `JointMotor` behind them has `max_force`. That is
**U10**, resolved in the negative at P2b, and 03 §14 had already named the
fallback: motors are constraints in our own P4 layer (§8.3), sharing the
accumulate-and-clamp shape of `gearMesh` and the pulley rope.

`verify-engine.mjs` asserts the binding *still* has no force cap, so a future
Rapier bump that adds one surfaces as a failing check rather than as a dead
fallback nobody revisits.

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
pnpm run golden         # the §12 corpus against the committed state hashes
```

The definition of done for P2 was an **existing** CI gate, not a new criterion
(`docs/12-ROADMAP.md` §5): `determinism-matrix.yml` green with **real** golden
hashes across both ISAs and the browser triple. Both legs are wired and green,
so **U9 and U26 are closed empirically**. `verify-engine.mjs` is a check *inside*
`ci.yml`, not a finish line.
