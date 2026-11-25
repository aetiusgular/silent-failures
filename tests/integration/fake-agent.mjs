// A scripted stand-in for an agent CLI, written in P4 for the cross-lane tests.
//   node fake-agent.mjs <plan.json> <calls-out.json>
// plan.json is [{ name, cmd }]. Each step is one tool call: it runs `sh -c cmd`
// in the current folder and logs a ToolCall (contracts/types.md) with its time
// window, as an agent SDK would. A non-zero exit is the call's `error`.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const now = () => Math.round((performance.timeOrigin + performance.now()) * 1000) / 1e6;
const [planPath, outPath] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const calls = plan.map((step, i) => {
  const ts_start = now();
  const r = spawnSync("sh", ["-c", step.cmd], { encoding: "utf8" });
  const ts_end = now();
  const text = (r.stdout ?? "") + (r.stderr ?? "");
  const call = { id: `c${i + 1}`, name: step.name ?? "bash", input: { command: step.cmd }, ts_start, ts_end };
  if (r.status === 0) call.output = text;
  else call.error = text || `exit ${r.status}`;
  return call;
});
writeFileSync(outPath, JSON.stringify(calls, null, 2));
