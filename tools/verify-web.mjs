#!/usr/bin/env node
// verify-web.mjs — the P3 check.
//
// P3's deliverable is a *builder*, and the thing about a builder that a unit
// test cannot see is whether it still agrees with 04-BUILDER-UX.md. The app's
// node:test suites cover behaviour — undo is exact, a domino run is evenly
// spaced, the strict writer round-trips. This covers the five things that are
// true of the pair (spec, code) rather than of the code alone:
//
//   A. **The migration is clean.** `types/editor.ts` became a forwarding stub at
//      P3, the third file to make that move. A stub that grows a declaration is
//      a second source of truth, so it is asserted to be a pure re-export — and
//      the path it forwards to has to exist, which is the defect that has now
//      bitten this repo three times (P0's `./api.ts`, P2a's `types/protocol.ts`,
//      and this suite's own sibling reading `types/editor.ts`).
//   B. **Normative copy.** 04 §8.6 fixes the sentence shown for every error and
//      warning code. Copy drifts silently: nothing breaks when a string changes.
//   C. **Normative constants.** Every `EDITOR` threshold is prose in 04 with a
//      number attached, and the two are read by different people months apart.
//   D. **The catalogs line up.** Palette, skins, id prefixes, material sections
//      and the inspector's ranges are all restatements of 02 or of 04 — a type
//      that exists in the format and not in the palette is unreachable in the
//      UI, and an inspector range wider than the schema's is a field that
//      accepts values the gate rejects.
//   E. **Layering.** `apps/web` may not import the engine barrel: `sim/rapier.ts`
//      loads the WASM at module scope, and edit mode has no world. The shared
//      geometry comes through `@physics/engine/geometry` (03 §5.3) or not at
//      all — and if it came through a *copy*, the picture and the physics could
//      disagree, which is the one thing that module exists to prevent.
//
// This does NOT introduce a phase exit criterion: P3's definition of done is
// still the per-tier perf gate in `determinism-matrix.yml` (12-ROADMAP §5),
// which arrives with the renderer. This is a check *inside* ci.yml, the role
// verify-scene.mjs plays for the format and verify-engine.mjs for the core.
//
// Zero dependencies. Run: `pnpm run verify:web` (builds the app first — the
// checks read the emitted values, not a regex over the source).

import { existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ROOT, readRepo, readRepoJson, repoPath } from './repo.mjs';

const DIST = repoPath('apps/web/dist/src/index.js');
if (!existsSync(DIST)) {
  console.error(
    'apps/web is not built — the checks read the emitted tables, not the source.\n' +
      'Run: pnpm run verify:web   (which builds first)',
  );
  process.exit(2);
}
const web = await import(new URL(`file://${DIST}`).href);
const format = await import(new URL(`file://${repoPath('packages/scene-format/dist/src/index.js')}`).href);
const geometry = await import(new URL(`file://${repoPath('packages/engine/dist/src/geometry.js')}`).href);

// ---------------------------------------------------------------------------
// Document parsing
// ---------------------------------------------------------------------------

/** Slice a markdown section by its heading up to the next heading of that depth. */
function section(md, headingRe, depth = 2) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start < 0) return '';
  const stop = new RegExp(`^#{1,${depth}} `);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (stop.test(lines[i])) { end = i; break; }
  return lines.slice(start, end).join('\n');
}

/** 04 §8.6's table → { CODE: "copy" }. */
function copyTable(doc) {
  const sec = section(doc, /^### 8\.6 /, 3);
  const out = {};
  for (const line of sec.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1);
    if (cells.length < 2) continue;
    const codes = [...cells[0].matchAll(/`([A-Z_]+)`/g)].map((m) => m[1]);
    const quoted = cells[1].match(/"([^"]+)"/);
    if (codes.length === 0 || !quoted) continue;
    for (const code of codes) out[code] = quoted[1];
  }
  return out;
}

/** Every `` `NAME` `` token inside one line of the document. */
const ticked = (line) => [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/** 04 §12.3's normative skin names. */
function skinNames(doc) {
  const line = doc.split('\n').find((l) => l.includes('Normative **names**'));
  if (!line) return null;
  return ticked(line).filter((t) => /^[a-z]+$/.test(t));
}

/** 04 §3.1's palette group labels, in order. */
function paletteLabels(doc) {
  const line = doc.split('\n').find((l) => l.includes('`PALETTE_GROUPS`'));
  if (!line) return null;
  const tail = line.split('`PALETTE_GROUPS`):')[1];
  return tail ? tail.split('.')[0].split(',').map((s) => s.trim()) : null;
}

/** `NAME = value` occurrences in the document, for constants 04 states outright. */
function statedConstants(doc, names) {
  const out = {};
  for (const name of names) {
    const m = doc.match(new RegExp(`${name}\\s*=\\s*(-?[0-9.]+)`));
    if (m) out[name] = Number(m[1]);
  }
  return out;
}

/** JSON-Schema min/max for one type's own props. */
function schemaRanges(schema, defName) {
  const props = schema.$defs?.[defName]?.properties?.props?.properties ?? {};
  const out = {};
  for (const [key, spec] of Object.entries(props)) {
    if (typeof spec.minimum === 'number' || typeof spec.maximum === 'number') {
      out[key] = { min: spec.minimum, max: spec.maximum };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The world every check reads from (verify-engine idiom — a check that cannot
// be made to fail is not a check).
// ---------------------------------------------------------------------------

function loadWorld() {
  const doc04 = readRepo('docs/04-BUILDER-UX.md');
  const schema = readRepoJson('packages/scene-format/scene.schema.json');
  const srcFiles = {};
  for (const f of [
    'model', 'ids', 'refs', 'document', 'commands', 'store',
    'shapes', 'snap', 'place', 'edits', 'write', 'gate', 'budgets', 'drafts',
  ]) {
    srcFiles[`editor/${f}.ts`] = readRepo(`apps/web/src/editor/${f}.ts`);
  }
  for (const f of ['perf', 'classify', 'camera', 'grid', 'generated', 'frame', 'quality', 'three']) {
    srcFiles[`render/${f}.ts`] = readRepo(`apps/web/src/render/${f}.ts`);
  }
  srcFiles['index.ts'] = readRepo('apps/web/src/index.ts');
  const doc09 = readRepo('docs/09-PERFORMANCE.md');
  return {
    doc04,
    doc09,
    copy: copyTable(doc04),
    skins: skinNames(doc04),
    palette: paletteLabels(doc04),
    stated: statedConstants(doc04, Object.keys(web.EDITOR)),
    schema,
    srcFiles,
    stubSrc: readRepo('types/editor.ts'),
    webPkg: readRepoJson('apps/web/package.json'),
    enginePkg: readRepoJson('packages/engine/package.json'),
    rootPkg: readRepoJson('package.json'),
    ci: readRepo('.github/workflows/ci.yml'),
    EDITOR: { ...web.EDITOR },
    keymap: web.DEFAULT_KEYMAP.map((b) => ({ ...b })),
    ERROR_COPY: { ...web.ERROR_COPY },
    SKIN_NAMES: [...web.SKIN_NAMES],
    DEFAULT_SKIN: { ...web.DEFAULT_SKIN },
    ID_PREFIX: { ...web.ID_PREFIX },
    MATERIAL_SECTION: { ...web.MATERIAL_SECTION },
    PALETTE_GROUPS: web.PALETTE_GROUPS.map((g) => ({ ...g, items: [...g.items] })),
    LINK_TOOL_ORDER: [...web.LINK_TOOL_ORDER],
    TYPE_PROP_FIELDS: Object.fromEntries(Object.entries(web.TYPE_PROP_FIELDS).map(([k, v]) => [k, v.map((f) => ({ ...f }))])),
    LINK_PROP_FIELDS: Object.fromEntries(Object.entries(web.LINK_PROP_FIELDS).map(([k, v]) => [k, v.map((f) => ({ ...f }))])),
    SURFACE_SNAP_TARGETS: [...web.SURFACE_SNAP_TARGETS],
    perfStub: readRepo('types/perf.ts'),
    communitySrc: readRepo('types/community.ts'),
    RENDER_CLASS: { ...web.RENDER_CLASS },
    INSTANCED_TYPES: [...web.INSTANCED_TYPES],
    INSTANCE_PRIMITIVES: Object.fromEntries(Object.entries(web.INSTANCE_PRIMITIVES).map(([k, v]) => [k, [...v]])),
    PERF_TIERS: JSON.parse(JSON.stringify(web.PERF_TIERS)),
    RENDER: { ...web.RENDER },
    OVERLOAD: { ...web.OVERLOAD },
    MAX_INSTANCE_GROUPS: web.MAX_INSTANCE_GROUPS,
    MAX_INSTANCE_DRAWS: web.MAX_INSTANCE_DRAWS,
    SKIN_COLORS: { ...web.SKIN_COLORS },
    /** Collider kinds the engine's own §6 expansion emits, per instanced type. */
    colliderKinds: expandedColliderKinds(),
  };
}

/**
 * Expand every instanced type through the engine and collect the collider kinds
 * it really emits — including the prop variants that change the expansion.
 *
 * This is the check that makes 09 §4's corrected draw ceiling a *measured*
 * number: `INSTANCE_PRIMITIVES` is a declaration in the renderer, and a §6
 * change that gives a prefab a second primitive must fail here rather than
 * quietly cost a draw call nobody budgeted.
 */
function expandedColliderKinds() {
  const VARIANTS = {
    pendulum: [{ arm: 'rigid' }, { arm: 'rope' }],
    spring: [{ mode: 'passive' }, { mode: 'triggered' }],
    piston: [{ mode: 'cycle' }, { mode: 'triggered' }],
  };
  const out = {};
  for (const type of web.INSTANCED_TYPES) {
    const kinds = new Set();
    for (const props of VARIANTS[type] ?? [{}]) {
      const doc = { schemaVersion: 1, engineVersion: '0.1.0', world: {}, objects: [{ id: 'o1', type, pos: [0, 0], props }], links: [] };
      const geom = geometry.objectGeometry(geometry.canonicalize(doc).byId.get('o1'));
      for (const piece of geom.pieces) for (const c of piece.colliders) kinds.add(c.kind);
    }
    out[type] = [...kinds].sort();
  }
  return out;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** Constants 04 gives a value in prose but not as `NAME = value`. */
const PROSE_VALUES = {
  POS_SNAP_CHOICES_M: [0.005, 0.01, 0.02, 0.05, 0.1],
  POS_SNAP_DEFAULT_M: 0.01,
  ROT_SNAP_DEG: 15,
  ROT_SNAP_FINE_DEG: 1,
  NUDGE_LARGE_FACTOR: 5,
  NUDGE_FINE_M: 0.001,
  ALIGN_SNAP_M: 0.005,
  GEAR_SNAP_TOL_FACTOR: 0.15,
  GEAR_SNAP_TOL_MIN_M: 0.003,
  GEAR_SNAP_TOL_MAX_M: 0.02,
  DOMINO_RUN_SPACING_FACTOR: 0.75,
  DOMINO_RUN_SPACING_RANGE: [0.4, 0.95],
  LONG_PRESS_MS: 350,
  TOUCH_MIN_TARGET_PX: 44,
  AUTOSAVE_INTERVAL_S: 30,
  AUTOSAVE_RING: 5,
  VALIDATE_DEBOUNCE_MS: 300,
  BUDGET_WARN_FRACTION: 0.8,
  CAMERA_TILT_DEFAULT_DEG: 15,
  CAMERA_TILT_MAX_DEG: 35,
  PLANE_ROLL_CLAMP_DEG: 25,
  THUMB_W: 640,
  THUMB_H: 360,
  SMART_GUIDE_MAX_CANDIDATES: 24,
  // Camera and grid numbers 04 §4 states in prose (added at P3b).
  CAMERA_FOV_DEG: 50,
  CAMERA_FIT_MARGIN: 0.2,
  CAMERA_MIN_SPAN_M: 0.01,
  CAMERA_MIN_SPAN_PX: 50,
  GRID_MAJOR_EVERY: 10,
};

/** Source with comments removed — layering rules are about code, not prose. */
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function runChecks(w, log) {
  let fails = 0;
  const A = (cond, msg) => {
    if (cond) { if (log) console.log(`  ok   ${msg}`); }
    else { if (log) console.log(`  FAIL ${msg}`); fails++; }
  };
  const H = (h) => { if (log) console.log(`\n${h}`); };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // -- A. The migration --------------------------------------------------
  H('A. types/editor.ts is a pure forwarding stub (P1/P2 precedent)');
  const stubBody = w.stubSrc.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  A(
    /^export \* from '\.\.\/apps\/web\/src\/editor\/model';$/.test(stubBody),
    `the stub is exactly one re-export (got ${JSON.stringify(stubBody.slice(0, 60))})`,
  );
  A(
    !/\b(interface|const|function|class|type)\b/.test(stubBody),
    'the stub declares nothing — one source of truth, not two',
  );
  A(
    w.doc04.includes('apps/web/src/editor/model.ts'),
    '04 names the file the model actually lives in (the reference this migration would otherwise strand)',
  );
  A(
    !/^\*\*Companion file:\*\* `types\/editor\.ts`/m.test(w.doc04),
    "04's companion line no longer points at the pre-P3 path",
  );

  // -- B. Normative copy (04 §8.6) ---------------------------------------
  H('B. 04 §8.6 error copy ↔ ERROR_COPY');
  const codes = Object.keys(w.copy);
  A(codes.length >= 8, `parsed ${codes.length} code(s) from §8.6`);
  for (const code of codes) {
    A(w.ERROR_COPY[code] === w.copy[code], `${code}: copy matches §8.6`);
  }
  const extra = Object.keys(w.ERROR_COPY).filter((c) => !(c in w.copy));
  A(extra.length === 0, `no copy string outside §8.6 (stray: ${extra.join(', ') || 'none'})`);

  // -- C. Normative constants (04 §6, §9, §13.2, §14) --------------------
  H('C. EDITOR constants ↔ 04 prose');
  const keys = Object.keys(w.EDITOR);
  const unaccounted = keys.filter((k) => !(k in w.stated) && !(k in PROSE_VALUES));
  A(
    unaccounted.length === 0,
    `every EDITOR constant is anchored in 04 (unanchored: ${unaccounted.join(', ') || 'none'})`,
  );
  for (const [name, value] of Object.entries(w.stated)) {
    A(w.EDITOR[name] === value, `${name} = ${value} as 04 states it (got ${w.EDITOR[name]})`);
  }
  for (const [name, value] of Object.entries(PROSE_VALUES)) {
    if (!(name in w.EDITOR)) continue;
    A(eq(w.EDITOR[name], value), `${name} = ${JSON.stringify(value)} as 04 §6/§9/§13/§14 describe (got ${JSON.stringify(w.EDITOR[name])})`);
  }

  // -- D. Catalogs --------------------------------------------------------
  H('D. Palette, skins, prefixes and inspector ranges');
  const objectTypes = [...format.OBJECT_TYPES];
  const linkTypes = [...format.LINK_TYPES];

  const paletteItems = w.PALETTE_GROUPS.flatMap((g) => g.items);
  A(eq([...paletteItems].sort(), [...objectTypes].sort()), 'the palette covers every catalog type exactly once');
  A(eq([...w.LINK_TOOL_ORDER].sort(), [...linkTypes].sort()), 'the link group covers every link type');
  const labels = w.PALETTE_GROUPS.map((g) => g.label);
  A(
    w.palette !== null && eq(w.palette, [...labels, 'Links']),
    `§3.1's group list matches PALETTE_GROUPS + Links (doc: ${JSON.stringify(w.palette)}, code: ${JSON.stringify(labels)})`,
  );

  A(w.skins !== null && eq(w.skins, w.SKIN_NAMES), `§12.3's skin names match SKIN_NAMES (doc: ${JSON.stringify(w.skins)})`);
  const badSkin = Object.entries(w.DEFAULT_SKIN).filter(([, s]) => !w.SKIN_NAMES.includes(s));
  A(badSkin.length === 0, `every DEFAULT_SKIN is a declared skin (bad: ${badSkin.map(([t]) => t).join(', ') || 'none'})`);
  // The five §12.3 spells out.
  for (const [type, skin] of [['domino', 'wood'], ['marble', 'glass'], ['gear', 'brass'], ['crate', 'wood'], ['platform', 'stone']]) {
    A(w.DEFAULT_SKIN[type] === skin, `DEFAULT_SKIN.${type} is ${skin} (§12.3)`);
  }

  const prefixed = [...objectTypes, ...linkTypes];
  const missingPrefix = prefixed.filter((t) => typeof w.ID_PREFIX[t] !== 'string');
  A(missingPrefix.length === 0, `ID_PREFIX covers all ${prefixed.length} types (missing: ${missingPrefix.join(', ') || 'none'})`);
  const dupPrefix = Object.values(w.ID_PREFIX).filter((p, i, all) => all.indexOf(p) !== i);
  A(dupPrefix.length === 0, `id prefixes are unique (duplicated: ${[...new Set(dupPrefix)].join(', ') || 'none'})`);
  const illegal = Object.entries(w.ID_PREFIX).filter(([, p]) => !format.ID_PATTERN.test(`${p}1`));
  A(illegal.length === 0, `every generated id matches the 02 §2.1 pattern (bad: ${illegal.map(([t]) => t).join(', ') || 'none'})`);

  // Material sections restate the format's dynamic/static split.
  const dynSection = objectTypes.filter((t) => w.MATERIAL_SECTION[t] === 'dyn').sort();
  A(
    eq(dynSection, [...format.DYNAMIC_TYPES].sort()),
    `MATERIAL_SECTION 'dyn' equals DYNAMIC_TYPES (got ${dynSection.join(', ')})`,
  );
  const noneSection = objectTypes.filter((t) => w.MATERIAL_SECTION[t] === 'none').sort();
  A(eq(noneSection, ['fan', 'goal', 'magnet', 'trigger']), `only fields and sensors have no material section (got ${noneSection.join(', ')})`);

  // Inspector ranges mirror the schema (04 §8.1).
  let rangeChecks = 0;
  for (const type of objectTypes) {
    const ranges = schemaRanges(w.schema, `obj_${type}`);
    for (const field of w.TYPE_PROP_FIELDS[type] ?? []) {
      const spec = ranges[field.key];
      if (!spec || field.kind !== 'number') continue;
      rangeChecks++;
      A(
        field.min === spec.min && field.max === spec.max,
        `${type}.${field.key} range ${field.min}–${field.max} mirrors the schema's ${spec.min}–${spec.max}`,
      );
    }
  }
  for (const type of linkTypes) {
    const ranges = schemaRanges(w.schema, `link_${type}`);
    for (const field of w.LINK_PROP_FIELDS[type] ?? []) {
      const spec = ranges[field.key];
      if (!spec || field.kind !== 'number') continue;
      rangeChecks++;
      A(
        field.min === spec.min && field.max === spec.max,
        `${type}.${field.key} range ${field.min}–${field.max} mirrors the schema's ${spec.min}–${spec.max}`,
      );
    }
  }
  A(rangeChecks >= 30, `compared ${rangeChecks} inspector ranges against the schema`);

  // Surface-snap targets are exactly the four static surfaces §5.2 names.
  A(eq([...w.SURFACE_SNAP_TARGETS].sort(), ['conveyor', 'curve', 'platform', 'ramp']), '§5.2 seat targets are the static surfaces');

  // -- E. Keymap ----------------------------------------------------------
  H('E. Keymap (04 §13.1)');
  const actions = new Set(w.keymap.map((b) => b.action));
  const declared = [...(w.srcFiles['editor/model.ts'].match(/export type EditorAction =([\s\S]*?);/)?.[1] ?? '').matchAll(/'([\w.]+)'/g)].map((m) => m[1]);
  A(declared.length > 20, `parsed ${declared.length} declared editor actions`);
  const unbound = declared.filter((a) => !actions.has(a));
  A(unbound.length === 0, `every EditorAction has a binding (unbound: ${unbound.join(', ') || 'none'})`);
  const undeclared = [...actions].filter((a) => !declared.includes(a));
  A(undeclared.length === 0, `no binding names an undeclared action (stray: ${undeclared.join(', ') || 'none'})`);
  const seen = new Map();
  const clashes = [];
  for (const b of w.keymap) {
    const sig = `${b.key}|${[...(b.mods ?? [])].sort().join('+')}|${b.context}`;
    // `both` collides with either specific context as well.
    for (const ctx of b.context === 'both' ? ['edit', 'test'] : [b.context]) {
      const key = `${b.key}|${[...(b.mods ?? [])].sort().join('+')}|${ctx}`;
      if (seen.has(key) && seen.get(key) !== b.action) clashes.push(`${key} → ${seen.get(key)} / ${b.action}`);
      seen.set(key, b.action);
    }
    void sig;
  }
  A(clashes.length === 0, `no two actions claim one chord in one context (clashes: ${clashes.join('; ') || 'none'})`);
  // §13.1 renders keys for humans; the keymap stores `KeyboardEvent.key`. The
  // two spellings differ in four places and only four, so they are listed
  // rather than pattern-matched — a fuzzy match here would let a genuinely
  // undocumented binding through.
  const DOC_SPELLING = { ' ': 'Space', Delete: 'Del', Escape: 'Esc' };
  const section13 = section(w.doc04, /^### 13\.1 /, 3);
  const undocumented = [...new Set(w.keymap.map((b) => b.key))].filter((k) => {
    if (k.startsWith('Arrow')) return !section13.includes('arrows');
    const name = DOC_SPELLING[k] ?? k;
    return (
      !section13.includes(`\`${name}\``) &&
      !section13.includes(`\`mod+${name}\``) &&
      !section13.includes(`\`Shift+${name}\``)
    );
  });
  A(undocumented.length === 0, `every bound key appears in §13.1's table (missing: ${undocumented.join(', ') || 'none'})`);

  // -- F. Layering + wiring ----------------------------------------------
  H('F. Layering and gate wiring');
  const barrelImports = Object.entries(w.srcFiles).filter(([, src]) => /from '@physics\/engine'/.test(src));
  A(
    barrelImports.length === 0,
    `no file imports the engine barrel (offenders: ${barrelImports.map(([f]) => f).join(', ') || 'none'})`,
  );
  A(
    typeof w.enginePkg.exports?.['./geometry'] === 'object',
    'packages/engine exposes the Rapier-free ./geometry entry point (03 §5.3)',
  );
  const usesGeometry = Object.values(w.srcFiles).some((src) => /@physics\/engine\/geometry/.test(src));
  A(usesGeometry, 'the shared geometry module is what the editor derives placements from, not a copy');
  A(
    /countDynamicBodies/.test(w.srcFiles['editor/budgets.ts']),
    "the status bar's body count is the loader's own function (04 §14 'exact')",
  );
  A(
    /from '@physics\/engine\/geometry'/.test(w.srcFiles['editor/write.ts']) && /quantize/.test(w.srcFiles['editor/write.ts']),
    'the strict writer imports the reader\'s quantize rather than reimplementing 02 §2',
  );

  A(w.webPkg.physics?.phase === 'P3', `apps/web declares phase P3 (got ${w.webPkg.physics?.phase})`);
  A(typeof w.webPkg.scripts?.build === 'string' && typeof w.webPkg.scripts?.test === 'string', 'apps/web builds and tests (D30)');
  A(
    typeof w.rootPkg.scripts?.['verify:web'] === 'string' && w.rootPkg.scripts['verify:web'].includes('tools/verify-web.mjs'),
    'a root verify:web script exists',
  );
  A((w.rootPkg.scripts?.verify ?? '').includes('verify:web'), 'the aggregate verify script runs it');
  const suites = parseYaml(w.ci)?.jobs?.verify?.strategy?.matrix?.suite ?? [];
  A(suites.includes('web'), `ci.yml's verify matrix includes the web suite (has: ${suites.join(', ')})`);

  // -- G. Render classification ↔ 09 §4 (P3b) -----------------------------
  H('G. Render classification and the draw ceilings (09 §4)');
  A(
    objectTypes.every((t) => ['instanced', 'generated', 'overlay'].includes(w.RENDER_CLASS[t])),
    `every catalog type is classified (${objectTypes.length} types)`,
  );
  const classedInstanced = objectTypes.filter((t) => w.RENDER_CLASS[t] === 'instanced').sort();
  A(
    eq([...w.INSTANCED_TYPES].sort(), classedInstanced),
    `INSTANCED_TYPES is exactly the instanced set (${w.INSTANCED_TYPES.length} vs ${classedInstanced.length})`,
  );
  A(
    w.MAX_INSTANCE_GROUPS === w.INSTANCED_TYPES.length * w.SKIN_NAMES.length,
    `MAX_INSTANCE_GROUPS = types × skins = ${w.INSTANCED_TYPES.length} × ${w.SKIN_NAMES.length} (got ${w.MAX_INSTANCE_GROUPS})`,
  );
  // The corrected ceiling, re-derived from the engine rather than trusted.
  const kindOf = { box: 'cuboid', sphere: 'ball', disc: 'ball' };
  let derivedMeshSlots = 0;
  for (const type of w.INSTANCED_TYPES) {
    const declared = [...new Set((w.INSTANCE_PRIMITIVES[type] ?? []).map((prim) => kindOf[prim]))].sort();
    A(
      eq(declared, w.colliderKinds[type]),
      `${type}: declared primitives ${JSON.stringify(w.INSTANCE_PRIMITIVES[type])} match the §6 colliders ${JSON.stringify(w.colliderKinds[type])}`,
    );
    derivedMeshSlots += (w.INSTANCE_PRIMITIVES[type] ?? []).length;
  }
  A(
    w.MAX_INSTANCE_DRAWS === derivedMeshSlots * w.SKIN_NAMES.length,
    `MAX_INSTANCE_DRAWS = ${derivedMeshSlots} mesh slots × ${w.SKIN_NAMES.length} skins = ${derivedMeshSlots * w.SKIN_NAMES.length} (got ${w.MAX_INSTANCE_DRAWS})`,
  );
  A(
    w.MAX_INSTANCE_DRAWS >= w.MAX_INSTANCE_GROUPS,
    'the draw ceiling is never below the group ceiling — one mesh per group at least',
  );
  A(
    w.doc09.includes(`MAX_INSTANCE_DRAWS`) && w.doc09.includes(`${w.MAX_INSTANCE_DRAWS}`),
    `09 §4 names the corrected draw ceiling (${w.MAX_INSTANCE_DRAWS})`,
  );
  A(
    w.SKIN_NAMES.every((skin) => typeof w.SKIN_COLORS[skin] === 'number'),
    'every skin has a placeholder color (04 §12.3 — flat colors until the M8 art pass)',
  );

  // -- H. The perf migration and its ties (P3b) ---------------------------
  H('H. types/perf.ts ↔ apps/web/src/render/perf.ts');
  A(
    /export \* from '\.\.\/apps\/web\/src\/render\/perf';/.test(w.perfStub),
    'types/perf.ts re-exports the migrated render half',
  );
  for (const kept of ['READPATH', 'FAST_PREVIEW']) {
    A(w.perfStub.includes(`export const ${kept}`), `${kept} stays behind for its own phase (P4/P5)`);
  }
  for (const moved of ['PERF_TIERS', 'RENDER_CLASS', 'MAX_INSTANCE_GROUPS']) {
    A(!new RegExp(`export const ${moved}\\b`).test(w.perfStub), `${moved} is declared once, in the app (not re-declared in the stub)`);
  }
  A(
    /_lowTierIsRankableCeiling/.test(w.perfStub),
    "the 09 §7 tie between `low` and the rankable ceiling kept its compile proof",
  );
  const bodyBudget = Number(/BODY_BUDGET:\s*([0-9_]+)/.exec(w.communitySrc)?.[1]?.replace(/_/g, '') ?? NaN);
  A(
    Number.isFinite(bodyBudget) && w.PERF_TIERS.low.smoothBodyTarget === bodyBudget,
    `low's smoothBodyTarget is VERIFY.BODY_BUDGET (${w.PERF_TIERS.low.smoothBodyTarget} vs ${bodyBudget})`,
  );
  A(
    w.PERF_TIERS.high.smoothBodyTarget >= w.PERF_TIERS.mid.smoothBodyTarget &&
      w.PERF_TIERS.mid.smoothBodyTarget >= w.PERF_TIERS.low.smoothBodyTarget,
    `tier targets stay ordered high ≥ mid ≥ low (${w.PERF_TIERS.high.smoothBodyTarget}/${w.PERF_TIERS.mid.smoothBodyTarget}/${w.PERF_TIERS.low.smoothBodyTarget})`,
  );
  // Every RENDER/OVERLOAD constant must be findable in 09's prose — the same
  // rule part C applies to EDITOR, extended to the budget the renderer reads.
  for (const [name, value] of Object.entries({ ...w.RENDER, ...w.OVERLOAD })) {
    A(
      w.doc09.includes(name) || w.doc09.includes(String(value)),
      `09 anchors ${name} (${value})`,
    );
  }
  A(
    /rolls the view by/.test(w.doc04) === false || w.doc04.includes('FOV'),
    '04 §4 states the FOV the zoom limits are derived from',
  );
  A(w.doc04.includes('apps/web/src/render/camera.ts'), '04 §4 names where the camera lives');

  // -- I. Render layering (P3b) -------------------------------------------
  H('I. Render layering');
  const renderFiles = Object.entries(w.srcFiles).filter(([f]) => f.startsWith('render/'));
  A(renderFiles.length >= 8, `${renderFiles.length} render module(s) scanned`);
  const threeLeaks = renderFiles.filter(([f, src]) => f !== 'render/three.ts' && /from 'three'/.test(src));
  A(
    threeLeaks.length === 0,
    `only the binding imports three (offenders: ${threeLeaks.map(([f]) => f).join(', ') || 'none'})`,
  );
  A(
    /@physics\/engine\/transport/.test(w.srcFiles['render/frame.ts']),
    'the frame reader takes §5.5 interpolation from the engine, not a copy',
  );
  A(
    typeof w.enginePkg.exports?.['./transport'] === 'object',
    'packages/engine exposes the Rapier-free ./transport entry point (the render thread never loads a physics build)',
  );
  const reimplemented = /(?:function|const)\s+(lerpAngle|advancePlayhead|sampleAt|lerpFrames)\b/.exec(
    codeOnly(w.srcFiles['render/frame.ts']),
  );
  A(
    reimplemented === null,
    `the renderer does not re-implement the §5.5 primitives it imports (found: ${reimplemented?.[1] ?? 'none'})`,
  );
  const domLeaks = renderFiles.filter(
    ([f, src]) => f !== 'render/three.ts' && /(?<![.\w])(document|window|navigator)\.[A-Za-z_$]/.test(codeOnly(src)),
  );
  A(
    domLeaks.length === 0,
    `the render rules stay DOM-free so node:test can hold them (offenders: ${domLeaks.map(([f]) => f).join(', ') || 'none'})`,
  );
  A(
    /@physics\/engine\/geometry/.test(w.srcFiles['render/classify.ts']),
    'the plan derives geometry from the engine (03 §5.3 — the picture and the physics share one expansion)',
  );

  return fails;
}

// ---------------------------------------------------------------------------
// Run: positives, then a negative battery that must all bite.
// ---------------------------------------------------------------------------

const world = loadWorld();
console.log(`verify-web — apps/web under ${ROOT}`);
const positiveFails = runChecks(world, true);

const clone = (w) => ({
  ...w,
  copy: { ...w.copy },
  stated: { ...w.stated },
  srcFiles: { ...w.srcFiles },
  EDITOR: { ...w.EDITOR },
  ERROR_COPY: { ...w.ERROR_COPY },
  DEFAULT_SKIN: { ...w.DEFAULT_SKIN },
  ID_PREFIX: { ...w.ID_PREFIX },
  MATERIAL_SECTION: { ...w.MATERIAL_SECTION },
  SKIN_NAMES: [...w.SKIN_NAMES],
  skins: w.skins === null ? null : [...w.skins],
  palette: w.palette === null ? null : [...w.palette],
  keymap: w.keymap.map((b) => ({ ...b })),
  PALETTE_GROUPS: w.PALETTE_GROUPS.map((g) => ({ ...g, items: [...g.items] })),
  LINK_TOOL_ORDER: [...w.LINK_TOOL_ORDER],
  SURFACE_SNAP_TARGETS: [...w.SURFACE_SNAP_TARGETS],
  TYPE_PROP_FIELDS: Object.fromEntries(Object.entries(w.TYPE_PROP_FIELDS).map(([k, v]) => [k, v.map((f) => ({ ...f }))])),
  LINK_PROP_FIELDS: Object.fromEntries(Object.entries(w.LINK_PROP_FIELDS).map(([k, v]) => [k, v.map((f) => ({ ...f }))])),
  RENDER_CLASS: { ...w.RENDER_CLASS },
  INSTANCED_TYPES: [...w.INSTANCED_TYPES],
  INSTANCE_PRIMITIVES: Object.fromEntries(Object.entries(w.INSTANCE_PRIMITIVES).map(([k, v]) => [k, [...v]])),
  colliderKinds: Object.fromEntries(Object.entries(w.colliderKinds).map(([k, v]) => [k, [...v]])),
  PERF_TIERS: structuredClone(w.PERF_TIERS),
  RENDER: { ...w.RENDER },
  OVERLOAD: { ...w.OVERLOAD },
  SKIN_COLORS: { ...w.SKIN_COLORS },
  webPkg: structuredClone(w.webPkg),
  enginePkg: structuredClone(w.enginePkg),
  rootPkg: structuredClone(w.rootPkg),
  schema: w.schema,
});

const NEGATIVES = [
  ['grow a declaration on the forwarding stub', (w) => { w.stubSrc += '\nexport const EXTRA = 1;\n'; }],
  ['leave 04 pointing at the pre-P3 path', (w) => { w.doc04 = w.doc04.replace(/apps\/web\/src\/editor\/model\.ts/g, 'types/editor.ts'); }],
  ['reword an error string without touching 04 §8.6', (w) => { w.ERROR_COPY.E_LIMITS = 'Too many things.'; }],
  ['add a copy string for a code the spec never names', (w) => { w.ERROR_COPY.E_MYSTERY = 'Something happened.'; }],
  ['retune the surface-snap range without touching 04 §5.2', (w) => { w.EDITOR.SURFACE_SNAP_RANGE_M = 0.05; }],
  ['shrink the undo ring without touching 04 §9', (w) => { w.EDITOR.HISTORY_CAP = 50; }],
  ['change the domino-run spacing factor', (w) => { w.EDITOR.DOMINO_RUN_SPACING_FACTOR = 0.5; }],
  ['add an editor constant no 04 prose fixes', (w) => { w.EDITOR.MYSTERY_NUDGE = 0.07; }],
  ['drop a catalog type from the palette', (w) => { w.PALETTE_GROUPS[1].items = w.PALETTE_GROUPS[1].items.filter((t) => t !== 'plank'); }],
  ['drop a link type from the link group', (w) => { w.LINK_TOOL_ORDER = w.LINK_TOOL_ORDER.filter((t) => t !== 'weld'); }],
  ['invent a skin the spec does not list', (w) => { w.SKIN_NAMES = [...w.SKIN_NAMES, 'chrome']; }],
  ['change a per-type default skin §12.3 spells out', (w) => { w.DEFAULT_SKIN.marble = 'steel'; }],
  ['give two types the same id prefix', (w) => { w.ID_PREFIX.plank = 'pla'; }],
  ['classify a static type as having dynamic material', (w) => { w.MATERIAL_SECTION.platform = 'dyn'; }],
  ['widen an inspector range past the schema', (w) => { w.TYPE_PROP_FIELDS.marble[0].max = 5; }],
  ['widen a link inspector range past the schema', (w) => { w.LINK_PROP_FIELDS.springLink[0].max = 99999; }],
  ['let a gear seat a domino (dynamic snap target)', (w) => { w.SURFACE_SNAP_TARGETS = [...w.SURFACE_SNAP_TARGETS, 'gear']; }],
  ['bind two actions to one chord', (w) => { w.keymap.push({ action: 'edit.flip', key: 'R', context: 'edit' }); }],
  ['leave an editor action unbound', (w) => { w.keymap = w.keymap.filter((b) => b.action !== 'edit.duplicate'); }],
  ['bind a key 04 §13.1 never mentions', (w) => { w.keymap.push({ action: 'edit.flip', key: 'Q', context: 'edit' }); }],
  ['import the engine barrel into the editor', (w) => { w.srcFiles['editor/snap.ts'] += "\nimport { createSimCore } from '@physics/engine';\n"; }],
  ['reimplement quantization in the writer', (w) => { w.srcFiles['editor/write.ts'] = w.srcFiles['editor/write.ts'].replace(/from '@physics\/engine\/geometry'/, "from './nowhere.js'"); }],
  ['count bodies with the editor\'s own arithmetic', (w) => { w.srcFiles['editor/budgets.ts'] = w.srcFiles['editor/budgets.ts'].replace(/countDynamicBodies/g, 'guessBodies'); }],
  ['withdraw the Rapier-free geometry entry point', (w) => { delete w.enginePkg.exports['./geometry']; }],
  ['unwire the web suite from ci.yml', (w) => { w.ci = w.ci.replace(/^          - web$/m, ''); }],
  ['drop verify:web from the aggregate verify script', (w) => { w.rootPkg.scripts.verify = w.rootPkg.scripts.verify.replace(' && pnpm run verify:web', ''); }],
  // -- P3b: the renderer ---------------------------------------------------
  ['leave a catalog type unclassified for the renderer', (w) => { delete w.RENDER_CLASS.plank; }],
  ['reclassify a type without updating INSTANCED_TYPES', (w) => { w.RENDER_CLASS.marble = 'generated'; }],
  ['give a prefab a second primitive without budgeting its draw', (w) => { w.colliderKinds.crate = ['ball', 'cuboid']; }],
  ['drop the pendulum rod from the primitive table', (w) => { w.INSTANCE_PRIMITIVES.pendulum = ['sphere']; }],
  ['let the draw ceiling drift from the primitives it counts', (w) => { w.MAX_INSTANCE_DRAWS = 88; }],
  ['ship a skin with no color', (w) => { delete w.SKIN_COLORS.candy; }],
  ['re-declare a migrated constant in the design stub', (w) => { w.perfStub += '\nexport const PERF_TIERS = {};\n'; }],
  ['drop the compile proof that low is the rankable ceiling', (w) => { w.perfStub = w.perfStub.replace(/_lowTierIsRankableCeiling/g, '_unused'); }],
  ['retune low’s target away from VERIFY.BODY_BUDGET', (w) => { w.PERF_TIERS.low.smoothBodyTarget = 2000; }],
  ['unorder the tier targets', (w) => { w.PERF_TIERS.mid.smoothBodyTarget = 99999; }],
  ['add a render constant 09 never states', (w) => { w.RENDER.MYSTERY_FUDGE = 0.123456789; }],
  ['let three.js leak out of the binding', (w) => { w.srcFiles['render/classify.ts'] += "\nimport { Mesh } from 'three';\n"; }],
  ['reach for the DOM from a render rule', (w) => { w.srcFiles['render/quality.ts'] += '\nconst dpr = window.devicePixelRatio;\n'; }],
  ['re-implement the §5.5 interpolation in the renderer', (w) => { w.srcFiles['render/frame.ts'] += '\nfunction lerpAngle(a, b, t) { return a; }\n'; }],
  ['read frames from somewhere other than the engine', (w) => { w.srcFiles['render/frame.ts'] = w.srcFiles['render/frame.ts'].replace(/@physics\/engine\/transport/g, './local.js'); }],
  ['withdraw the Rapier-free transport entry point', (w) => { delete w.enginePkg.exports['./transport']; }],
  ['derive the plan’s geometry from a copy', (w) => { w.srcFiles['render/classify.ts'] = w.srcFiles['render/classify.ts'].replace(/@physics\/engine\/geometry/g, './mygeom.js'); }],
];

console.log('\nnegative battery (each mutation must be caught):');
let bit = 0;
for (const [name, mutate] of NEGATIVES) {
  const w = clone(world);
  mutate(w);
  const f = runChecks(w, false);
  if (f > 0) { bit++; console.log(`  ok   bites: ${name} (${f} failure(s))`); }
  else console.log(`  FAIL silent: ${name}`);
}

console.log('\n' + '-'.repeat(40));
console.log(`positive failures: ${positiveFails}`);
console.log(`negative battery : ${bit}/${NEGATIVES.length} bit`);
const green = positiveFails === 0 && bit === NEGATIVES.length;
console.log(`verify-web: ${green ? 'GREEN' : 'RED'}`);
process.exitCode = green ? 0 : 1;
