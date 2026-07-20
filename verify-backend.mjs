// M4+M6 verification (05-BACKEND.md §10, 07-AI-PIPELINE.md §10): OpenAPI
// validity, real-PG-grammar DDL, and cross-artifact consistency. Run like
// verify.mjs: copy these files into a scratch dir — openapi.yaml, schema.sql,
// scene.schema.json, 05-BACKEND.md, and (flattened from types/) api.ts,
// scene.ts, ai.ts — then:
//   npm i ajv yaml @seriousme/openapi-schema-validator pgsql-parser
//   node verify-backend.mjs
import { readFileSync } from 'node:fs';
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

const yamlText = readFileSync('./openapi.yaml', 'utf8');
const sql = readFileSync('./schema.sql', 'utf8');
const apiTs = readFileSync('./api.ts', 'utf8');
const sceneTs = readFileSync('./scene.ts', 'utf8');
const aiTs = readFileSync('./ai.ts', 'utf8');
const doc05 = readFileSync('./05-BACKEND.md', 'utf8');
const sceneSchema = JSON.parse(readFileSync('./scene.schema.json', 'utf8'));

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
if (!setEq(sqlTables, docTables)) {
  fail(`table inventory differs. only in schema.sql: [${diff(sqlTables, docTables)}], only in 05 §3: [${diff(docTables, sqlTables)}]`);
} else {
  ok(`table inventory: ${sqlTables.size} tables agree between schema.sql and 05 §3`);
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

// --- summary ---------------------------------------------------------------
console.log(
  failures === 0
    ? '\nALL BACKEND CHECKS PASSED'
    : `\n${failures} CHECK(S) FAILED`,
);
if (failures > 0) process.exitCode = 1;
