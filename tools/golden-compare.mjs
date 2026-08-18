// golden-compare.mjs — the verdict, shared by both legs of determinism-matrix.
//
// `golden-node.mjs` and `golden-browser.mjs` measure the same corpus in very
// different ways: one drives SimCore directly in a Node process, the other
// drives it over the §5.2 command protocol inside a real browser and hashes
// what comes back out of the §5.4 transport. What they must NOT differ in is
// what counts as agreement — two verdict implementations are two chances to be
// subtly lenient, and the whole point of the matrix is that one number is
// judged by one rule everywhere.
//
// So the measurement is each harness's own business, and everything below the
// measurement lives here.

/** First differing checkpoint — the step a divergence began at. */
export function firstDivergence(got, want) {
  const n = Math.max(got.length, want.length);
  for (let i = 0; i < n; i++) {
    if (got[i] !== want[i]) return { index: i, got: got[i] ?? '(missing)', want: want[i] ?? '(missing)' };
  }
  return null;
}

/**
 * Compare one scene's measurement against its committed golden.
 *
 * Returns a list of `{ ok, msg }` so a caller can print them in its own format;
 * an empty `want` is itself a finding rather than a silent pass.
 */
export function compareScene(got, want) {
  const out = [];
  const A = (ok, msg) => out.push({ ok, msg });
  if (want === undefined) {
    A(false, 'has a committed golden (run `pnpm run golden:update` if the scene is new)');
    return out;
  }
  A(got.bodyCount === want.bodyCount, `body count ${got.bodyCount}`);
  A(JSON.stringify(got.warnings) === JSON.stringify(want.warnings), `load warnings ${JSON.stringify(got.warnings)}`);
  A(got.endStep === want.endStep, `ends at step ${got.endStep}`);
  A(got.finishReason === want.finishReason, `finish reason ${String(got.finishReason)}`);
  const diverged = firstDivergence(got.checkpoints, want.checkpoints);
  A(
    diverged === null,
    diverged === null
      ? `all ${got.checkpoints.length} checkpoint hashes match (final ${got.analytics.finalHash})`
      : `checkpoint ${diverged.index} diverges: got ${diverged.got}, golden ${diverged.want}`,
  );
  for (const [metric, value] of Object.entries(got.analytics)) {
    A(value === want.analytics?.[metric], `analytics.${metric} = ${JSON.stringify(value)}`);
  }
  return out;
}

/**
 * Compare the run plan and the build key. Goldens are only comparable within
 * one engine build (10 §6), and only against the plan they were taken under.
 */
export function compareKey(key, corpus, golden) {
  const out = [];
  const A = (ok, msg) => out.push({ ok, msg });
  A(golden.key?.engineVersion === key.engineVersion, `goldens are keyed to this engineVersion (${golden.key?.engineVersion})`);
  A(golden.key?.physicsBuild === key.physicsBuild, `goldens are keyed to this physics build (${golden.key?.physicsBuild})`);
  A(golden.steps === corpus.steps, `run length matches the corpus plan (${golden.steps} steps)`);
  A(
    golden.checkpointEvery === corpus.checkpointEvery,
    `checkpoint cadence matches the corpus plan (every ${golden.checkpointEvery})`,
  );
  return out;
}
