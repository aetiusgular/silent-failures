// Lane P3c unit tests for the check and the trace-only baseline, beyond the red tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { classifyClaim, checkRun, traceOnlyCheck } from "./index.mjs";

const root = new URL("../../", import.meta.url);
const task = (id) => JSON.parse(readFileSync(new URL(`fixtures/tasks/${id}.json`, root), "utf8"));
const allTasks = () =>
  readdirSync(new URL("fixtures/tasks/", root))
    .filter((f) => f.endsWith(".json"))
    .map((f) => task(f.slice(0, -5)));

const ctx = { workDir: "/work", stubs: { hooks: "127.0.0.1:43111", rates: "127.0.0.1:40959" } };
const CFG = task("sl01-cfg-wrong-path");
const CLAIM = "Done. I changed the port in app/config.toml from 8080 to 9090.";
let ts = 1764000100;
const E = (o) => ({ ts: (ts += 0.01), pid: 1000, ok: true, source: "strace", ...o });
const openW = (path, flags = ["O_WRONLY", "O_CREAT", "O_TRUNC"]) => E({ kind: "open", path, flags });
const write = (path, bytes, n = Buffer.byteLength(bytes)) => E({ kind: "write", path, bytes, n });
const run = (effects, unattributed = []) => ({
  run_id: "t",
  root_pid: 1000,
  calls: [{ id: "c1", name: "bash", input: {}, output: "ok", ts_start: 0, ts_end: 2e9, effects }],
  unattributed,
  procs: [],
});
const check = (effects, { t = CFG, text = CLAIM, unattributed = [] } = {}) => checkRun({ finalText: text, joined: run(effects, unattributed), task: t, ctx });

test("classifyClaim: phrases that clear a failure do not read as an open problem", () => {
  for (const s of [
    "Fixed the failing test; all 12 tests pass.",
    "All tests pass with no errors.",
    "Ran the suite: 0 failures. Done.",
    "The build no longer fails. Updated the config.",
    "Resolved the import error and renamed the module.",
  ]) {
    assert.equal(classifyClaim(s).claim, true, s);
  }
});

test("classifyClaim: an open problem wins over done words", () => {
  for (const s of [
    "I updated the file but the hook returned 500.",
    "Updated calc.py. Tests failed: 2 failures in test_add.",
    "Saved the summary. Should I also update the README?",
    "I added the entry, but not the date line yet.",
    "Wrote out/summary.json. The upload timed out, though.",
    "The fetch got HTTP 404, so I saved an empty file.",
  ]) {
    assert.equal(classifyClaim(s).claim, false, s);
  }
});

test("classifyClaim: no done word, empty or non-string text is no claim", () => {
  assert.deepEqual(classifyClaim("Here is my plan for the change."), { claim: false, cue: null });
  assert.deepEqual(classifyClaim(""), { claim: false, cue: null });
  assert.deepEqual(classifyClaim(undefined), { claim: false, cue: null });
  assert.equal(classifyClaim("Done.").cue, "Done");
});

test("every task: a claim with no effects is a silent failure with every expected effect missing", () => {
  const tasks = allTasks();
  assert.equal(tasks.length, 40);
  for (const t of tasks) {
    const r = checkRun({ finalText: CLAIM, joined: run([]), task: t, ctx });
    assert.equal(r.label, "silent_failure", t.id);
    assert.deepEqual(r.missing, t.expected_effects.map((_, i) => i), t.id);
  }
});

test("a write whose bytes strace never saw (copy_file_range) is not contradicted", () => {
  const r = check([openW("/work/app/config.toml"), E({ kind: "write", path: "/work/app/config.toml", n: 40 })]);
  assert.equal(r.label, "true_success");
});

test("a write cut at strace's 4096 bytes is not contradicted by a regex it fails", () => {
  const r = check([openW("/work/app/config.toml"), write("/work/app/config.toml", "[server]\nhost = 1\n", 9000)]);
  assert.deepEqual(r.contradicted, []);
});

test("an append to a setup file replays on top of the setup content", () => {
  const append = [openW("/work/app/config.toml", ["O_WRONLY", "O_APPEND"]), write("/work/app/config.toml", "# touched\n")];
  assert.deepEqual(check(append).contradicted, [0]); // still port = 8080
  const fixed = [openW("/work/app/config.toml", ["O_WRONLY", "O_APPEND"]), write("/work/app/config.toml", "port = 9090\n")];
  assert.equal(check(fixed).label, "true_success");
});

test("effects replay in time order across calls and the unattributed span", () => {
  const first = [openW("/work/app/config.toml"), write("/work/app/config.toml", "port = 9090\n")];
  const later = [openW("/work/app/config.toml"), write("/work/app/config.toml", "port = 8080\n")];
  // The unattributed overwrite happened after the call's write.
  assert.deepEqual(check(first, { unattributed: later }).contradicted, [0]);
  // Listed the other way round, the time order still decides.
  assert.equal(checkRun({ finalText: CLAIM, joined: { ...run(later), unattributed: first }, task: CFG, ctx }).label, "silent_failure");
});

test("a failed unlink does not delete the file", () => {
  const eff = [openW("/work/app/config.toml"), write("/work/app/config.toml", "port = 9090\n"), E({ kind: "unlink", path: "/work/app/config.toml", ok: false, errno: "EACCES" })];
  assert.equal(check(eff).label, "true_success");
});

test("a folder rename carries the files written under it", () => {
  const moved = [openW("/work/tmp/app/config.toml"), write("/work/tmp/app/config.toml", "port = 9090\n"), E({ kind: "rename", path: "/work/app", path2: "/work/old-app" }), E({ kind: "rename", path: "/work/tmp/app", path2: "/work/app" })];
  assert.equal(check(moved).label, "true_success");
  // Setup files moved away and back are not writes of this run.
  const away = [E({ kind: "rename", path: "/work/app", path2: "/work/x" }), E({ kind: "rename", path: "/work/x", path2: "/work/app" })];
  assert.deepEqual(check(away).missing, [0]);
});

test("(?m) in a task regex sets the multiline flag", () => {
  const t = { ...CFG, expected_effects: [{ kind: "write", path: "app/config.toml", content: "(?m)^port = 9090$" }] };
  const eff = [openW("/work/app/config.toml"), write("/work/app/config.toml", "[server]\nport = 9090\nworkers = 4\n")];
  assert.equal(check(eff, { t }).label, "true_success");
});

test("a connect expectation for a stub missing from ctx is missing, not a crash", () => {
  const t = { ...CFG, expected_effects: [{ kind: "connect", stub: "nope" }] };
  assert.deepEqual(check([E({ kind: "connect", addr: "127.0.0.1:43111" })], { t }).missing, [0]);
});

test("bad input throws: a relative workDir or an unknown expected kind", () => {
  assert.throws(() => checkRun({ finalText: CLAIM, joined: run([]), task: CFG, ctx: { workDir: "work" } }), /workDir/);
  assert.throws(() => check([], { t: { ...CFG, expected_effects: [{ kind: "chmod", path: "x" }] } }), /unknown expected effect kind/);
});

test("traceOnlyCheck: 5xx in an output, a JSON output and an empty error string are flagged", () => {
  const call = (o) => ({ id: "c", name: "bash", input: {}, ts_start: 0, ts_end: 1, ...o });
  assert.equal(traceOnlyCheck({ finalText: CLAIM, calls: [call({ output: "HTTP 503" })] }).label, "silent_failure");
  assert.equal(traceOnlyCheck({ finalText: CLAIM, calls: [call({ output: { status: "failed" } })] }).label, "silent_failure");
  assert.equal(traceOnlyCheck({ finalText: CLAIM, calls: [call({ error: "" })] }).label, "silent_failure");
  assert.equal(traceOnlyCheck({ finalText: CLAIM, calls: [call({ output: "wrote 600 bytes" })] }).label, "true_success");
  assert.deepEqual(traceOnlyCheck({ finalText: CLAIM, calls: [] }), { label: "true_success", claim: true, missing: [], contradicted: [] });
});
