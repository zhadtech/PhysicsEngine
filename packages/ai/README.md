# @physics/ai

Prompt → scene pipeline: the build-time prompt compiler over the 02 tables, the structured-outputs shape rail, and the validation/repair loop that reuses procgen’s check.ts verbatim.

- **Contract:** `docs/07-AI-PIPELINE.md` — the normative spec this package implements.
- **Roadmap phase:** **P6** (`docs/12-ROADMAP.md` §3).

## Status

Skeleton only. P6. Serving lives in `apps/api` `/ai/*` (D15 — provider keys are server-only); `types/ai.ts` moves in here.

The definition of done for P6 is an **existing** CI gate, not a new criterion
(`docs/12-ROADMAP.md` §5) — implementation wires stubbed steps to real package
output and never redraws the finish line.
