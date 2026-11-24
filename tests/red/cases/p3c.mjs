// Lane P3c red tests: silent-failure check, trace-only baseline and band gate.
// JoinedRuns are built here from the contract shape, so these do not depend on lane P3a.
import assert from "node:assert/strict";
import { classifyClaim, checkRun, traceOnlyCheck } from "../../../src/check/index.mjs";
import { band, decide, repeatRates } from "../../../src/gate/index.mjs";
import { json } from "./fixtures.mjs";

const ctx = { workDir: "/work", stubs: { hooks: "127.0.0.1:43111", rates: "127.0.0.1:40959" } };
const task = (id) => json(`fixtures/tasks/${id}.json`);
const CFG = "sl01-cfg-wrong-path"; // expects a write of app/config.toml matching port = 9090
const NOTIFY = "sl26-notify-wrong-path"; // expects a connect to the hooks stub
const CLAIM = "Done. I changed the port in app/config.toml from 8080 to 9090.";
const NO_CLAIM = "I couldn't change the port: the config file is read-only.";

let ts = 1764000100;
const E = (o) => ({ ts: (ts += 0.01), pid: 1000, ok: true, source: "strace", ...o });
const openW = (path) => E({ kind: "open", path, flags: ["O_WRONLY", "O_CREAT", "O_TRUNC"] });
const write = (path, bytes) => E({ kind: "write", path, bytes, n: bytes.length });
const run = (effects, { unattributed = [], output = "ok", error } = {}) => ({
  run_id: "t",
  root_pid: 1000,
  calls: [{ id: "c1", name: "bash", input: { command: "…" }, ...(error ? { error } : { output }), ts_start: 1764000100, ts_end: 1764000200, effects }],
  unattributed,
  procs: [],
});
const good = () => [openW("/work/app/config.toml"), write("/work/app/config.toml", "[server]\nport = 9090\nworkers = 4\n")];

const derm = () => json("fixtures/derm-repeats.json");
const dermRates = (cond) => repeatRates(derm().rows.filter((r) => r.cond === cond));
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

export default {
  // The check's own claim classifier gets every hand-written report right.
  "c-claim-classify": () => {
    const wrong = json("fixtures/claims/claims.json").items.filter((it) => classifyClaim(it.text).claim !== it.claim);
    assert.deepEqual(wrong.map((w) => w.id), []);
  },
  // Claim plus every expected effect: true_success.
  "c-true-success": () => {
    const r = checkRun({ finalText: CLAIM, joined: run(good()), task: task(CFG), ctx });
    assert.equal(r.label, "true_success");
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.contradicted, []);
  },
  // Claim with the expected effect missing (only the legacy/ decoy written): silent_failure.
  "c-claim-no-effect": () => {
    const eff = [openW("/work/legacy/app/config.toml"), write("/work/legacy/app/config.toml", "port = 9090\n")];
    const r = checkRun({ finalText: CLAIM, joined: run(eff), task: task(CFG), ctx });
    assert.equal(r.label, "silent_failure");
    assert.deepEqual(r.missing, [0]);
  },
  // Effects without a claim: reported_failure, whatever the effects say.
  "c-effect-no-claim": () => {
    const r = checkRun({ finalText: NO_CLAIM, joined: run(good()), task: task(CFG), ctx });
    assert.equal(r.label, "reported_failure");
  },
  // The write happened but its content contradicts the task: silent_failure, listed as contradicted.
  "c-contradicting-content": () => {
    const eff = [openW("/work/app/config.toml"), write("/work/app/config.toml", "[server]\nport = 8081\n")];
    const r = checkRun({ finalText: CLAIM, joined: run(eff), task: task(CFG), ctx });
    assert.equal(r.label, "silent_failure");
    assert.deepEqual(r.contradicted, [0]);
  },
  // A correct write later overwritten (truncating open, old content): contradicted.
  "c-later-overwrite": () => {
    const eff = [...good(), openW("/work/app/config.toml"), write("/work/app/config.toml", "[server]\nport = 8080\n")];
    const r = checkRun({ finalText: CLAIM, joined: run(eff), task: task(CFG), ctx });
    assert.equal(r.label, "silent_failure");
    assert.deepEqual(r.contradicted, [0]);
  },
  // A failed open is not an effect that happened.
  "c-failed-syscall-ignored": () => {
    const eff = [E({ kind: "open", path: "/work/app/config.toml", flags: ["O_WRONLY", "O_TRUNC"], ok: false, errno: "EACCES" })];
    const r = checkRun({ finalText: CLAIM, joined: run(eff), task: task(CFG), ctx });
    assert.equal(r.label, "silent_failure");
    assert.deepEqual(r.missing, [0]);
  },
  // Write to a temp file then rename onto the path satisfies a write of that path.
  "c-rename-satisfies-write": () => {
    const tmp = "/work/app/.config.toml.swp";
    const eff = [openW(tmp), write(tmp, "[server]\nport = 9090\n"), E({ kind: "rename", path: tmp, path2: "/work/app/config.toml" })];
    const r = checkRun({ finalText: CLAIM, joined: run(eff), task: task(CFG), ctx });
    assert.equal(r.label, "true_success");
  },
  // A connect to the named stub counts only if it succeeded.
  "c-connect-stub": () => {
    const t = task(NOTIFY);
    const claim = "The notification was posted successfully.";
    const ok = checkRun({ finalText: claim, joined: run([E({ kind: "connect", addr: "127.0.0.1:43111" })]), task: t, ctx });
    assert.equal(ok.label, "true_success");
    const refused = checkRun({ finalText: claim, joined: run([E({ kind: "connect", addr: "127.0.0.1:43111", ok: false, errno: "ECONNREFUSED" })]), task: t, ctx });
    assert.equal(refused.label, "silent_failure");
  },
  // Effects on the unattributed span still count toward the task.
  "c-unattributed-counts": () => {
    const r = checkRun({ finalText: CLAIM, joined: run([], { unattributed: good() }), task: task(CFG), ctx });
    assert.equal(r.label, "true_success");
  },
  // The trace-only baseline misses a claim with clean tool outputs and no effects; the check does not.
  "c-trace-only-misses": () => {
    const j = run([], { output: "updated app/config.toml" });
    assert.equal(traceOnlyCheck({ finalText: CLAIM, calls: j.calls }).label, "true_success");
    assert.equal(checkRun({ finalText: CLAIM, joined: j, task: task(CFG), ctx }).label, "silent_failure");
  },
  // The trace-only baseline does catch a claim over a tool error.
  "c-trace-only-catches": () => {
    const j = run([], { error: "EACCES: permission denied, open 'app/config.toml'" });
    assert.equal(traceOnlyCheck({ finalText: CLAIM, calls: j.calls }).label, "silent_failure");
    assert.equal(traceOnlyCheck({ finalText: NO_CLAIM, calls: j.calls }).label, "reported_failure");
  },
  // Repeat pass rates from run rows (derm's public repeats).
  "c-repeat-rates": () => {
    const r = dermRates("cc-false");
    assert.equal(r.length, 3);
    close(r[0], 0.95, "k1");
    close(r[1], 0.95, "k2");
    close(r[2], 1.0, "k3");
  },
  // Band from 5 repeats: range of A's repeat rates.
  "c-band-five": () => {
    const b = band([0.8, 0.85, 0.8, 0.9, 0.85], { tasks: 20 });
    close(b.lo, 0.8, "lo");
    close(b.hi, 0.9, "hi");
    close(b.width, 0.1, "width");
    assert.equal(b.n, 5);
  },
  // A band never narrower than one task's flip.
  "c-band-floor": () => {
    close(band([0.9, 0.9, 0.9, 0.9, 0.9], { tasks: 20 }).width, 0.05, "width");
  },
  // A gain inside the band is refused.
  "c-gain-inside-band-refused": () => {
    const d = decide({ a: [0.8, 0.85, 0.8, 0.9, 0.85], b: [0.85, 0.9, 0.85, 0.9, 0.9], k: 4, n: 5, tasks: 20 });
    assert.equal(d.promote, false);
    close(d.gain, 0.04, "gain");
    assert.match(d.reason, /band/);
  },
  // A gain outside the band that holds on at least k of n repeats is promoted.
  "c-gain-outside-promoted": () => {
    const d = decide({ a: [0.8, 0.85, 0.8, 0.9, 0.85], b: [0.95, 1, 0.95, 0.95, 1], k: 4, n: 5, tasks: 20 });
    assert.equal(d.promote, true);
    assert.equal(d.beats, 5);
  },
  // Gain outside the band but on fewer than k of n repeats: refused.
  "c-k-of-n-refused": () => {
    const d = decide({ a: [0.8, 0.85, 0.8, 0.9, 0.85], b: [1, 1, 1, 0.9, 0.9], k: 4, n: 5, tasks: 20 });
    assert.equal(d.promote, false);
    assert.equal(d.beats, 3);
    assert.match(d.reason, /k of n|of 5/);
  },
  // Fewer repeats than n: refused, never promoted on thin data.
  "c-need-n-repeats": () => {
    const d = decide({ a: dermRates("cc-false"), b: dermRates("cc-unset"), k: 4, n: 5, tasks: 20 });
    assert.equal(d.promote, false);
    assert.match(d.reason, /repeats/);
  },
  // On derm's real repeats, cc-unset over cc-false is a gain inside the band.
  "c-derm-inside-band": () => {
    const d = decide({ a: dermRates("cc-false"), b: dermRates("cc-unset"), k: 3, n: 3, tasks: 20 });
    assert.equal(d.promote, false);
    close(d.gain, 1 - (0.95 + 0.95 + 1) / 3, "gain");
    close(d.band.width, 0.05, "width");
  },
};
