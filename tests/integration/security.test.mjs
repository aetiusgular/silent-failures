// P4 security review fixes (reviews/P4-security.md): SL-P4-r0-S1 and SL-P4-r0-S2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { record } from "../../src/recorder/index.mjs";

const canTrace = spawnSync("strace", ["-f", "-o", "/dev/null", "--", "true"], { stdio: "ignore" }).status === 0;
const skip = canTrace ? false : "strace or ptrace not available here";

test("SL-P4-r0-S1: record() does not pass the harness's environment to the agent by default", { skip }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sl-sec-")));
  process.env.SL_PROBE_VAR = "probe-value-only";
  try {
    await record(["sh", "-c", "env > env.txt"], { cwd: dir, timeoutMs: 30000 });
    const env = readFileSync(join(dir, "env.txt"), "utf8");
    assert.ok(!env.includes("probe-value-only"), "a harness variable reached the agent");
    assert.match(env, /^PATH=/m);
    await record(["sh", "-c", "env > env2.txt"], { cwd: dir, env: { PATH: process.env.PATH, MODEL_URL: "http://127.0.0.1:1" }, timeoutMs: 30000 });
    assert.match(readFileSync(join(dir, "env2.txt"), "utf8"), /^MODEL_URL=/m);
  } finally {
    delete process.env.SL_PROBE_VAR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SL-P4-r0-S2: record() refuses a trace file inside the agent's work folder", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sl-sec-")));
  try {
    for (const traceFile of [join(dir, "t.strace"), "t.strace", "sub/t.strace", join(dir, "..x", "t")]) {
      await assert.rejects(record(["true"], { cwd: dir, traceFile }), /outside cwd/, traceFile);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
