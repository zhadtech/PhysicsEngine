// P3a — id generation (04 §5.2, 02 §2.1).
//
// The rule is one sentence — "`<prefix><n>`, n = smallest unused positive
// integer for that prefix" — and the implementation is not the one-liner that
// sentence suggests, because scanning from 1 on every allocation is quadratic
// at the format's own 5 000-object ceiling. So the fast version is checked
// against a brute-force oracle that *is* the one-liner: any divergence is a bug
// in the optimisation, not a matter of opinion.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ID_PREFIX, IdAllocator, isValidId } from '../dist/src/index.js';

/** The literal reading of 04 §5.2, used as the oracle. */
function naive(taken, prefix) {
  for (let n = 1; ; n++) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

test('allocation matches the naive smallest-unused scan under churn', () => {
  const taken = new Set(['dom1', 'dom2', 'dom5', 'mar1']);
  const alloc = new IdAllocator(taken);
  // A deterministic pseudo-random script of allocate/release, replayed against
  // both implementations.
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const live = [];
  for (let i = 0; i < 500; i++) {
    const prefix = rand() < 0.5 ? 'dom' : 'mar';
    if (live.length > 0 && rand() < 0.35) {
      const at = Math.floor(rand() * live.length);
      const [id] = live.splice(at, 1);
      alloc.release(id);
      taken.delete(id);
      continue;
    }
    const expected = naive(taken, prefix);
    const got = alloc.next(prefix);
    assert.equal(got, expected, `iteration ${i}`);
    taken.add(got);
    live.push(got);
  }
});

test('objects and links share one namespace (02 §2.1)', () => {
  const alloc = new IdAllocator(['rope1']);
  assert.equal(alloc.next('rope'), 'rope2');
  assert.equal(alloc.has('rope1'), true);
});

test('nextFor uses the ID_PREFIX table', () => {
  const alloc = new IdAllocator();
  assert.equal(alloc.nextFor('gearMesh'), `${ID_PREFIX.gearMesh}1`);
  assert.equal(alloc.nextFor('domino'), `${ID_PREFIX.domino}1`);
});

test('releasing a low id makes it the next one out again', () => {
  const alloc = new IdAllocator();
  const a = alloc.next('dom');
  const b = alloc.next('dom');
  const c = alloc.next('dom');
  assert.deepEqual([a, b, c], ['dom1', 'dom2', 'dom3']);
  alloc.release('dom2');
  assert.equal(alloc.next('dom'), 'dom2');
  assert.equal(alloc.next('dom'), 'dom4');
});

test('nextLike keeps a pasted id\'s prefix', () => {
  const alloc = new IdAllocator(['dom1']);
  assert.equal(alloc.nextLike('dom17', 'dom'), 'dom2');
  // An id with no numeric tail still yields a numbered one.
  assert.equal(alloc.nextLike('floor', 'pla'), 'floor1');
});

test('the id grammar is 02 §2.1', () => {
  assert.equal(isValidId('dom_17-a'), true);
  assert.equal(isValidId(''), false);
  assert.equal(isValidId('has space'), false);
  assert.equal(isValidId('x'.repeat(24)), true);
  assert.equal(isValidId('x'.repeat(25)), false);
});

test('every generated id is a legal id', () => {
  const alloc = new IdAllocator();
  for (const type of Object.keys(ID_PREFIX)) {
    assert.equal(isValidId(alloc.nextFor(type)), true, type);
  }
});
