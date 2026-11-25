// P4: one test per applied Request for integration that changed behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStrace } from "../../src/recorder/index.mjs";
import { join } from "../../src/join/index.mjs";
import { toOtlp, toTargetTrace, toTargetPayload } from "../../src/spans/index.mjs";
import { checkRun } from "../../src/check/index.mjs";

const PROJECT = "00000000-0000-4000-8000-000000000000";

test("#7: truncate and ftruncate are truncate effects with their size", () => {
  const text = [
    '100 1764000000.100000 openat(AT_FDCWD, "a.txt", O_WRONLY|O_CREAT, 0666) = 3',
    "100 1764000000.200000 ftruncate(3, 0) = 0",
    '100 1764000000.300000 truncate("b.txt", 7) = 0',
    '100 1764000000.400000 truncate("gone.txt", 0) = -1 ENOENT (No such file or directory)',
    "100 1764000000.500000 ftruncate(9, 0) = 0",
  ].join("\n");
  const t = parseStrace(text, { cwd: "/w" }).effects.filter((e) => e.kind === "truncate");
  assert.deepEqual(
    t.map((e) => [e.path, e.size, e.ok]),
    [["/w/a.txt", 0, true], ["/w/b.txt", 7, true], ["/w/gone.txt", 0, false]],
  );
});

const run = (effects) => ({ run_id: "r", root_pid: 1, calls: [], unattributed: effects, procs: [] });
const w = (ts, path, bytes) => ({ kind: "write", ts, pid: 1, ok: true, source: "strace", path, bytes, n: Buffer.byteLength(bytes) });
const tr = (ts, path, size) => ({ kind: "truncate", ts, pid: 1, ok: true, source: "strace", path, size });
const task = { expected_effects: [{ kind: "write", path: "f.txt", content: "^port = 9090$" }] };
const check = (effects, setup) =>
  checkRun({ finalText: "Done.", joined: run(effects), task: { ...task, setup: { files: setup ?? {} } }, ctx: { workDir: "/w", stubs: {} } });

test("#7: a truncate after the write is replayed in checkRun", () => {
  assert.equal(check([w(1, "/w/f.txt", "port = 9090")]).label, "true_success");
  assert.deepEqual(check([w(1, "/w/f.txt", "port = 9090"), tr(2, "/w/f.txt", 0)]).contradicted, [0]);
  // Cut to 4 bytes of known content (the run created the file): "port" fails the regex.
  const create = { kind: "open", ts: 0.5, pid: 1, ok: true, source: "strace", path: "/w/f.txt", flags: ["O_WRONLY", "O_CREAT"] };
  assert.deepEqual(check([create, w(1, "/w/f.txt", "port = 9090"), tr(2, "/w/f.txt", 4)]).contradicted, [0]);
  // The same cut on a file the run did not create and the setup does not list: unknown, not contradicted.
  assert.deepEqual(check([w(1, "/w/f.txt", "port = 9090"), tr(2, "/w/f.txt", 4)]).contradicted, []);
  // A setup file is known content too.
  assert.deepEqual(check([tr(1, "/w/f.txt", 4), w(2, "/w/f.txt", "")], { "f.txt": "port = 9090" }).contradicted, [0]);
  // A truncate alone is not a write.
  assert.deepEqual(check([tr(1, "/w/f.txt", 0)], { "f.txt": "port = 9090" }).missing, [0]);
  // A truncate to a non-zero size of content the trace never saw stays unknown, so it is not contradicted.
  assert.equal(check([{ ...w(1, "/w/f.txt", ""), bytes: undefined }, tr(2, "/w/f.txt", 3)]).label, "true_success");
});

test("#6: a write with no bytes is unknown content, not empty", () => {
  const cp = { kind: "write", ts: 1, pid: 1, ok: true, source: "strace", path: "/w/f.txt", n: 11 };
  assert.equal(check([cp]).label, "true_success");
});

test("#8/#9: toTargetPayload is the flat ingest body", () => {
  const joined = {
    run_id: "r1",
    root_pid: 1,
    calls: [{ id: "c1", name: "bash", input: { command: "x" }, output: "ok", ts_start: 1, ts_end: 2, effects: [w(1.5, "/w/f.txt", "hi")] }],
    unattributed: [tr(3, "/w/g.txt", 0)],
    procs: [],
  };
  const p = toTargetPayload(joined, { projectId: PROJECT, input: "do it", error: "agent crashed", output: "ignored" });
  assert.equal(p.project_id, PROJECT);
  assert.equal(p.trace.id, "r1");
  assert.equal(p.trace.name, "invoke_agent");
  assert.equal(p.trace.input, "do it");
  assert.equal(p.trace.status, "ERROR");
  assert.equal(p.trace.error, "agent crashed");
  assert.equal("output" in p.trace, false);
  assert.deepEqual(p.trace.spans.map((s) => [s.name, s.parent_id ?? null]), [
    ["bash", null],
    ["effect.write", toTargetTrace(joined).spans[0].id],
    ["unattributed", null],
    ["effect.truncate", toTargetTrace(joined).spans[1].id],
  ]);
  assert.equal(p.trace.spans[3].attributes["effect.size"], 0);
  assert.throws(() => toTargetPayload(joined, { projectId: "not-a-uuid" }), /UUID/);
  assert.throws(() => toTargetPayload(joined), /UUID/);
});

test("#8: OTLP events carry effect.size and never bytes", () => {
  const joined = join({ runId: "r", rootPid: 1, calls: [], effects: [tr(1, "/w/g.txt", 5), w(2, "/w/g.txt", "secret")], procs: [] });
  const ev = toOtlp(joined).resourceSpans[0].scopeSpans[0].spans.at(-1).events;
  assert.deepEqual(ev[0].attributes.find((a) => a.key === "effect.size").value, { intValue: "5" });
  assert.ok(!JSON.stringify(ev).includes("secret"));
});
