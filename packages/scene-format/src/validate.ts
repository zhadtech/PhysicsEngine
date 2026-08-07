/**
 * The one validation gate (ADR-0004, ADR-0005; order normative per 05 §5.3).
 *
 * The same function runs in the builder's validation panel, in the API's write
 * path, in procgen's G1 gate (06 §8.1) and on AI output (07 §4). That is the
 * whole reason this package exists: the server can never be more lenient than
 * the client, because there is only one implementation.
 *
 * 05 §5.3 numbers eight steps. Steps 1, 2, 7 and 8 (transport cap, secure
 * parse, column extraction, the write transaction) are server concerns that
 * cannot exist in a browser; this gate is steps **3–6**, in that order, and the
 * order is load-bearing — an oversized document must diagnose as `E_LIMITS`
 * rather than as a wall of schema errors, and a document must be migrated to
 * the current version *before* it is validated, because the migrated document
 * is what gets stored.
 */

import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';

import sceneSchema from '../scene.schema.json' with { type: 'json' };
import type { Id, Scene } from './scene.js';
import { LIMITS } from './scene.js';
import { finding, type Finding } from './findings.js';
import { MigrationError, runMigrations, type SchemaMigration } from './migrate.js';
import { checkSemantics } from './semantic.js';

export { sceneSchema };

/**
 * Codes the gate can fail with.
 *
 * Deliberately a subset of `ApiErrorCode` (05 §5.2) — proven by a compile
 * assertion in `types/scene.typecheck.ts`. The gate may not invent an error the
 * API has never declared, because `verify-backend.mjs` holds the API's code set
 * to a three-way equality with the OpenAPI enum and the 05 §5.2 table.
 */
export type GateErrorCode = 'E_LIMITS' | 'E_SCHEMA_NEWER' | 'E_SCHEMA' | 'E_SEMANTIC';

export interface GateOptions {
  /**
   * Serialized size of the document as received, in bytes (05 §5.3 step 3).
   * The server always knows this; a client checking a live editor buffer may
   * not, and omitting it simply skips the cap check.
   */
  bytes?: number;
  /** Migration registry override. Defaults to the package's `SCENE_MIGRATIONS`. */
  migrations?: readonly SchemaMigration[];
}

export interface GateOk {
  ok: true;
  /** The **migrated** document — what callers must store and simulate. */
  doc: Scene;
  findings: Finding[];
  /** 02 §8 W-rules: accepted, but surfaced (04 §7 panel, 05 §5.3 `warnings`). */
  warnings: Finding[];
}

export interface GateFail {
  ok: false;
  code: GateErrorCode;
  doc: null;
  findings: Finding[];
  warnings: Finding[];
}

export type GateResult = GateOk | GateFail;

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

let compiled: ValidateFunction | null = null;

/**
 * The ajv-compiled schema validator, built once per process.
 *
 * 05 §5.3 step 5 says "compiled at boot" — compilation is the expensive part
 * (tens of ms), validation is not, so callers that validate in a loop (the
 * procgen self-check, the verification worker) pay it once.
 */
export function getSchemaValidator(): ValidateFunction {
  if (compiled === null) {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    compiled = ajv.compile(sceneSchema);
  }
  return compiled;
}

/** Resolve the owning object/link id for an ajv instance path, for jump-to-offender. */
function idAtPath(doc: unknown, instancePath: string): Id[] | undefined {
  const parts = instancePath.split('/').filter((s) => s !== '');
  const first = parts[0];
  const index = Number(parts[1]);
  if ((first !== 'objects' && first !== 'links') || !Number.isInteger(index)) return undefined;
  const container = (doc as Record<string, unknown>)[first];
  if (!Array.isArray(container)) return undefined;
  const entry: unknown = container[index];
  const id = (entry as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? [id] : undefined;
}

function ajvFinding(doc: unknown, e: ErrorObject): Finding {
  const where = e.instancePath === '' ? '(document root)' : e.instancePath;
  const extra =
    typeof e.params['additionalProperty'] === 'string' ? ` "${e.params['additionalProperty']}"` : '';
  return finding(
    'schema',
    `${where} ${e.message ?? 'is invalid'}${extra}`,
    e.instancePath === '' ? undefined : e.instancePath,
    idAtPath(doc, e.instancePath),
  );
}

/** Run schema validation alone (05 §5.3 step 5). Empty result means valid. */
export function validateAgainstSchema(doc: unknown): Finding[] {
  const validate = getSchemaValidator();
  if (validate(doc)) return [];
  return (validate.errors ?? []).map((e) => ajvFinding(doc, e));
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

const fail = (code: GateErrorCode, findings: Finding[], warnings: Finding[] = []): GateFail => ({
  ok: false,
  code,
  doc: null,
  findings,
  warnings,
});

/**
 * Validate a scene document: caps → version → schema → semantics.
 *
 * On success the returned `doc` is the **migrated** document, which is what the
 * caller stores and simulates (05 §5.3 step 4) — not the input.
 */
export function validateScene(input: unknown, opts: GateOptions = {}): GateResult {
  // -- Step 3: document caps (02 §7) ---------------------------------------
  // Before anything else, so an oversized document is diagnosed as too large
  // rather than drowned in downstream errors.
  if (opts.bytes !== undefined && opts.bytes > LIMITS.maxJsonBytes) {
    return fail('E_LIMITS', [
      finding('E8', `document is ${opts.bytes} bytes; the limit is ${LIMITS.maxJsonBytes}`, '/'),
    ]);
  }

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return fail('E_SCHEMA', [finding('schema', '(document root) must be a JSON object')]);
  }

  // -- Step 4: version switch, then migrate --------------------------------
  let migrated: Record<string, unknown>;
  try {
    migrated = runMigrations({ ...(input as Record<string, unknown>) }, opts.migrations);
  } catch (err) {
    if (!(err instanceof MigrationError)) throw err;
    if (err.reason === 'newer-than-app') {
      return fail('E_SCHEMA_NEWER', [finding('schema', err.message, '/schemaVersion')]);
    }
    // A document this build cannot bring up to the current version is not a
    // readable scene. 05 §5.2 declares no E_MIGRATION code, and none is added
    // here: an unreadable version is a schema failure to every caller.
    return fail('E_SCHEMA', [finding('schema', err.message, '/schemaVersion')]);
  }

  // -- Step 5: schema ------------------------------------------------------
  const schemaFindings = validateAgainstSchema(migrated);
  if (schemaFindings.length > 0) return fail('E_SCHEMA', schemaFindings);

  // The document is structurally a Scene from here — that is what step 5 proved.
  const doc = migrated as unknown as Scene;

  // -- Step 6: semantic rules (02 §8) --------------------------------------
  const semantic = checkSemantics(doc);
  const errors = semantic.filter((f) => f.severity === 'error');
  const warnings = semantic.filter((f) => f.severity === 'warning');
  if (errors.length > 0) return fail('E_SEMANTIC', errors, warnings);

  return { ok: true, doc, findings: [], warnings };
}

/**
 * Gate a serialized document: measures the byte cap from the text itself, then
 * parses and gates. The API's step 1–3 path (05 §5.3) in one call.
 */
export function validateSceneJson(text: string, opts: Omit<GateOptions, 'bytes'> = {}): GateResult {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > LIMITS.maxJsonBytes) {
    return fail('E_LIMITS', [
      finding('E8', `document is ${bytes} bytes; the limit is ${LIMITS.maxJsonBytes}`, '/'),
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return fail('E_SCHEMA', [
      finding('schema', `(document root) is not valid JSON: ${(err as Error).message}`),
    ]);
  }
  return validateScene(parsed, { ...opts, bytes });
}
