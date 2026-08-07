/**
 * The finding vocabulary the validation gate speaks (02 §8, 05 §5.2).
 *
 * One shape serves three consumers, which is the point of putting the gate in
 * this package: the builder's live validation panel (04 §7), the API error
 * envelope's `details.findings` (05 §5.2 — `ApiFinding` is structurally this
 * type, proven in `types/scene.typecheck.ts`), and the AI repair loop, which
 * feeds findings back to the model as the repair prompt (07 §4).
 */

import type { Id } from './scene.js';

export type Severity = 'error' | 'warning';

/** Rules that reject a document. `schema` is ajv's verdict; E1–E8 are 02 §8. */
export type ErrorRuleId = 'schema' | 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7' | 'E8';

/** Rules that annotate an accepted document (02 §8 W-rules). */
export type WarningRuleId = 'W9' | 'W10' | 'W11' | 'W12';

export type RuleId = ErrorRuleId | WarningRuleId;

export interface Finding {
  /** `"schema"` or a 02 §8 rule id: E1–E8, W9–W12. */
  rule: RuleId;
  severity: Severity;
  message: string;
  /** JSON pointer into the document, when locatable. */
  path?: string;
  /** Offending object/link ids, when known (jump-to-offender). */
  ids?: Id[];
}

/**
 * The rule table, verbatim from 02 §8.
 *
 * `Record<RuleId, …>` is the compile proof: a rule added to the union without
 * an entry here, or an entry for a rule the spec does not define, fails `tsc`.
 * The unit suite carries the runtime half — every rule in this table is
 * provably reachable by at least one corpus document, so a rule cannot be
 * declared and then never implemented.
 */
export const RULES: Record<RuleId, { severity: Severity; text: string }> = {
  schema: { severity: 'error', text: 'Document must validate against scene.schema.json.' },
  E1: { severity: 'error', text: 'Every id (objects + links) is unique in one namespace and matches the id pattern.' },
  E2: { severity: 'error', text: 'Every reference resolves to an existing object.' },
  E3: { severity: 'error', text: 'Link endpoints have the type the link requires.' },
  E4: { severity: 'error', text: 'A link may not connect an object to itself.' },
  E5: { severity: 'error', text: 'Named anchors must exist for the endpoint type.' },
  E6: { severity: 'error', text: 'All numbers are finite (no NaN/Infinity).' },
  E7: { severity: 'error', text: 'lever.minAngle < maxAngle when both are present.' },
  E8: { severity: 'error', text: 'Document is within the 02 §7 size limits.' },
  W9: { severity: 'warning', text: 'trigger.targets names an object with no activation effect.' },
  W10: { severity: 'warning', text: 'Object lies outside world.bounds plus the removal margin.' },
  W11: { severity: 'warning', text: 'Duplicate gearMesh, or a rope shorter than its endpoint distance.' },
  W12: { severity: 'warning', text: 'Number carries more than the writer limit of fractional digits.' },
} as const;

/** Build a finding, omitting empty locators rather than setting them undefined. */
export function finding(rule: RuleId, message: string, path?: string, ids?: readonly Id[]): Finding {
  const f: Finding = { rule, severity: RULES[rule].severity, message };
  if (path !== undefined) f.path = path;
  if (ids !== undefined && ids.length > 0) f.ids = [...ids];
  return f;
}

/** JSON pointer escaping (RFC 6901) for a path segment. */
export const ptr = (...segments: readonly (string | number)[]): string =>
  '/' + segments.map((s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
