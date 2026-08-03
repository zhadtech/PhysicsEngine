#!/usr/bin/env node
// verify-roadmap.mjs — the M11 traceability check.
//
// The roadmap (12-ROADMAP.md) is a plan, not a normative contract, so its
// quality bar is *coverage*: every open question ever raised must be disposed,
// every brief deliverable traced, every package sited, and the phase order a
// valid topological sort of the dependency DAG. This asserts all four against
// the *real* source documents — a roadmap that silently drops a U-issue, a
// brief item, or reorders a phase below its dependency fails the build.
//
// Zero dependencies. Run from anywhere: `pnpm verify:roadmap` (repo-root
// anchored since P0; its three source documents live in docs/).

import { readRepo } from './repo.mjs';

const eqSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const setStr = (s) => `{${[...s].sort((x, y) => x - y).join(',')}}`;

// Slice a markdown section by its `## N.` heading up to the next `## ` heading.
function section(md, headingRe) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break; }
  return lines.slice(start, end).join('\n');
}
// Leading table-cell U-numbers, e.g. "| U7 |" or "| **U30** (new) |".
function rowUNumbers(text) {
  const out = new Set();
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*\*{0,2}U(\d+)\b/);
    if (m) out.add(Number(m[1]));
  }
  return out;
}
// Leading table-cell integers, e.g. "| 13 |".
function rowIntegers(text) {
  const out = new Set();
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*(\d+)\s*\|/);
    if (m) out.add(Number(m[1]));
  }
  return out;
}
const allUNumbers = (t) => new Set([...t.matchAll(/\bU(\d+)\b/g)].map((m) => Number(m[1])));

const load = (name) => readRepo(`docs/${name}`);

// All checks live here so the negative battery can re-run them on mutated input.
// Returns the number of failed assertions; `log` gates output.
function runChecks(roadmap, brief, tracker, log) {
  let fails = 0;
  const A = (cond, m) => { if (cond) { if (log) console.log(`  ok   ${m}`); } else { if (log) console.log(`  FAIL ${m}`); fails++; } };

  // (1) U-issue coverage — the traceability spine.
  const universe = allUNumbers(tracker);            // every U ever raised (U1..U29)
  const disposition = section(roadmap, /^## 6\. /); // the §6 ledger
  const placed = rowUNumbers(disposition);          // U's disposed as table rows
  const expected = new Set([...universe, 30]);      // universe + the one new U30
  const missing = new Set([...universe].filter((u) => !placed.has(u)));

  A(universe.size >= 29 && universe.has(1) && universe.has(29),
    `tracker U-universe looks complete ${setStr(universe)}`);
  A(missing.size === 0, `every historically-raised U-issue is placed in §6 (missing: ${setStr(missing)})`);
  A(placed.has(30), 'the new U30 (public-API surface spec) is placed');
  A(eqSet(placed, expected), `§6 places exactly the universe + U30, no phantom (placed ${setStr(placed)})`);

  // Each U disposed exactly once (no double-listing across buckets).
  const counts = {};
  for (const l of disposition.split('\n')) {
    const m = l.match(/^\|\s*\*{0,2}U(\d+)/);
    if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  const dupes = Object.entries(counts).filter(([, c]) => c > 1).map(([u]) => 'U' + u);
  A(dupes.length === 0, `no U-issue listed twice in §6 (dupes: ${dupes.join(',') || 'none'})`);

  // (2) Brief deliverables — count them in the real brief, trace them in §8.
  const briefNums = new Set([...section(brief, /^## Deliverable/).matchAll(/^(\d+)\.\s/gm)].map((m) => Number(m[1])));
  const traced = rowIntegers(section(roadmap, /^## 8\. /));
  A(briefNums.size === 13 && briefNums.has(13), `brief lists 13 numbered deliverables ${setStr(briefNums)}`);
  A(eqSet(traced, briefNums), `§8 traces exactly the brief's deliverables (traced ${setStr(traced)} == brief ${setStr(briefNums)})`);

  // (3) Every package/app of the 01 §5 layout is sited, and its phase parsed
  //     from the §3 table so a reorder is detectable in (4).
  const phaseTable = section(roadmap, /^## 3\. /);
  const phaseOf = {};
  for (const line of phaseTable.split('\n')) {
    const pm = line.match(/\*\*P(\d)\*\*/);
    if (!pm) continue;
    const p = Number(pm[1]);
    // First-wins: the table is in phase order, and some later rows mention an
    // earlier package (e.g. P6's /ai routes live in apps/api) — bind to the
    // first phase that introduces each package.
    for (const [key, re] of Object.entries({
      'scene-format': /scene-format/, engine: /`packages\/engine`/, web: /apps\/web/,
      api: /apps\/api/, procgen: /`packages\/procgen`/, ai: /`packages\/ai`/,
      community: /Community over/, infra: /Production infra/,
    })) if (re.test(line) && !(key in phaseOf)) phaseOf[key] = p;
  }
  for (const pkg of ['scene-format', 'engine', 'web', 'api', 'procgen', 'ai', 'community', 'infra'])
    A(pkg in phaseOf, `package/app "${pkg}" is sited in a build phase (§3)`);
  A(/shared/.test(roadmap) && /collab/.test(roadmap), 'shared + collab are accounted for');

  // (4) Phase order is contiguous P0..P8 and topologically valid vs the §2 DAG.
  const phaseIds = [...new Set([...phaseTable.matchAll(/\*\*P(\d)\*\*/g)].map((m) => Number(m[1])))];
  A(phaseIds.length === 9 && phaseIds.every((p, i) => p === i), `§3 defines P0..P8 contiguously [${phaseIds.join(',')}]`);
  // Build-precedence DAG from §2 (a->b: a must exist before b). Note there is
  // no api->web edge: web ships as a *local* sandbox at P3, before api at P4;
  // its save/share layer is a P4 addition, not a build prerequisite.
  const edges = [
    ['scene-format', 'engine'], ['scene-format', 'api'], ['engine', 'web'],
    ['engine', 'procgen'], ['engine', 'community'], ['api', 'ai'], ['api', 'community'],
    ['procgen', 'ai'], ['web', 'community'], ['community', 'infra'],
  ];
  const violations = edges.filter(([a, b]) => !(a in phaseOf && b in phaseOf) || phaseOf[a] >= phaseOf[b]);
  A(violations.length === 0, `every dependency edge respects phase order (violations: ${violations.map((e) => e.join('->')).join(', ') || 'none'})`);

  // (5) The determinism-first keystone claim, load-bearing at P2.
  A(/determinism.first/i.test(roadmap) && /keystone|earliest hard (gate|exit)/i.test(roadmap),
    'the determinism-first sequencing (D28) is stated as the keystone');
  const g = section(roadmap, /^## 5\. /);
  A(/\bP2\b/.test(g) && /U26|real (golden )?hash/i.test(g),
    'P2 is named as where the determinism-matrix becomes real (closes U9/U26)');

  // (6) Release cuts + the MVP line.
  const rel = section(roadmap, /^## 4\. /);
  for (const r of ['Alpha', 'Beta', 'RC', '1.0']) A(rel.includes(r), `release cut "${r}" is defined (§4)`);
  A(/MVP/.test(rel) && /Beta/.test(rel), 'the MVP line is drawn at Beta (§4)');

  return fails;
}

// ---------- positive run ----------
const roadmap = load('12-ROADMAP.md');
const brief = load('project_idea.md');
const tracker = load('00-PROGRESS.md');

console.log('\n[roadmap] positive checks');
const posFails = runChecks(roadmap, brief, tracker, true);

// ---------- negative battery: each mutation must break >=1 check ----------
console.log('\n[roadmap] negative battery (each must bite — that is success)');
const negatives = [
  ['drop U18 from §6', (r) => r.replace(/^\| U18 \|.*$/m, '')],
  ['drop deliverable-13 row from §8', (r) => r.replace(/^\| 13 \|.*$/m, '')],
  ['unsite the engine package', (r) => r.replace(/`packages\/engine`/g, '`packages/gone`')],
  ['reorder engine (P2) after procgen (P5)', (r) => r
    .replace(/\*\*P2\*\* \| `packages\/engine`/, '**P2** | `packages/procgen`')
    .replace(/\*\*P5\*\* \| `packages\/procgen`/, '**P5** | `packages/engine`')],
  ['smuggle a phantom U31 into §6', (r) => r.replace(/(^## 7\. )/m, '| U31 | phantom | nowhere |\n\n$1')],
];
let negBit = 0;
for (const [name, mut] of negatives) {
  const f = runChecks(mut(roadmap), brief, tracker, false);
  if (f > 0) { console.log(`  ok   negative "${name}" bites (${f} failure${f > 1 ? 's' : ''})`); negBit++; }
  else console.log(`  FAIL negative "${name}" did NOT bite — the check is asleep`);
}

// ---------- summary ----------
console.log('\n----------------------------------------');
console.log(`positive failures: ${posFails}`);
console.log(`negative battery : ${negBit}/${negatives.length} bit`);
const green = posFails === 0 && negBit === negatives.length;
console.log(green ? 'verify-roadmap: GREEN' : 'verify-roadmap: RED');
process.exit(green ? 0 : 1);
