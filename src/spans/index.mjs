// Lane P3b: spans. Seam written in P2; contracts/api.md defines each function.
//
// Both functions are pure: the same JoinedRun always gives the same output,
// byte for byte. Ids are derived from run_id and call ids with sha256, so a
// re-sent trace keeps its span ids (the target's ingest skips span ids it has
// already stored, which makes a resend idempotent).
import { createHash } from "node:crypto";

const SCOPE = { name: "silent-failures/spans", version: "0.1.0" };
const SPAN_KIND_INTERNAL = 1;
const STATUS_ERROR = 2;

const sha = (s) => createHash("sha256").update(s).digest("hex");
const traceIdOf = (runId) => sha(runId).slice(0, 32);
const callSpanId = (runId, callId) => sha(`${runId}:${callId}`).slice(0, 16);
// Root and unattributed ids use a NUL separator, which a call id joined with
// ":" cannot produce, so they never collide with a call's span id.
const ownSpanId = (runId, what) => sha(`${runId}\u0000${what}`).slice(0, 16);
const effectSpanId = (runId, callId, i) => sha(`${runId}\u0000${callId}\u0000${i}`).slice(0, 16);

/** Epoch seconds (float) -> OTLP `*UnixNano` string: BigInt(round(ts * 1e6)) * 1000. */
export function unixNano(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) throw new TypeError(`spans: bad timestamp ${ts}`);
  return String(BigInt(Math.round(ts * 1e6)) * 1000n);
}

const hasError = (call) => call.error !== undefined && call.error !== null;

function checkJoined(joined) {
  if (!joined || typeof joined !== "object") throw new TypeError("spans: JoinedRun expected");
  if (typeof joined.run_id !== "string" || joined.run_id === "") throw new TypeError("spans: run_id must be a non-empty string");
  if (!Array.isArray(joined.calls) || !Array.isArray(joined.unattributed)) {
    throw new TypeError("spans: JoinedRun needs calls[] and unattributed[]");
  }
  // Span ids must be unique in both outputs. Two calls with one id would give
  // two spans with one id, and one of them would be lost at ingest.
  const seen = new Set();
  for (const c of joined.calls) {
    const id = String(c.id);
    if (seen.has(id)) throw new Error(`spans: duplicate tool call id ${JSON.stringify(id)}`);
    seen.add(id);
  }
}

// The run's time range: every call window, every effect and every process
// lifetime, so the root span covers all its children.
function runRange(joined) {
  const ts = [];
  for (const c of joined.calls) {
    ts.push(c.ts_start, c.ts_end);
    for (const e of c.effects ?? []) ts.push(e.ts);
  }
  for (const e of joined.unattributed) ts.push(e.ts);
  for (const p of joined.procs ?? []) ts.push(p.ts_start, p.ts_end);
  const ok = ts.filter((t) => typeof t === "number" && Number.isFinite(t));
  if (ok.length === 0) return { start: 0, end: 0 };
  return { start: Math.min(...ok), end: Math.max(...ok) };
}

function effectRange(effects, fallback) {
  if (effects.length === 0) return fallback;
  const ts = effects.map((e) => e.ts);
  return { start: Math.min(...ts), end: Math.max(...ts) };
}

// ---- OTLP/JSON ------------------------------------------------------------

function anyValue(v) {
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(anyValue) } };
  return { stringValue: String(v) };
}
const kv = (key, value) => ({ key, value: anyValue(value) });

// Fields of an effect that go on its span event, in this order. `bytes` never
// does: it is file content, it can be 4 KiB per write, and it may be private.
const EVENT_FIELDS = [
  ["path", "effect.path"],
  ["path2", "effect.path2"],
  ["addr", "effect.addr"],
  ["errno", "effect.errno"],
  ["argv", "effect.argv"],
];

function effectEvent(e) {
  const attributes = [kv("effect.ok", e.ok === true), kv("effect.source", e.source)];
  for (const [field, key] of EVENT_FIELDS) {
    if (e[field] !== undefined && e[field] !== null) attributes.push(kv(key, e[field]));
  }
  return { timeUnixNano: unixNano(e.ts), name: `effect.${e.kind}`, attributes };
}

/** JoinedRun -> OTLP/JSON trace ({ resourceSpans }). */
export function toOtlp(joined) {
  checkJoined(joined);
  const runId = joined.run_id;
  const traceId = traceIdOf(runId);
  const range = runRange(joined);
  const rootId = ownSpanId(runId, "root");

  const root = {
    traceId,
    spanId: rootId,
    name: "invoke_agent",
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: unixNano(range.start),
    endTimeUnixNano: unixNano(range.end),
    attributes: [kv("gen_ai.operation.name", "invoke_agent"), kv("sf.run_id", runId)],
    events: [],
  };
  if (Number.isInteger(joined.root_pid)) root.attributes.push(kv("sf.root_pid", joined.root_pid));

  const callSpans = joined.calls.map((c) => {
    const span = {
      traceId,
      spanId: callSpanId(runId, String(c.id)),
      parentSpanId: rootId,
      name: `execute_tool ${c.name}`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: unixNano(c.ts_start),
      endTimeUnixNano: unixNano(c.ts_end),
      attributes: [
        kv("gen_ai.operation.name", "execute_tool"),
        kv("gen_ai.tool.name", c.name),
        kv("gen_ai.tool.call.id", String(c.id)),
      ],
      events: (c.effects ?? []).map(effectEvent),
    };
    if (hasError(c)) span.status = { code: STATUS_ERROR, message: String(c.error) };
    return span;
  });

  // Always present, even with no effects, so "nothing unattributed" is stated
  // rather than inferred from a missing span.
  const ur = effectRange(joined.unattributed, { start: range.start, end: range.start });
  const unattributed = {
    traceId,
    spanId: ownSpanId(runId, "unattributed"),
    parentSpanId: rootId,
    name: "unattributed",
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: unixNano(ur.start),
    endTimeUnixNano: unixNano(ur.end),
    attributes: [kv("sf.unattributed", true)],
    events: joined.unattributed.map(effectEvent),
  };

  return {
    resourceSpans: [
      {
        resource: { attributes: [kv("service.name", "silent-failures")] },
        scopeSpans: [{ scope: { ...SCOPE }, spans: [root, ...callSpans, unattributed] }],
      },
    ],
  };
}

// ---- The target's trace shape --------------------------------------------

const iso = (ts) => new Date(Math.round(ts * 1000)).toISOString();
const durationMs = (a, b) => Math.round((b - a) * 1e6) / 1e3;
const timing = (start, end) => ({ started_at: iso(start), ended_at: iso(end), duration_ms: durationMs(start, end) });

const ATTR_FIELDS = ["path", "path2", "addr", "argv"];

function effectSpan(e, id, parentId) {
  const attributes = { "effect.ok": e.ok === true, "effect.source": e.source };
  for (const f of ATTR_FIELDS) if (e[f] !== undefined && e[f] !== null) attributes[`effect.${f}`] = e[f];
  const span = { type: "span", id, parent_id: parentId, name: `effect.${e.kind}`, ...timing(e.ts, e.ts), attributes };
  // A failed syscall is kept but marked: the target's rule is that a non-empty
  // `error` forces status ERROR.
  if (e.ok !== true) Object.assign(span, { status: "ERROR", error: e.errno ?? "failed" });
  return span;
}

/** JoinedRun -> the target's trace shape ({ spans: [...] } with `tool` spans). */
export function toTargetTrace(joined) {
  checkJoined(joined);
  const runId = joined.run_id;
  const range = runRange(joined);

  const tools = joined.calls.map((c) => {
    const id = callSpanId(runId, String(c.id));
    const span = { type: "tool", id, name: c.name, input: c.input, ...timing(c.ts_start, c.ts_end) };
    // Exactly one of output or error. If a log carries both, error wins:
    // the target's docs say to prefer `error` over an output.
    if (hasError(c)) Object.assign(span, { status: "ERROR", error: String(c.error) });
    else span.output = c.output;
    span.attributes = { "gen_ai.tool.call.id": String(c.id) };
    span.spans = (c.effects ?? []).map((e, i) => effectSpan(e, effectSpanId(runId, String(c.id), i), id));
    return span;
  });

  const uid = ownSpanId(runId, "unattributed");
  const ur = effectRange(joined.unattributed, { start: range.start, end: range.start });
  const unattributed = {
    type: "span",
    id: uid,
    name: "unattributed",
    ...timing(ur.start, ur.end),
    attributes: { "sf.unattributed": true },
    spans: joined.unattributed.map((e, i) => effectSpan(e, effectSpanId(runId, "\u0000unattributed", i), uid)),
  };

  return { id: runId, name: "invoke_agent", ...timing(range.start, range.end), spans: [...tools, unattributed] };
}
