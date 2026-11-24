// Lane P3a unit tests for the join rule (contracts/types.md), beyond the red tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "./index.mjs";

const call = (id, ts_start, ts_end) => ({ id, name: "bash", input: {}, output: "", ts_start, ts_end });
const eff = (pid, ts, path) => ({ source: "strace", ok: true, kind: "open", ts, pid, path, flags: [] });
const proc = (pid, ppid, ts_start, ts_end = null) => ({ pid, ppid, ts_start, ts_end });
const ids = (j) => Object.fromEntries([...j.calls.map((c) => [c.id, c.effects.map((e) => e.path)]), ["un", j.unattributed.map((e) => e.path)]]);

test("overlapping windows: root effects go to the call that started last", () => {
  const j = join({
    runId: "r",
    rootPid: 1,
    calls: [call("a", 0, 10), call("b", 5, 8)],
    effects: [eff(1, 4, "/a"), eff(1, 6, "/b"), eff(1, 9, "/a2")],
    procs: [proc(1, null, null)],
  });
  assert.deepEqual(ids(j), { a: ["/a", "/a2"], b: ["/b"], un: [] });
});

test("window edges are inclusive, for root effects and for spawns", () => {
  const j = join({
    runId: "r",
    rootPid: 1,
    calls: [call("a", 1, 2)],
    effects: [eff(1, 1, "/start"), eff(1, 2, "/end"), eff(2, 50, "/child")],
    procs: [proc(1, null, null), proc(2, 1, 2)],
  });
  assert.deepEqual(ids(j), { a: ["/start", "/end", "/child"], un: [] });
});

test("a grandchild follows its parent; a child spawned between calls is unattributed with its tree", () => {
  const j = join({
    runId: "r",
    rootPid: 1,
    calls: [call("a", 1, 2), call("b", 5, 6)],
    effects: [eff(3, 7, "/grand"), eff(4, 3.5, "/between"), eff(5, 5.5, "/between-kid")],
    procs: [proc(1, null, null), proc(2, 1, 1.5), proc(3, 2, 1.8), proc(4, 1, 3), proc(5, 4, 5.2)],
  });
  assert.deepEqual(ids(j), { a: ["/grand"], b: [], un: ["/between", "/between-kid"] });
});

test("an effect by a pid with no proc record is unattributed, never dropped", () => {
  const input = {
    runId: "r",
    rootPid: 1,
    calls: [call("a", 0, 10)],
    effects: [eff(99, 5, "/ghost"), eff(1, 5, "/root")],
    procs: [proc(1, null, null)],
  };
  const j = join(input);
  assert.deepEqual(ids(j), { a: ["/root"], un: ["/ghost"] });
  assert.equal(j.calls[0].effects.length + j.unattributed.length, input.effects.length);
});

test("a parent loop in procs does not hang the join", () => {
  const j = join({
    runId: "r",
    rootPid: 1,
    calls: [call("a", 0, 10)],
    effects: [eff(2, 5, "/loop")],
    procs: [proc(1, null, null), proc(2, 3, 1), proc(3, 2, 1)],
  });
  assert.deepEqual(ids(j), { a: [], un: ["/loop"] });
});

test("the output keeps run id, call order and fields, and does not mutate the input", () => {
  const calls = [call("x", 3, 4), call("y", 1, 2)];
  const input = { runId: "run-7", rootPid: 1, calls, effects: [eff(1, 1.5, "/y")], procs: [proc(1, null, null)] };
  const before = JSON.stringify(input);
  const j = join(input);
  assert.equal(j.run_id, "run-7");
  assert.equal(j.root_pid, 1);
  assert.deepEqual(j.calls.map((c) => c.id), ["x", "y"]);
  assert.equal(j.calls[1].name, "bash");
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(j.procs, input.procs);
});
