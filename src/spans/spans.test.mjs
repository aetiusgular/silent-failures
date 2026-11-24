// Lane P3b unit tests for the span mappings (contracts/api.md), beyond the red tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toOtlp, toTargetTrace, unixNano } from "./index.mjs";

const golden = () => JSON.parse(readFileSync(new URL("../../fixtures/traces/run1.joined.json", import.meta.url), "utf8"));
const spansOf = (o) => o.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
const attr = (x, key) => {
  const a = (x.attributes ?? []).find((y) => y.key === key);
  return a ? Object.values(a.value)[0] : undefined;
};
const eff = (kind, ts, extra = {}) => ({ source: "strace", ok: true, kind, ts, pid: 1, ...extra });
const call = (id, ts_start, ts_end, extra = {}) => ({ id, name: "bash", input: {}, output: "", ts_start, ts_end, effects: [], ...extra });
const run = (calls, unattributed = [], procs = []) => ({ run_id: "r", root_pid: 1, calls, unattributed, procs });

test("both mappings are deterministic and JSON-serialisable (no BigInt left in the output)", () => {
  const a = JSON.stringify(toOtlp(golden()));
  assert.equal(a, JSON.stringify(toOtlp(golden())));
  const b = JSON.stringify(toTargetTrace(golden()));
  assert.equal(b, JSON.stringify(toTargetTrace(golden())));
});

test("unixNano rounds to the microsecond and keeps nanosecond precision past 2^53", () => {
  assert.equal(unixNano(1764000100.05), "1764000100050000000");
  assert.equal(unixNano(1764000100.1234567), "1764000100123457000");
  assert.equal(unixNano(0), "0");
  assert.throws(() => unixNano(null), /bad timestamp/);
  assert.throws(() => unixNano(Number.NaN), /bad timestamp/);
});

test("span ids are unique across root, calls and unattributed", () => {
  for (const out of [spansOf(toOtlp(golden())).map((s) => s.spanId), allTargetIds(toTargetTrace(golden()))]) {
    assert.equal(new Set(out).size, out.length);
  }
});

function allTargetIds(t) {
  const ids = [];
  const walk = (spans) => spans.forEach((s) => (ids.push(s.id), walk(s.spans ?? [])));
  walk(t.spans);
  return ids;
}

test("call ids that look like the root or unattributed span do not collide with them", () => {
  const ids = spansOf(toOtlp(run([call("root", 1, 2), call("unattributed", 2, 3)]))).map((s) => s.spanId);
  assert.equal(new Set(ids).size, 4);
});

test("duplicate tool call ids are refused, not silently merged", () => {
  const j = run([call("c1", 1, 2), call("c1", 3, 4)]);
  assert.throws(() => toOtlp(j), /duplicate tool call id/);
  assert.throws(() => toTargetTrace(j), /duplicate tool call id/);
});

test("the root span covers every call window, effect and process lifetime", () => {
  const g = golden();
  const spans = spansOf(toOtlp(g));
  const root = spans.find((s) => !s.parentSpanId);
  assert.equal(root.name, "invoke_agent");
  for (const s of spans) {
    assert.ok(BigInt(s.startTimeUnixNano) >= BigInt(root.startTimeUnixNano), s.name);
    assert.ok(BigInt(s.endTimeUnixNano) <= BigInt(root.endTimeUnixNano), s.name);
    for (const e of s.events) {
      assert.ok(BigInt(e.timeUnixNano) <= BigInt(root.endTimeUnixNano));
    }
  }
  // The root pid exits at 1764000106, after the last call: the root ends there.
  assert.equal(root.endTimeUnixNano, unixNano(1764000106));
});

test("an effect by a child that outlives its call is kept on the call, with its own time", () => {
  // c2's unlink at 1764000103.51 is after c2 ended at 1764000102.
  const c2 = spansOf(toOtlp(golden())).find((s) => attr(s, "gen_ai.tool.call.id") === "c2");
  const unlink = c2.events.find((e) => e.name === "effect.unlink");
  assert.equal(unlink.timeUnixNano, unixNano(1764000103.51));
});

test("the unattributed span is present and empty when nothing is unattributed", () => {
  const o = spansOf(toOtlp(run([call("a", 1, 2)])));
  const u = o.filter((s) => s.name === "unattributed");
  assert.equal(u.length, 1);
  assert.deepEqual(u[0].events, []);
  assert.equal(attr(u[0], "sf.unattributed"), true);
  const t = toTargetTrace(run([call("a", 1, 2)])).spans.filter((s) => s.name === "unattributed");
  assert.equal(t.length, 1);
  assert.deepEqual(t[0].spans, []);
});

test("a run with no calls and no effects still gives a root and an unattributed span", () => {
  const o = spansOf(toOtlp(run([])));
  assert.deepEqual(o.map((s) => s.name), ["invoke_agent", "unattributed"]);
  assert.deepEqual(toTargetTrace(run([])).spans.map((s) => s.name), ["unattributed"]);
});

test("rename events carry the target path, failed effects carry the errno, exec events carry argv", () => {
  const j = run([
    call("a", 1, 2, {
      effects: [
        eff("rename", 1.1, { path: "/w/a", path2: "/w/b" }),
        eff("open", 1.2, { ok: false, errno: "ENOENT", path: "/w/x", flags: ["O_RDONLY"] }),
        eff("exec", 1.3, { path: "/bin/sh", argv: ["sh", "-c", "true"] }),
      ],
    }),
  ]);
  const [ren, open, exec] = spansOf(toOtlp(j)).find((s) => s.name === "execute_tool bash").events;
  assert.equal(attr(ren, "effect.path2"), "/w/b");
  assert.equal(attr(open, "effect.ok"), false);
  assert.equal(attr(open, "effect.errno"), "ENOENT");
  assert.deepEqual(exec.attributes.find((a) => a.key === "effect.argv").value, {
    arrayValue: { values: [{ stringValue: "sh" }, { stringValue: "-c" }, { stringValue: "true" }] },
  });

  const t = toTargetTrace(j).spans[0].spans;
  assert.equal(t[0].attributes["effect.path2"], "/w/b");
  assert.equal(t[1].status, "ERROR");
  assert.equal(t[1].error, "ENOENT");
  assert.ok(!Object.hasOwn(t[0], "status"));
  assert.deepEqual(t[2].attributes["effect.argv"], ["sh", "-c", "true"]);
});

test("written bytes never leave the recorder in either output", () => {
  const j = run([call("a", 1, 2, { effects: [eff("write", 1.1, { path: "/w/s", bytes: "token=hunter2\n", n: 14 })] })]);
  assert.ok(!JSON.stringify(toOtlp(j)).includes("hunter2"));
  assert.ok(!JSON.stringify(toTargetTrace(j)).includes("hunter2"));
});

test("a call with no error has no status; an empty output is still an output", () => {
  const o = spansOf(toOtlp(golden())).find((s) => attr(s, "gen_ai.tool.call.id") === "c2");
  assert.ok(!Object.hasOwn(o, "status"));
  const t = toTargetTrace(golden()).spans.find((s) => s.id === o.spanId);
  assert.equal(t.output, "");
  assert.ok(!Object.hasOwn(t, "error"));
});

test("a log line with both output and error maps to error only", () => {
  const j = run([call("a", 1, 2, { output: "partial", error: "exit 1" })]);
  const t = toTargetTrace(j).spans[0];
  assert.equal(t.error, "exit 1");
  assert.equal(t.status, "ERROR");
  assert.ok(!Object.hasOwn(t, "output"));
  assert.equal(spansOf(toOtlp(j))[1].status.code, 2);
});

test("target spans carry parent ids, so the tree can be sent flat as the target's ingest expects", () => {
  const t = toTargetTrace(golden());
  for (const tool of t.spans.filter((s) => s.type === "tool")) {
    assert.ok(!Object.hasOwn(tool, "parent_id"), "top-level children attach under the target's root");
    for (const child of tool.spans) assert.equal(child.parent_id, tool.id);
  }
  const u = t.spans.find((s) => s.name === "unattributed");
  for (const child of u.spans) assert.equal(child.parent_id, u.id);
  assert.equal(t.id, "fixture-run1");
  assert.equal(t.started_at, "2025-11-24T16:01:40.050Z");
  assert.equal(t.ended_at, "2025-11-24T16:01:46.000Z");
});

test("tool span ids match the OTLP span ids for the same call", () => {
  const g = golden();
  const o = spansOf(toOtlp(g));
  for (const tool of toTargetTrace(g).spans.filter((s) => s.type === "tool")) {
    const s = o.find((x) => x.spanId === tool.id);
    assert.equal(attr(s, "gen_ai.tool.call.id"), tool.attributes["gen_ai.tool.call.id"]);
  }
});

test("bad input is refused with a message, not a crash deep inside", () => {
  assert.throws(() => toOtlp(null), /JoinedRun expected/);
  assert.throws(() => toOtlp({ run_id: "", calls: [], unattributed: [] }), /run_id/);
  assert.throws(() => toTargetTrace({ run_id: "r", calls: [] }), /unattributed/);
});

test("SL-P3b-r1-C1: a run with 200k effects maps without overflowing the stack", () => {
  const effects = Array.from({ length: 200000 }, (_, i) => eff("write", 1 + i * 1e-6, { path: "/w/a" }));
  const j = run([call("a", 1, 2, { effects })], effects.slice(0, 1000));
  const o = spansOf(toOtlp(j));
  assert.equal(o.find((s) => s.name === "execute_tool bash").events.length, 200000);
  assert.equal(o[0].endTimeUnixNano, unixNano(2));
  assert.equal(toTargetTrace(j).spans[0].spans.length, 200000);
});

test("SL-P3b-r1-C2: a call id holding a NUL cannot collide with another span's effect ids", () => {
  const j = run(
    [
      call("\u0000unattributed", 1, 2, { effects: [eff("write", 1.1, { path: "/p" })] }),
      call("a\u00000", 2, 3, { effects: [eff("write", 2.1, { path: "/p" })] }),
      call("a", 3, 4, { effects: [eff("write", 3.1, { path: "/p" })] }),
    ],
    [eff("write", 1.2, { path: "/p" })],
  );
  const ids = allTargetIds(toTargetTrace(j));
  assert.equal(ids.length, 8);
  assert.equal(new Set(ids).size, ids.length);
});
