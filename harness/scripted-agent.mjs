// A scripted stand-in for pi, for the harness self-test only. Reads a plan
// { steps: [{ name, cmd }], final } from the file named by SL_SCRIPT_PLAN, runs
// each step with `sh -c` in the current folder, and prints pi's --mode json
// events, one per line, as pi does. `{{URL}}` in a step is replaced by the
// first http://127.0.0.1:<port> URL in the prompt (argv[2]).
import { readFileSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";

const plan = JSON.parse(readFileSync(process.env.SL_SCRIPT_PLAN, "utf8"));
const url = (/http:\/\/127\.0\.0\.1:\d+/.exec(process.argv[2] ?? "") ?? [""])[0];
const emit = (ev) => writeSync(1, JSON.stringify(ev) + "\n");
plan.steps.forEach((step, i) => {
  const s = { ...step, cmd: step.cmd.split("{{URL}}").join(url) };
  const id = `call_${i + 1}`;
  emit({ type: "tool_execution_start", toolCallId: id, toolName: s.name ?? "bash", args: { command: s.cmd } });
  const r = spawnSync("sh", ["-c", s.cmd], { encoding: "utf8" });
  const text = (r.stdout ?? "") + (r.stderr ?? "");
  emit({ type: "tool_execution_end", toolCallId: id, toolName: s.name ?? "bash", result: { content: [{ type: "text", text }] }, isError: r.status !== 0 });
});
emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: plan.final }], stopReason: "stop" } });
