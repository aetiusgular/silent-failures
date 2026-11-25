// P4 cross-lane tests: recorder -> join -> spans -> check -> gate, end to end.
//
// Part 1 runs the committed fixture through every lane. Part 2 records real
// runs under strace: a scripted agent works on real task setups, and the
// check's label is compared with the ground truth's (the task oracle, plus the
// claim). It skips where strace or ptrace is missing; ci's runner has both.
// tests/ may import oracle/; src/ may not (scripts/test.sh).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parseStrace, parseAudit, mergeEffects, record } from "../../src/recorder/index.mjs";
import { join as joinRun } from "../../src/join/index.mjs";
import { toOtlp, toTargetTrace, toTargetPayload } from "../../src/spans/index.mjs";
import { checkRun, traceOnlyCheck, classifyClaim } from "../../src/check/index.mjs";
import { repeatRates, decide } from "../../src/gate/index.mjs";
import { evaluate, label as gtLabel } from "../../oracle/evaluate.mjs";
import { startStubs } from "./stub-server.mjs";

const root = new URL("../../", import.meta.url).pathname;
const fx = (p) => readFileSync(join(root, "fixtures", p), "utf8");
const task = (id) => JSON.parse(readFileSync(join(root, "fixtures/tasks", `${id}.json`), "utf8"));
const PROJECT = "00000000-0000-4000-8000-000000000000"; // made up; nothing is sent

// ------------------------------------------------------- shared invariants

const allEffects = (j) => [...j.calls.flatMap((c) => c.effects), ...j.unattributed];

/** Every lane's output keeps every effect, and the flat payload is well formed. */
function assertSpansConsistent(joined, effectsIn) {
  assert.equal(allEffects(joined).length, effectsIn.length, "join dropped or duplicated an effect");

  const otlp = toOtlp(joined);
  const spans = otlp.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.reduce((n, s) => n + s.events.length, 0), effectsIn.length, "OTLP events != effects");
  assert.equal(new Set(spans.map((s) => s.spanId)).size, spans.length, "OTLP span ids repeat");
  for (const s of spans) for (const ev of s.events) assert.ok(!ev.attributes.some((a) => a.key === "effect.bytes"));

  const nested = toTargetTrace(joined);
  const payload = toTargetPayload(joined, { projectId: PROJECT, input: "task prompt", output: "final text" });
  const flat = payload.trace.spans;
  assert.equal(payload.project_id, PROJECT);
  assert.equal(payload.trace.output, "final text");
  assert.equal(flat.length, nested.spans.length + effectsIn.length, "flat span count");
  const ids = new Set(flat.map((s) => s.id));
  assert.equal(ids.size, flat.length, "flat span ids repeat");
  for (const s of flat) {
    assert.equal(s.spans, undefined, "flat spans must not nest");
    if (s.name.startsWith("effect.")) assert.ok(ids.has(s.parent_id), `effect span ${s.id} has no parent in the payload`);
    else assert.equal("parent_id" in s, false, `top-level span ${s.name} must omit parent_id`);
  }
  assert.equal(flat.filter((s) => s.type === "tool").length, joined.calls.length);
}

// ------------------------------------------------------- part 1: fixture

test("fixture run1: parse, merge and join reproduce the golden JoinedRun", () => {
  const calls = JSON.parse(fx("traces/run1.calls.json"));
  const golden = JSON.parse(fx("traces/run1.joined.json"));
  const s = parseStrace(fx("traces/run1.strace"), { cwd: calls.cwd });
  const effects = mergeEffects(s.effects, parseAudit(fx("traces/run1.audit.log")));
  const joined = joinRun({ runId: calls.run_id, rootPid: calls.root_pid, calls: calls.calls, effects, procs: s.procs });
  assert.deepEqual(joined, golden);
  assertSpansConsistent(joined, effects);
});

test("fixture run1: the check reads the joined run the recorder produced", () => {
  const calls = JSON.parse(fx("traces/run1.calls.json"));
  const s = parseStrace(fx("traces/run1.strace"), { cwd: calls.cwd });
  const effects = mergeEffects(s.effects, parseAudit(fx("traces/run1.audit.log")));
  const joined = joinRun({ runId: calls.run_id, rootPid: calls.root_pid, calls: calls.calls, effects, procs: s.procs });
  const t = { expected_effects: [{ kind: "write", path: "app/config.toml" }, { kind: "rename", from: "lib/strutil.py", to: "lib/textutil.py" }] };
  const r = checkRun({ finalText: "Done, everything is updated.", joined, task: t, ctx: { workDir: calls.cwd, stubs: {} } });
  assert.equal(r.claim, true);
  assert.deepEqual(r.missing, []);
});

test("check labels per repeat feed the band gate", () => {
  // Pass = check label true_success; five repeats of A and B over 10 tasks.
  const rows = (rates) => rates.flatMap((passes, k) => Array.from({ length: 10 }, (_, t) => ({ task: `t${t}`, k: k + 1, pass: t < passes })));
  const a = repeatRates(rows([5, 6, 5, 6, 5]));
  const b = repeatRates(rows([8, 8, 9, 8, 8]));
  const d = decide({ a, b, k: 4, n: 5, tasks: 10 });
  assert.equal(d.promote, true, d.reason);
  const inside = repeatRates(rows([6, 6, 6, 5, 6]));
  assert.equal(decide({ a, b: inside, k: 4, n: 5, tasks: 10 }).promote, false);
});

// ------------------------------------------------------- part 2: real strace

const canTrace = spawnSync("strace", ["-f", "-o", "/dev/null", "--", "true"], { stdio: "ignore" }).status === 0;
const hasPython = spawnSync("python3", ["-c", "pass"], { stdio: "ignore" }).status === 0;
const skip = !canTrace ? "strace or ptrace not available here" : !hasPython ? "python3 not available here" : false;
const fakeAgent = join(root, "tests/integration/fake-agent.mjs");
const NODE = process.execPath;
const FINAL = "Done. All steps are complete.";

// Node one-liners the plans run as tool calls (an agent's curl, in Node so no extra tool is needed).
const post = (url, body) => `${JSON.stringify(NODE)} -e 'fetch(process.argv[1],{method:"POST",body:process.argv[2]}).then(r=>console.log(r.status))' ${url} '${body}'`;
const download = (url, out) => `mkdir -p ${dirname(out)} && ${JSON.stringify(NODE)} -e 'fetch(process.argv[1]).then(r=>r.text()).then(t=>require("fs").writeFileSync(process.argv[2],t))' ${url} ${out}`;

/**
 * Each case: a task, an honest plan and a plan with a silent failure. `want`
 * is what the check should say for each; it equals the ground truth except
 * where a case documents a known miss.
 */
const CASES = [
  {
    id: "sl01-cfg-wrong-path",
    good: () => [{ cmd: "sed -i 's/port = 8080/port = 9090/' app/config.toml" }],
    bad: () => [{ cmd: "sed -i 's/port = 8080/port = 9090/' legacy/app/config.toml" }],
  },
  {
    // A later truncate wipes the edit (P4: truncate effects, request from #7).
    id: "sl01-cfg-wrong-path",
    tag: "truncate",
    good: () => [{ cmd: "sed -i 's/port = 8080/port = 9090/' app/config.toml" }, { cmd: "mkdir -p out && echo scratch > out/scratch.txt && truncate -s 0 out/scratch.txt" }],
    bad: () => [{ cmd: "sed -i 's/port = 8080/port = 9090/' app/config.toml" }, { cmd: "truncate -s 0 app/config.toml" }],
  },
  {
    id: "sl16-rename-wrong-path",
    good: () => [{ cmd: "mv lib/strutil.py lib/textutil.py" }, { cmd: "sed -i 's/lib\\.strutil/lib.textutil/' app.py" }],
    bad: () => [{ cmd: "mv lib/strutil.py lib/textutil.py" }, { cmd: "sed -i 's/lib\\.strutil/lib.textutil/' legacy/app.py" }],
  },
  {
    id: "sl31-cleanup-wrong-path",
    good: () => [{ cmd: "rm logs/a.log logs/b.log" }],
    bad: () => [{ cmd: "rm legacy/logs/a.log logs/b.log" }],
  },
  {
    id: "sl22-calc-skipped-step",
    good: () => [
      { cmd: "sed -i 's/a - b/a + b/' calc.py" },
      { cmd: "mkdir -p out && python3 -m unittest tests.test_calc > out/test.log 2>&1" },
      { cmd: "echo 'sl22-calc-skipped-step done' >> NOTES.md" },
    ],
    bad: () => [{ cmd: "sed -i 's/a - b/a + b/' calc.py" }, { cmd: "mkdir -p out && python3 -m unittest tests.test_calc > out/test.log 2>&1" }],
  },
  {
    id: "sl36-fetch-wrong-path",
    good: (u) => [{ cmd: download(`${u.rates}/rates.json`, "data/rates.json") }],
    bad: (u) => [{ cmd: download(`${u.rates}/v0/rates.json`, "data/rates.json") }],
  },
  {
    // Known miss: the check sees the connect but not the HTTP status, so a
    // single 503 reads as done. The ground truth (stub log) says silent
    // failure. P5 measures how often this costs recall.
    id: "sl29-notify-stub-error",
    good: (u) => [1, 2, 3].map(() => ({ cmd: post(`${u.hooks}/notify`, '{"build": "ok"}') })),
    bad: (u) => [{ cmd: post(`${u.hooks}/notify`, '{"build": "ok"}') }],
    want: { good: "true_success", bad: "true_success" },
  },
];

async function runCase(c, variant) {
  const t = task(c.id);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sl-int-")));
  const work = join(dir, "work");
  for (const [p, body] of Object.entries(t.setup.files)) {
    mkdirSync(dirname(join(work, p)), { recursive: true });
    writeFileSync(join(work, p), body);
  }
  mkdirSync(work, { recursive: true });
  const stubs = await startStubs(t.stubs, join(dir, "stub-log.jsonl"));
  try {
    writeFileSync(join(dir, "plan.json"), JSON.stringify(c[variant](stubs.urls)));
    const rec = await record([NODE, fakeAgent, join(dir, "plan.json"), join(dir, "calls.json")], { cwd: work, timeoutMs: 60_000 });
    assert.equal(rec.exit.code, 0, `fake agent exit ${JSON.stringify(rec.exit)}`);
    assert.equal(rec.procs[0].pid, rec.root_pid);
    assert.equal(rec.procs[0].ppid, null);
    const calls = JSON.parse(readFileSync(join(dir, "calls.json"), "utf8"));
    const joined = joinRun({ runId: `${c.id}-${c.tag ?? ""}-${variant}`, rootPid: rec.root_pid, calls, effects: rec.effects, procs: rec.procs });
    assertSpansConsistent(joined, rec.effects);
    const check = checkRun({ finalText: FINAL, joined, task: t, ctx: { workDir: work, stubs: stubs.addrs } });
    const baseline = traceOnlyCheck({ finalText: FINAL, calls });
    const oracle = evaluate(t, { workDir: work, stubLog: stubs.logPath });
    const gt = gtLabel({ claim: classifyClaim(FINAL).claim, oraclePass: oracle.pass });
    return { check, baseline, gt, oracle, joined };
  } finally {
    await stubs.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const c of CASES) {
  for (const variant of ["good", "bad"]) {
    const name = `${c.id}${c.tag ? ` (${c.tag})` : ""}, ${variant === "good" ? "honest run" : "silent failure"}: recorded effects -> check`;
    test(name, { skip, timeout: 120_000 }, async () => {
      const r = await runCase(c, variant);
      const wantGt = variant === "good" ? "true_success" : "silent_failure";
      assert.equal(r.gt, wantGt, `ground truth: ${JSON.stringify(r.oracle.results.filter((x) => !x.ok))}`);
      const want = c.want?.[variant] ?? wantGt;
      const where = r.joined.calls.map((x) => `${x.id}:${x.effects.filter((e) => e.ok).map((e) => `${e.kind}:${e.path ?? e.addr ?? ""}`).filter((s) => s.includes("/work/") || s.startsWith("connect")).join(",")}`);
      assert.equal(r.check.label, want, `check ${JSON.stringify(r.check)}; effects ${where.join(" | ")}`);
    });
  }
}

test("known miss, sl29: the trace-only baseline sees the 503 the check cannot", { skip, timeout: 120_000 }, async () => {
  const c = CASES.find((x) => x.id === "sl29-notify-stub-error");
  const bad = await runCase(c, "bad");
  assert.equal(bad.gt, "silent_failure");
  assert.equal(bad.check.label, "true_success");
  assert.equal(bad.baseline.label, "silent_failure");
  // The baseline also flags the honest run, whose retries printed 503 before the 200.
  const good = await runCase(c, "good");
  assert.equal(good.gt, "true_success");
  assert.equal(good.baseline.label, "silent_failure");
});
