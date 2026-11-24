// Lane P3a red tests: recorder and join. Corner cases from SPEC.md "Lanes".
import assert from "node:assert/strict";
import { parseStrace, parseAudit, mergeEffects, costReport } from "../../../src/recorder/index.mjs";
import { join } from "../../../src/join/index.mjs";
import { json, text, at, projection } from "./fixtures.mjs";

const strace = () => parseStrace(text("fixtures/traces/run1.strace"), { cwd: "/work" });
const audit = () => parseAudit(text("fixtures/traces/run1.audit.log"));
const golden = () => json("fixtures/traces/run1.joined.json");
const goldenEffects = (g, source) =>
  [...g.calls.flatMap((c) => c.effects), ...g.unattributed].filter((e) => !source || e.source === source);
const key = (e) => `${e.kind}|${e.path ?? e.addr ?? ""}|${e.path2 ?? ""}|${e.pid}|${e.ok}`;
const find = (effects, pred, what) => {
  const hit = effects.filter(pred);
  assert.equal(hit.length, 1, `expected exactly one ${what}, got ${hit.length}`);
  return hit[0];
};

function joinInput() {
  const g = golden();
  const c = json("fixtures/traces/run1.calls.json");
  return { runId: c.run_id, rootPid: c.root_pid, calls: c.calls, effects: goldenEffects(g).sort((a, b) => a.ts - b.ts), procs: g.procs };
}

export default {
  // strace effects of every kind, with paths made absolute against the run's cwd.
  "a-strace-effects": () => {
    const { effects } = strace();
    assert.deepEqual(effects.map(key).sort(), goldenEffects(golden(), "strace").map(key).sort());
  },
  // -xx hex strings decode to the bytes written.
  "a-strace-hex-decode": () => {
    const w = find(strace().effects, (e) => e.kind === "write" && e.pid === 1000, "root write");
    assert.equal(w.bytes, "[server]\nport = 9090\n");
    assert.equal(w.n, 21);
  },
  // `<unfinished ...>` and `<... resumed>` halves form one effect, timed at the call's start.
  "a-strace-unfinished": () => {
    const o = find(strace().effects, (e) => e.kind === "open" && e.path === "/work/out/check.log", "check.log open");
    assert.equal(o.pid, 1001);
    assert.equal(o.ok, true);
    assert.equal(o.ts, at(1.02));
  },
  // A failed syscall is kept as ok:false with its errno; it is not an effect that happened.
  "a-strace-failed-syscall": () => {
    const o = find(strace().effects, (e) => e.path === "/work/missing.txt", "missing.txt open");
    assert.equal(o.ok, false);
    assert.equal(o.errno, "ENOENT");
  },
  // fd 1 in pid 1002 is out/check.log: dup2 in the parent, inherited through clone.
  "a-strace-fd-inherit": () => {
    const w = find(strace().effects, (e) => e.kind === "write" && e.pid === 1002, "child write");
    assert.equal(w.path, "/work/out/check.log");
    assert.equal(w.bytes, "PASS\n");
  },
  // Relative paths resolve against the process's cwd after chdir.
  "a-strace-cwd": () => {
    const u = find(strace().effects, (e) => e.kind === "unlink", "unlink");
    assert.equal(u.path, "/work/logs/a.log");
    assert.equal(u.pid, 1003);
  },
  // The process tree comes from clone results and exit lines.
  "a-strace-procs": () => {
    const { procs } = strace();
    const by = Object.fromEntries(procs.map((p) => [p.pid, p]));
    assert.equal(by[1001].ppid, 1000);
    assert.equal(by[1002].ppid, 1001);
    assert.equal(by[1003].ppid, 1001);
    assert.equal(by[1003].ts_start, at(1.3));
    assert.equal(by[1003].ts_end, at(3.52));
  },
  // io_uring opens are invisible to strace; the audit rule supplies them.
  "a-audit-iouring-open": () => {
    const o = find(audit(), (e) => e.kind === "open", "io_uring open");
    assert.equal(o.path, "/work/data/rates.json");
    assert.equal(o.source, "audit-io_uring");
    assert.equal(o.pid, 1000);
    assert.equal(o.ts, at(4.5));
    assert.equal(o.created, true);
    assert.equal(o.ok, true);
  },
  // io_uring connect with success=no is kept as a failed connect, address decoded from SOCKADDR.
  "a-audit-iouring-connect": () => {
    const c = find(audit(), (e) => e.kind === "connect", "io_uring connect");
    assert.equal(c.addr, "127.0.0.1:40959");
    assert.equal(c.ok, false);
    assert.equal(c.errno, "ECONNREFUSED");
  },
  // Merged effects keep both sources and come out in time order.
  "a-merge-order": () => {
    const m = mergeEffects(strace().effects, audit());
    assert.equal(m.length, goldenEffects(golden()).length);
    for (let i = 1; i < m.length; i++) assert.ok(m[i - 1].ts <= m[i].ts, "not sorted by ts");
    assert.ok(m.some((e) => e.source === "audit-io_uring"));
  },
  // An effect inside a call's window by the agent's own process is that call's.
  "a-join-window": () => {
    const j = join(joinInput());
    const c1 = j.calls.find((c) => c.id === "c1");
    assert.deepEqual(c1.effects.map((e) => e.path).sort(), ["/work/app/config.toml", "/work/app/config.toml", "/work/missing.txt"]);
  },
  // A child spawned during a call that acts after the call ended is still that call's.
  "a-join-child-outlives": () => {
    const j = join(joinInput());
    const c2 = j.calls.find((c) => c.id === "c2");
    assert.ok(c2.effects.some((e) => e.kind === "unlink" && e.path === "/work/logs/a.log" && e.ts > c2.ts_end), "late child unlink not credited to c2");
    assert.ok(!j.unattributed.some((e) => e.kind === "unlink"));
  },
  // Effects outside every window and tree go on unattributed; none are dropped.
  "a-join-unattributed": () => {
    const input = joinInput();
    const j = join(input);
    assert.deepEqual(j.unattributed.map((e) => e.path), ["/work/stray.txt"]);
    const total = j.calls.reduce((s, c) => s + c.effects.length, 0) + j.unattributed.length;
    assert.equal(total, input.effects.length);
  },
  // The whole join matches the golden file.
  "a-join-golden": () => {
    assert.deepEqual(projection(join(joinInput())), projection(golden()));
  },
  // The recorder reports its own cost: medians and the median per-task ratio.
  "a-cost-report": () => {
    const r = costReport(json("fixtures/cost-samples.json").samples);
    assert.equal(r.n, 5);
    assert.equal(r.median_traced_ms, 1500);
    assert.equal(r.median_untraced_ms, 1200);
    assert.equal(r.overhead_ratio, 1.3);
  },
};
