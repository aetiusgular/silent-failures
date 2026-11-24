// Lane P3c unit tests for the band gate (contracts/eval.md, "Band gate"), beyond the red tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { band, decide, repeatRates } from "./index.mjs";

const A = [0.8, 0.85, 0.8, 0.9, 0.85];
const derm = JSON.parse(readFileSync(new URL("../../fixtures/derm-repeats.json", import.meta.url), "utf8"));
const conds = [...new Set(derm.rows.map((r) => r.cond))];
const dermRates = (cond) => repeatRates(derm.rows.filter((r) => r.cond === cond));

test("a gain equal to the band width is inside the band, despite float noise", () => {
  const d = decide({ a: A, b: [0.95, 0.95, 0.95, 0.95, 0.9], k: 4, n: 5, tasks: 20 });
  assert.equal(d.promote, false);
  assert.match(d.reason, /inside the band/);
  assert.equal(d.beats, 4);
});

test("a repeat equal to the band's top does not beat it", () => {
  const d = decide({ a: [0.85, 0.8, 0.85, 0.85, 0.85].map((x) => x + 0.05), b: [0.9, 0.9, 0.9, 1, 1], k: 2, n: 5, tasks: 20 });
  assert.equal(d.beats, 2);
});

test("checks run in order: repeats, then band, then k of n", () => {
  assert.match(decide({ a: [0.5], b: [1, 1, 1, 1, 1], k: 4, n: 5, tasks: 20 }).reason, /need 5 repeats/);
  assert.match(decide({ a: A, b: A, k: 4, n: 5, tasks: 20 }).reason, /inside the band/);
  assert.match(decide({ a: A, b: [1, 1, 1, 0.9, 0.9], k: 4, n: 5, tasks: 20 }).reason, /3 of 5.*k of n/);
});

test("more repeats than n are all used", () => {
  const d = decide({ a: [...A, 0.85], b: [1, 1, 1, 1, 1, 1], k: 4, n: 5, tasks: 20 });
  assert.equal(d.promote, true);
  assert.equal(d.band.n, 6);
  assert.equal(d.beats, 6);
});

test("bad input throws instead of deciding", () => {
  assert.throws(() => band([], { tasks: 20 }), /at least one/);
  assert.throws(() => band([0.9]), /tasks/);
  assert.throws(() => band([1.2], { tasks: 20 }), /pass rates/);
  assert.throws(() => decide({ a: A, b: A, k: 6, n: 5, tasks: 20 }), /k <= n/);
});

test("no repeats of A or B is a refusal, not a throw (SL-P3c-r1-C3)", () => {
  for (const [a, b] of [[A, []], [[], A], [[], []]]) {
    const d = decide({ a, b, k: 4, n: 5, tasks: 20 });
    assert.equal(d.promote, false);
    assert.match(d.reason, /need 5 repeats/);
    assert.equal(d.beats, 0);
    assert.equal(d.gain, null);
    assert.equal(d.band.tasks, 20);
  }
  assert.equal(decide({ a: A, b: [], k: 4, n: 5, tasks: 20 }).band.hi, 0.9);
  assert.throws(() => decide({ a: [], b: [], k: 4, n: 5 }), /tasks/);
});

test("repeatRates orders repeats numerically and refuses a task twice in one repeat", () => {
  const rows = [
    { task: "t1", k: 10, pass: false },
    { task: "t1", k: 2, pass: true },
    { task: "t2", k: 2, pass: false },
    { task: "t2", k: 10, pass: false },
  ];
  assert.deepEqual(repeatRates(rows), [0.5, 0]);
  assert.throws(() => repeatRates([...rows, { task: "t1", k: 2, pass: true }]), /twice/);
  assert.throws(() => repeatRates([{ task: "t1", k: 1, pass: 1 }]), /boolean pass/);
});

test("derm's public repeats: 3 per condition, so the n = 5 gate refuses every pair", () => {
  assert.equal(conds.length, 5);
  for (const c of conds) {
    const r = dermRates(c);
    assert.equal(r.length, 3, c);
    for (const x of r) assert.ok(x >= 0 && x <= 1, c);
  }
  for (const a of conds) for (const b of conds) {
    if (a === b) continue;
    assert.equal(decide({ a: dermRates(a), b: dermRates(b), k: 4, n: 5, tasks: derm.tasks }).promote, false, `${a} -> ${b}`);
  }
});

test("derm's public repeats: a single-run gate promotes cc-unset over cc-false, the band gate does not", () => {
  const a = dermRates("cc-false");
  const b = dermRates("cc-unset");
  assert.ok(b[0] > a[0]); // repeat 1 only: B_1 > A_1, so a single-run gate would promote
  assert.equal(decide({ a, b, k: 3, n: 3, tasks: derm.tasks }).promote, false);
});
