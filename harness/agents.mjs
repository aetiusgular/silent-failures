// Agent adapters for the P5 harness. Each adapter writes the agent's config
// into its own folder (never the box user's ~/.pi or ~/.claude), returns the
// argv and env to run it with, and parses its JSON event stream into the
// final text and ToolCalls (contracts/types.md).
//
// Call times: the agent runs as strace's root with stdout redirected inside
// the traced command (contracts/api.md, record()), so each write to the
// stdout file is a recorded effect with a timestamp. lineTimes() maps every
// stdout line to the time of the write that ended it. A tool call's window is
// [time of its start event, time of its end event].
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AGENTS = ["pi", "claude-code"];

/** argv prefix that runs `bin args...` with stdout and stderr opened inside the trace. */
export function redirectArgv(bin, args, outPath, errPath) {
  return ["sh", "-c", 'out="$1"; err="$2"; shift 2; exec "$@" > "$out" 2> "$err"', "sl-agent", outPath, errPath, bin, ...args];
}

/** For each line of `text`, the ts of the recorded write that ended it (null when unknown). */
export function lineTimes(text, effects, outPath) {
  const writes = effects.filter((e) => e.kind === "write" && e.ok && e.path === outPath && Number.isInteger(e.n) && e.n > 0).sort((a, b) => a.ts - b.ts);
  const ends = [];
  let off = 0;
  for (const w of writes) ends.push({ end: (off += w.n), ts: w.ts });
  const buf = Buffer.from(text, "utf8");
  const times = [];
  let pos = 0;
  let wi = 0;
  while (pos < buf.length) {
    let nl = buf.indexOf(10, pos);
    if (nl < 0) nl = buf.length - 1;
    while (wi < ends.length && ends[wi].end <= nl) wi++;
    times.push(wi < ends.length ? ends[wi].ts : null);
    pos = nl + 1;
  }
  return times;
}

function events(text, times) {
  const out = [];
  text.split("\n").forEach((l, i) => {
    if (!l.trim()) return;
    try {
      out.push({ ev: JSON.parse(l), ts: times[i] ?? null });
    } catch {}
  });
  return out;
}

const textOf = (content) =>
  typeof content === "string" ? content : (content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");

/** pi --mode json events -> { finalText, calls, errors }. */
export function parsePi(text, times) {
  const open = new Map();
  const calls = [];
  const errors = [];
  let finalText = "";
  for (const { ev, ts } of events(text, times)) {
    if (ev.type === "tool_execution_start") {
      const c = { id: String(ev.toolCallId), name: ev.toolName, input: ev.args ?? {}, ts_start: ts, ts_end: null };
      open.set(c.id, c);
      calls.push(c);
    } else if (ev.type === "tool_execution_end") {
      const c = open.get(String(ev.toolCallId));
      if (!c) continue;
      c.ts_end = ts;
      const t = textOf(ev.result?.content);
      if (ev.isError) c.error = t || "error";
      else c.output = t;
    } else if (ev.type === "message_end" && ev.message?.role === "assistant") {
      const t = textOf(ev.message.content);
      if (t.trim()) finalText = t;
      if (ev.message.stopReason === "error") errors.push(ev.message.errorMessage || "stopReason error");
    }
  }
  return { finalText, calls: finish(calls), errors };
}

/** claude -p --output-format stream-json events -> { finalText, calls, errors }. */
export function parseClaude(text, times) {
  const open = new Map();
  const calls = [];
  const errors = [];
  let finalText = "";
  let lastAssistant = "";
  for (const { ev, ts } of events(text, times)) {
    if (ev.type === "assistant") {
      const t = textOf(ev.message?.content);
      if (t.trim()) lastAssistant = t;
      for (const c of ev.message?.content ?? []) {
        if (c.type !== "tool_use") continue;
        const call = { id: String(c.id), name: c.name, input: c.input ?? {}, ts_start: ts, ts_end: null };
        open.set(call.id, call);
        calls.push(call);
      }
    } else if (ev.type === "user") {
      for (const c of ev.message?.content ?? []) {
        if (c.type !== "tool_result") continue;
        const call = open.get(String(c.tool_use_id));
        if (!call) continue;
        call.ts_end = ts;
        const t = textOf(c.content);
        if (c.is_error) call.error = t || "error";
        else call.output = t;
      }
    } else if (ev.type === "result") {
      if (typeof ev.result === "string") finalText = ev.result;
      if (ev.is_error) errors.push(ev.subtype || "result error");
    }
  }
  return { finalText: finalText || lastAssistant, calls: finish(calls), errors };
}

// A call with no end event (the run was killed mid-call) ends at its start and
// carries an error, so ToolCall keeps exactly one of output or error.
function finish(calls) {
  for (const c of calls) {
    if (c.ts_end == null) c.ts_end = c.ts_start;
    if (c.output === undefined && c.error === undefined) c.error = "no result recorded";
  }
  return calls.filter((c) => c.ts_start != null);
}

/**
 * Command for one run. `dir` is the agent's own folder (config and HOME),
 * outside the work folder. Returns { bin, args, env, parse }.
 */
export function agentCommand(agent, { dir, bins, modelUrl, modelId, prompt, basePath }) {
  mkdirSync(dir, { recursive: true });
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const env = { PATH: basePath, HOME: home, LANG: "C.UTF-8", TMPDIR: join(dir, "tmp") };
  mkdirSync(env.TMPDIR, { recursive: true });
  if (agent === "pi") {
    const cfg = join(dir, "pi-agent");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ enableInstallTelemetry: false }, null, 2));
    writeFileSync(
      join(cfg, "models.json"),
      JSON.stringify({ providers: { sl: { baseUrl: `${modelUrl}/v1`, api: "openai-completions", apiKey: "none", models: [{ id: modelId, name: modelId, contextWindow: 131072, maxTokens: 16384, reasoning: true }] } } }, null, 2),
    );
    return { bin: bins.pi, args: ["--mode", "json", "--no-session", "--model", `sl/${modelId}`, prompt], env: { ...env, PI_CODING_AGENT_DIR: cfg, PI_TELEMETRY: "0" }, parse: parsePi };
  }
  if (agent === "claude-code") {
    const cfg = join(dir, "claude-config");
    mkdirSync(cfg, { recursive: true });
    const m = { ANTHROPIC_MODEL: modelId, ANTHROPIC_DEFAULT_HAIKU_MODEL: modelId, ANTHROPIC_DEFAULT_SONNET_MODEL: modelId, ANTHROPIC_DEFAULT_OPUS_MODEL: modelId, CLAUDE_CODE_SUBAGENT_MODEL: modelId };
    return {
      bin: bins["claude-code"],
      args: ["-p", prompt, "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--disallowedTools", "WebFetch,WebSearch", "--dangerously-skip-permissions"],
      env: { ...env, ...m, CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_BASE_URL: modelUrl, ANTHROPIC_AUTH_TOKEN: "sl-local", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" },
      parse: parseClaude,
    };
  }
  if (agent === "scripted") {
    // Harness self-test only (tests/unit/harness.test.mjs): runs a plan of
    // shell steps and prints pi-format events. Never used for a result row.
    return { bin: process.execPath, args: [new URL("./scripted-agent.mjs", import.meta.url).pathname, prompt], env: { ...env, SL_SCRIPT_PLAN: bins.scriptedPlan }, parse: parsePi };
  }
  throw new Error(`unknown agent ${agent}`);
}
