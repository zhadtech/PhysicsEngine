// M4+M6+M7 verification (05-BACKEND.md §10, 07-AI-PIPELINE.md §10,
// 08-COMMUNITY.md §10): OpenAPI validity, real-PG-grammar DDL, and
// cross-artifact consistency. Run from anywhere: `pnpm verify:backend`
// (repo-root anchored since P0 — no more flattening types/ into a scratch dir).
import { readRepo, readRepoJson } from './repo.mjs';
import { parse as parseYaml } from 'yaml';
import { Validator } from '@seriousme/openapi-schema-validator';
import { parse as parsePgSql } from 'pgsql-parser';
import Ajv2020 from 'ajv/dist/2020.js';

let failures = 0;
const fail = (msg) => {
  console.log(`FAIL: ${msg}`);
  failures++;
};
const ok = (msg) => console.log(`ok: ${msg}`);
const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const diff = (a, b) => [...a].filter((x) => !b.has(x));

const yamlText = readRepo('openapi.yaml');
const sql = readRepo('schema.sql');
const apiTs = readRepo('types/api.ts');
const sceneTs = readRepo('types/scene.ts');
const aiTs = readRepo('types/ai.ts');
const communityTs = readRepo('types/community.ts');
const protocolTs = readRepo('types/protocol.ts');
const doc05 = readRepo('docs/05-BACKEND.md');
const doc08 = readRepo('docs/08-COMMUNITY.md');
const sceneSchema = readRepoJson('scene.schema.json');

// --- 1. OpenAPI 3.1 meta-schema validity -----------------------------------
const spec = parseYaml(yamlText);
const validator = new Validator();
const vres = await validator.validate(spec);
if (!vres.valid) {
  fail('openapi.yaml invalid against the OpenAPI 3.1 meta-schema:');
  console.log(JSON.stringify(vres.errors, null, 2).slice(0, 4000));
} else {
  ok(`openapi.yaml valid (OpenAPI ${spec.openapi})`);
}

// --- 2. Structural rules over every operation ------------------------------
const resolveRef = (ref) =>
  ref
    .replace(/^#\//, '')
    .split('/')
    .reduce((node, key) => node?.[key], spec);

const METHODS = ['get', 'post', 'put', 'delete', 'patch'];
const specOps = new Map(); // operationId -> { method, path }
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;
    const label = `${method.toUpperCase()} ${path}`;
    if (!op.operationId) fail(`${label}: missing operationId`);
    if (!op.tags?.length) fail(`${label}: missing tags`);
    if (!op.summary) fail(`${label}: missing summary`);
    if (op.operationId) {
      if (specOps.has(op.operationId)) fail(`duplicate operationId ${op.operationId}`);
      specOps.set(op.operationId, { method: method.toUpperCase(), path });
    }
    // every {param} in the path is declared as an in:path parameter
    const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) =>
      p.$ref ? resolveRef(p.$ref) : p,
    );
    const declared = params.filter((p) => p.in === 'path').map((p) => p.name);
    for (const [, name] of path.matchAll(/\{(\w+)\}/g)) {
      if (!declared.includes(name)) fail(`${label}: path param {${name}} not declared`);
    }
    // every >= 400 response is the shared error envelope
    for (const [status, resp] of Object.entries(op.responses ?? {})) {
      if (!/^\d+$/.test(status) || Number(status) < 400) continue;
      const r = resp.$ref ? resolveRef(resp.$ref) : resp;
      const schema = r?.content?.['application/json']?.schema;
      if (schema?.$ref !== '#/components/schemas/ErrorEnvelope') {
        fail(`${op.operationId} ${status}: error response is not the shared ErrorEnvelope`);
      }
    }
  }
}
ok(`spec structure: ${specOps.size} operations, all with operationId/tags/summary, enveloped errors, declared path params`);

// --- 3. ROUTES (api.ts) === spec operations --------------------------------
const routesBlock = apiTs.match(/export const ROUTES[^=]*=\s*\{([\s\S]*?)\n\} as const;/)?.[1];
if (!routesBlock) fail('could not extract ROUTES block from api.ts');
const routes = new Map(
  [...(routesBlock ?? '').matchAll(
    /(\w+):\s*\{\s*method:\s*'(GET|POST|PUT|DELETE)',\s*path:\s*'([^']+)',\s*auth:\s*'(none|session|owner|verified)'\s*\}/g,
  )].map((m) => [m[1], { method: m[2], path: m[3], auth: m[4] }]),
);
if (routes.size === 0) fail('ROUTES regex matched nothing — file format drifted');
const routeIds = new Set(routes.keys());
const specIds = new Set(specOps.keys());
if (!setEq(routeIds, specIds)) {
  fail(`ROUTES ≠ spec operations. only in api.ts: [${diff(routeIds, specIds)}], only in spec: [${diff(specIds, routeIds)}]`);
} else {
  for (const [id, r] of routes) {
    const s = specOps.get(id);
    if (s.method !== r.method || s.path !== r.path) {
      fail(`${id}: api.ts says ${r.method} ${r.path}, spec says ${s.method} ${s.path}`);
    }
  }
  ok(`ROUTES === spec: ${routes.size} operations agree (id, method, path)`);
}

// --- 3b. M6 AI operations: SSE responses + budget arithmetic (07 §10) ------
for (const opId of ['aiGenerate', 'aiRepair']) {
  const loc = specOps.get(opId);
  if (!loc) {
    fail(`AI operation ${opId} missing from the spec`);
    continue;
  }
  const op = spec.paths[loc.path][loc.method.toLowerCase()];
  const media = Object.keys(op.responses?.['200']?.content ?? {});
  if (!media.includes('text/event-stream')) {
    fail(`${opId}: 200 must be text/event-stream (07 §2.3), got [${media}]`);
  } else {
    ok(`${opId}: 200 streams text/event-stream`);
  }
}
const repairRounds = Number(aiTs.match(/REPAIR_ROUNDS_MAX:\s*(\d+)/)?.[1]);
const aiCallsDay = Number(apiTs.match(/aiCallsDay:\s*\{\s*per:\s*'user',\s*limit:\s*(\d+)/)?.[1]);
if (!repairRounds || !aiCallsDay) {
  fail(`could not extract AI budget constants (REPAIR_ROUNDS_MAX=${repairRounds}, aiCallsDay=${aiCallsDay})`);
} else if (aiCallsDay < 1 + repairRounds) {
  fail(`aiCallsDay (${aiCallsDay}) < 1 + REPAIR_ROUNDS_MAX (${repairRounds}) — one full generation cannot fit the daily budget`);
} else {
  ok(`AI budget arithmetic: aiCallsDay ${aiCallsDay} ≥ 1 + REPAIR_ROUNDS_MAX ${repairRounds}`);
}

// --- 4. Error codes: api.ts union ↔ YAML enum ↔ 05 table (+ statuses) ------
const unionBlock = apiTs.match(/export type ApiErrorCode =([\s\S]*?);/)?.[1] ?? '';
const apiCodes = new Set([...unionBlock.matchAll(/'(E_[A-Z_]+)'/g)].map((m) => m[1]));
const yamlCodes = new Set(
  spec.components?.schemas?.ErrorEnvelope?.properties?.error?.properties?.code?.enum ?? [],
);
const docRows = [...doc05.matchAll(/^\| `(E_[A-Z_]+)` \| (\d{3}) \|/gm)];
const docCodes = new Set(docRows.map((m) => m[1]));
const docStatus = new Map(docRows.map((m) => [m[1], m[2]]));
if (!setEq(apiCodes, yamlCodes))
  fail(`code sets differ api.ts vs yaml: [${diff(apiCodes, yamlCodes)}] / [${diff(yamlCodes, apiCodes)}]`);
if (!setEq(apiCodes, docCodes))
  fail(`code sets differ api.ts vs 05-BACKEND.md: [${diff(apiCodes, docCodes)}] / [${diff(docCodes, apiCodes)}]`);
const statusBlock = apiTs.match(/export const ERROR_STATUS[^=]*=\s*\{([\s\S]*?)\n\} as const;/)?.[1] ?? '';
const apiStatus = new Map([...statusBlock.matchAll(/(E_[A-Z_]+):\s*(\d{3}),/g)].map((m) => [m[1], m[2]]));
if (!setEq(new Set(apiStatus.keys()), apiCodes)) fail('ERROR_STATUS keys ≠ ApiErrorCode union');
for (const [code, st] of apiStatus) {
  if (docStatus.get(code) !== st) fail(`${code}: api.ts status ${st} ≠ doc status ${docStatus.get(code)}`);
}
if (apiCodes.size > 0 && setEq(apiCodes, yamlCodes) && setEq(apiCodes, docCodes)) {
  ok(`error codes: ${apiCodes.size} codes identical in api.ts, openapi.yaml, 05-BACKEND.md (statuses agree)`);
}

// --- 5. Every example scene doc in the spec validates against the format ---
const ajv = new Ajv2020.default({ strict: true, allErrors: true });
const validateScene = ajv.compile(sceneSchema);
const exampleDocs = [];
(function walk(node, at) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${at}[${i}]`));
    return;
  }
  if (typeof node.schemaVersion === 'number' && Array.isArray(node.objects)) {
    exampleDocs.push([at, node]);
    return;
  }
  for (const [k, v] of Object.entries(node)) walk(v, `${at}.${k}`);
})(spec, '$');
if (exampleDocs.length < 2) fail(`expected ≥ 2 example scene docs in openapi.yaml, found ${exampleDocs.length}`);
for (const [at, doc] of exampleDocs) {
  if (!validateScene(doc)) {
    fail(`example scene at ${at} ("${doc.meta?.title}") fails scene.schema.json:`);
    console.log(JSON.stringify(validateScene.errors, null, 2).slice(0, 2000));
  }
}
if (exampleDocs.every(([, d]) => validateScene(d))) {
  ok(`example scene docs: ${exampleDocs.length} embedded examples validate against scene.schema.json`);
}

// --- 6. schema.sql: real PostgreSQL grammar + cross-checks -----------------
try {
  const parsed = await parsePgSql(sql);
  const n = parsed.stmts?.length ?? parsed.length;
  if (!n || n < 30) fail(`schema.sql parsed but only ${n} statements — expected a full schema`);
  else ok(`schema.sql parses under the real PostgreSQL grammar (${n} statements, parser v${parsed.version ?? '?'})`);
} catch (e) {
  fail(`schema.sql rejected by the PostgreSQL parser: ${e.message}`);
}

const sqlTables = new Set([...sql.matchAll(/^CREATE TABLE (\w+)/gm)].map((m) => m[1]));
const docTables = new Set([...doc05.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]));
// M7 tables are declared in 08 §8.1, inside an explicitly marked inventory
// block (the marker keeps other 08 tables — buckets, jobs — out of the set).
const inv08 = doc08.split('<!-- table-inventory -->')[1]?.split('\n##')[0] ?? '';
const docTables08 = new Set([...inv08.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]));
if (docTables08.size === 0) fail('08-COMMUNITY.md has no marked table-inventory block');
const declaredTables = new Set([...docTables, ...docTables08]);
if (!setEq(sqlTables, declaredTables)) {
  fail(
    `table inventory differs. only in schema.sql: [${diff(sqlTables, declaredTables)}], ` +
      `only in the docs (05 §3 ∪ 08 §8.1): [${diff(declaredTables, sqlTables)}]`,
  );
} else {
  ok(
    `table inventory: ${sqlTables.size} tables agree between schema.sql and the docs ` +
      `(${docTables.size} in 05 §3, ${docTables08.size} in 08 §8.1)`,
  );
}

const num = (s) => Number(String(s).replace(/_/g, ''));
const sqlCap = sql.match(/CHECK \(size_bytes BETWEEN 1 AND (\d+)\)/)?.[1];
const tsCap = sceneTs.match(/maxJsonBytes:\s*([\d_]+)/)?.[1];
if (!sqlCap || !tsCap || num(sqlCap) !== num(tsCap)) {
  fail(`revision size cap mismatch: schema.sql ${sqlCap} vs LIMITS.maxJsonBytes ${tsCap}`);
} else {
  ok(`revision size CHECK (${num(sqlCap)}) === LIMITS.maxJsonBytes`);
}
const bodyCap = apiTs.match(/JSON_BODY_CAP_BYTES:\s*([\d_]+)/)?.[1];
if (!bodyCap || num(bodyCap) <= num(tsCap)) {
  fail(`JSON_BODY_CAP_BYTES (${bodyCap}) must exceed the 1 MB document cap (05 §5.3)`);
} else {
  ok(`transport cap ${num(bodyCap)} > document cap ${num(tsCap)}`);
}

const sqlSceneId = sql.match(/CHECK \(id ~ '([^']+)'\)/)?.[1];
const apiSceneId = apiTs.match(/SCENE_ID_PATTERN:\s*\/(.+?)\//)?.[1];
if (sqlSceneId !== apiSceneId) fail(`scene id pattern: schema.sql '${sqlSceneId}' ≠ api.ts '${apiSceneId}'`);
else ok(`scene id pattern identical in DDL and api.ts (${sqlSceneId})`);

const sqlHandle = sql.match(/CHECK \(handle::text ~ '([^']+)'\)/)?.[1];
const apiHandle = apiTs.match(/HANDLE_PATTERN:\s*\/(.+?)\//)?.[1];
if (sqlHandle !== apiHandle) fail(`handle pattern: schema.sql '${sqlHandle}' ≠ api.ts '${apiHandle}'`);
else ok(`handle pattern identical in DDL and api.ts (${sqlHandle})`);

// --- 7. M7: community vocabularies, budgets, and DDL ties (08 §10) ---------

/** Labels of a Postgres ENUM type declared in schema.sql. */
const sqlEnum = (name) => {
  const body = sql.match(new RegExp(`CREATE TYPE ${name} AS ENUM \\(([^)]*)\\)`))?.[1];
  return new Set(body ? [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]) : []);
};
/** String literals of an `export const X = [...] as const;` array in a .ts file. */
const tsConstArray = (src, name) => {
  const body = src.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`))?.[1];
  return new Set(body ? [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]) : []);
};
const schemaEnum = (schemaName, prop) =>
  new Set(spec.components?.schemas?.[schemaName]?.properties?.[prop]?.enum ?? []);

// 7a. Enum sets that exist in three places at once: DDL, TypeScript, OpenAPI.
const threeWay = [
  ['verification state', sqlEnum('verification_state_t'), tsConstArray(communityTs, 'VERIFICATION_STATES'), schemaEnum('Verification', 'state')],
  ['challenge state', sqlEnum('challenge_state_t'), tsConstArray(communityTs, 'CHALLENGE_STATES'), schemaEnum('Challenge', 'state')],
  ['report reason', sqlEnum('report_reason_t'), tsConstArray(communityTs, 'REPORT_REASONS'), schemaEnum('CreateReportRequest', 'reason')],
];
for (const [label, a, b, c] of threeWay) {
  if (a.size === 0 || b.size === 0 || c.size === 0) {
    fail(`${label}: could not extract one of the three sets (sql ${a.size}, ts ${b.size}, yaml ${c.size})`);
  } else if (!setEq(a, b) || !setEq(a, c)) {
    fail(
      `${label} labels differ — sql vs ts: [${diff(a, b)}]/[${diff(b, a)}], sql vs yaml: [${diff(a, c)}]/[${diff(c, a)}]`,
    );
  } else {
    ok(`${label}: ${a.size} labels identical in schema.sql, types/community.ts, openapi.yaml`);
  }
}

// moderation_state_t has no OpenAPI surface (it is never returned verbatim).
const modSql = sqlEnum('moderation_state_t');
const modTs = tsConstArray(communityTs, 'MODERATION_STATES');
if (!setEq(modSql, modTs) || modSql.size === 0)
  fail(`moderation states differ: sql [${[...modSql]}] vs ts [${[...modTs]}]`);
else ok(`moderation states: ${modSql.size} labels agree (schema.sql ↔ types/community.ts)`);

// 7b. Ranking metrics: DDL enum ↔ CHALLENGE_METRICS keys ↔ YAML enum. Every one
// is compile-proved in community.ts to be a numeric AnalyticsReport field, and
// that field must still exist in protocol.ts — the whole D17 argument.
const metricsBlock = communityTs.match(/export const CHALLENGE_METRICS[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? '';
const tsMetrics = new Set([...metricsBlock.matchAll(/^\s{2}(\w+):\s*\{/gm)].map((m) => m[1]));
const sqlMetrics = sqlEnum('challenge_metric_t');
const yamlMetrics = schemaEnum('Challenge', 'metric');
if (tsMetrics.size === 0) fail('could not extract CHALLENGE_METRICS keys');
else if (!setEq(tsMetrics, sqlMetrics) || !setEq(tsMetrics, yamlMetrics)) {
  fail(
    `challenge metrics differ — ts vs sql: [${diff(tsMetrics, sqlMetrics)}]/[${diff(sqlMetrics, tsMetrics)}], ` +
      `ts vs yaml: [${diff(tsMetrics, yamlMetrics)}]/[${diff(yamlMetrics, tsMetrics)}]`,
  );
} else {
  const analyticsBlock = protocolTs.match(/export interface AnalyticsReport \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const missing = [...tsMetrics].filter((m) => !new RegExp(`\\n  ${m}\\??:\\s*number`).test(analyticsBlock));
  if (missing.length) fail(`ranking metrics absent from AnalyticsReport (03 §10): [${missing}]`);
  else ok(`challenge metrics: ${tsMetrics.size} agree across DDL/TS/YAML and all are AnalyticsReport numbers`);
}

// 7c. Challenge rule vocabulary: union ↔ source table ↔ YAML enum.
const ruleUnion = new Set(
  [...(communityTs.match(/export type ChallengeRule =([\s\S]*?);\n/)?.[1] ?? '').matchAll(/kind: '(\w+)'/g)].map(
    (m) => m[1],
  ),
);
const ruleSource = new Set(
  [
    ...(communityTs.match(/export const CHALLENGE_RULE_SOURCE[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? '').matchAll(
      /(\w+):\s*'(?:doc|verified)'/g,
    ),
  ].map((m) => m[1]),
);
const yamlRules = schemaEnum('ChallengeRule', 'kind');
if (ruleUnion.size === 0) fail('could not extract the ChallengeRule union');
else if (!setEq(ruleUnion, ruleSource) || !setEq(ruleUnion, yamlRules)) {
  fail(
    `challenge rule kinds differ — union vs source table: [${diff(ruleUnion, ruleSource)}]/[${diff(ruleSource, ruleUnion)}], ` +
      `union vs yaml: [${diff(ruleUnion, yamlRules)}]/[${diff(yamlRules, ruleUnion)}]`,
  );
} else {
  ok(`challenge rules: ${ruleUnion.size} kinds agree (union, CHALLENGE_RULE_SOURCE, openapi.yaml)`);
}

// 7d. Explore sort enum: types/community.ts ↔ the spec's query parameter.
const tsSorts = tsConstArray(communityTs, 'EXPLORE_SORTS');
const sortParam = (spec.paths?.['/explore']?.get?.parameters ?? []).find((p) => p.name === 'sort');
const yamlSorts = new Set(sortParam?.schema?.enum ?? []);
if (!setEq(tsSorts, yamlSorts) || tsSorts.size === 0)
  fail(`explore sorts differ: ts [${[...tsSorts]}] vs yaml [${[...yamlSorts]}]`);
else ok(`explore sorts: ${tsSorts.size} modes agree (EXPLORE_SORTS ↔ openapi.yaml)`);

// 7e. Numbers that exist twice: DDL CHECKs vs the constants they mirror.
const numTie = (label, a, b) => {
  if (a === undefined || b === undefined || Number(a) !== Number(b)) fail(`${label}: ${a} ≠ ${b}`);
  else ok(`${label}: ${Number(a)} agrees`);
};
numTie(
  'comment length CHECK === SOCIAL.COMMENT_MAX_CHARS',
  sql.match(/CHECK \(char_length\(body\) BETWEEN 1 AND (\d+)\)/)?.[1],
  communityTs.match(/COMMENT_MAX_CHARS:\s*([\d_]+)/)?.[1]?.replace(/_/g, ''),
);
numTie(
  'challenge rules cardinality CHECK === CHALLENGE.MAX_RULES',
  sql.match(/jsonb_array_length\(rules\) <= (\d+)/)?.[1],
  communityTs.match(/MAX_RULES:\s*(\d+)/)?.[1],
);
numTie(
  'report bucket === MODERATION.MAX_REPORTS_PER_DAY',
  apiTs.match(/report:\s*\{\s*per:\s*'user',\s*limit:\s*(\d+)/)?.[1],
  communityTs.match(/MAX_REPORTS_PER_DAY:\s*(\d+)/)?.[1],
);
const sqlSlug = sql.match(/CHECK \(slug::text ~ '([^']+)'\)/)?.[1];
const tsSlug = communityTs.match(/SLUG_PATTERN:\s*\/(.+?)\//)?.[1];
const yamlSlug = spec.components?.parameters?.ChallengeSlug?.schema?.pattern;
if (sqlSlug !== tsSlug || sqlSlug !== yamlSlug)
  fail(`challenge slug pattern: sql '${sqlSlug}' / ts '${tsSlug}' / yaml '${yamlSlug}'`);
else ok(`challenge slug pattern identical in DDL, types/community.ts, openapi.yaml (${sqlSlug})`);

// 7f. Verification budget vs the engine's own caps (08 §5.5): the verifier must
// be able to finish any scene a player can, and must stay under the body cap.
const hardCapS = Number(protocolTs.match(/HARD_CAP_S:\s*(\d+)/)?.[1]);
const maxBodies = Number(protocolTs.match(/MAX_DYNAMIC_BODIES:\s*([\d_]+)/)?.[1]?.replace(/_/g, ''));
const stepBudgetExpr = communityTs.match(/STEP_BUDGET:\s*SIM\.HARD_CAP_S \* 60/);
const bodyBudget = Number(communityTs.match(/BODY_BUDGET:\s*([\d_]+)/)?.[1]?.replace(/_/g, ''));
if (!hardCapS || !maxBodies) fail('could not extract engine caps from protocol.ts');
else if (!stepBudgetExpr)
  fail('VERIFY.STEP_BUDGET must be expressed as SIM.HARD_CAP_S * 60 — verification may never be shorter than a legal run');
else if (!(bodyBudget > 0 && bodyBudget <= maxBodies))
  fail(`VERIFY.BODY_BUDGET (${bodyBudget}) must be in (0, SIM.MAX_DYNAMIC_BODIES=${maxBodies}]`);
else
  ok(
    `verification budget: STEP_BUDGET = HARD_CAP_S(${hardCapS}) × 60 = ${hardCapS * 60} steps, ` +
      `BODY_BUDGET ${bodyBudget} ≤ MAX_DYNAMIC_BODIES ${maxBodies}`,
  );

// 7g. Every M7 write bucket exists in RATE_LIMITS and is documented in 08.
const bucketsBlock = apiTs.match(/export const RATE_LIMITS[^=]*=\s*\{([\s\S]*?)\n\} as const;/)?.[1] ?? '';
const buckets = new Map(
  [...bucketsBlock.matchAll(/(\w+):\s*\{\s*per:\s*'(ip|account|user)',\s*limit:\s*(\d+)/g)].map((m) => [
    m[1],
    Number(m[3]),
  ]),
);
for (const name of ['like', 'comment', 'follow', 'challengeEntry', 'report', 'runReport']) {
  if (!buckets.has(name) || !(buckets.get(name) > 0)) fail(`rate bucket ${name} missing or zero in RATE_LIMITS`);
  else if (!doc08.includes(name)) fail(`rate bucket ${name} is not documented in 08-COMMUNITY.md`);
}
ok(`M7 rate buckets: 6 social/challenge/report buckets present, non-zero, and documented in 08`);

// 7h. The M7 operation set actually exists (a dropped route would otherwise only
// show up as a ROUTES/spec mismatch, which is a less legible message).
const m7Ops = [
  'likeScene', 'unlikeScene', 'listComments', 'createComment', 'deleteComment',
  'followUser', 'unfollowUser', 'listFollowers', 'listFollowing', 'getRemixTree',
  'getSceneVerification', 'reportRun', 'listChallenges', 'getChallenge',
  'getLeaderboard', 'enterChallenge', 'withdrawEntry', 'reportContent',
];
const missingOps = m7Ops.filter((id) => !specOps.has(id));
if (missingOps.length) fail(`M7 operations missing from openapi.yaml: [${missingOps}]`);
else ok(`M7 surface: ${m7Ops.length} community operations present (total ${specOps.size})`);

// --- summary ---------------------------------------------------------------
console.log(
  failures === 0
    ? '\nALL BACKEND CHECKS PASSED'
    : `\n${failures} CHECK(S) FAILED`,
);
if (failures > 0) process.exitCode = 1;
