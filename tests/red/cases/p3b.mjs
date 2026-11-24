// Lane P3b red tests: spans. Input is the golden JoinedRun, so these do not depend on lane P3a.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { toOtlp, toTargetTrace } from "../../../src/spans/index.mjs";
import { json } from "./fixtures.mjs";

const golden = () => json("fixtures/traces/run1.joined.json");
const spansOf = (otlp) => otlp.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
const attr = (span, key) => {
  const a = (span.attributes ?? []).find((x) => x.key === key);
  return a ? Object.values(a.value)[0] : undefined;
};
const sha = (s) => createHash("sha256").update(s).digest("hex");

export default {
  // OTLP/JSON: one root span for the run, one child span per tool call, ids hex and deterministic.
  "b-otlp-shape": () => {
    const g = golden();
    const spans = spansOf(toOtlp(g));
    const root = spans.filter((s) => !s.parentSpanId);
    assert.equal(root.length, 1, "one root span");
    const traceId = sha(g.run_id).slice(0, 32);
    for (const s of spans) {
      assert.equal(s.traceId, traceId);
      assert.match(s.spanId, /^[0-9a-f]{16}$/);
      assert.match(String(s.startTimeUnixNano), /^\d+$/);
    }
    const calls = spans.filter((s) => s.parentSpanId === root[0].spanId && attr(s, "gen_ai.tool.call.id"));
    assert.equal(calls.length, g.calls.length);
    const c1 = calls.find((s) => attr(s, "gen_ai.tool.call.id") === "c1");
    assert.equal(c1.spanId, sha(`${g.run_id}:c1`).slice(0, 16));
    assert.equal(c1.startTimeUnixNano, String(BigInt(Math.round(g.calls[0].ts_start * 1e6)) * 1000n));
  },
  // Tool-call spans carry the GenAI semantic-convention attributes.
  "b-semconv-attrs": () => {
    const spans = spansOf(toOtlp(golden()));
    const c2 = spans.find((s) => attr(s, "gen_ai.tool.call.id") === "c2");
    assert.equal(attr(c2, "gen_ai.operation.name"), "execute_tool");
    assert.equal(attr(c2, "gen_ai.tool.name"), "bash");
    assert.equal(c2.name, "execute_tool bash");
  },
  // Every effect becomes a span event effect.<kind> on its call's span, with path and ok.
  "b-effect-events": () => {
    const g = golden();
    const spans = spansOf(toOtlp(g));
    for (const call of g.calls) {
      const s = spans.find((x) => attr(x, "gen_ai.tool.call.id") === call.id);
      assert.equal((s.events ?? []).length, call.effects.length, `${call.id} event count`);
      for (const [i, e] of call.effects.entries()) {
        const ev = s.events[i];
        assert.equal(ev.name, `effect.${e.kind}`);
        assert.equal(attr(ev, "effect.ok"), e.ok);
        if (e.path) assert.equal(attr(ev, "effect.path"), e.path);
        if (e.addr) assert.equal(attr(ev, "effect.addr"), e.addr);
        assert.equal(attr(ev, "effect.source"), e.source);
      }
    }
  },
  // A call with an error gets status ERROR (code 2) and its message.
  "b-error-status": () => {
    const spans = spansOf(toOtlp(golden()));
    const c4 = spans.find((s) => attr(s, "gen_ai.tool.call.id") === "c4");
    assert.equal(c4.status?.code, 2);
    assert.equal(c4.status?.message, "connection refused");
  },
  // Unattributed effects are kept on their own span, never dropped.
  "b-unattributed-kept": () => {
    const g = golden();
    const spans = spansOf(toOtlp(g));
    const u = spans.filter((s) => s.name === "unattributed");
    assert.equal(u.length, 1);
    assert.equal(attr(u[0], "sf.unattributed"), true);
    assert.equal(u[0].events.length, g.unattributed.length);
    const events = spans.reduce((n, s) => n + (s.events ?? []).length, 0);
    assert.equal(events, g.calls.reduce((n, c) => n + c.effects.length, 0) + g.unattributed.length);
  },
  // The target's trace contract: tool spans with input and output, effects as child spans.
  "b-target-tool-map": () => {
    const g = golden();
    const t = toTargetTrace(g);
    const tools = t.spans.filter((s) => s.type === "tool");
    assert.equal(tools.length, g.calls.length);
    const c1 = tools.find((s) => s.name === "write_file");
    assert.deepEqual(c1.input, g.calls[0].input);
    assert.equal(c1.output, "wrote 21 bytes");
    assert.equal(c1.spans.length, g.calls[0].effects.length);
    assert.ok(c1.spans.every((s) => s.type === "span" && s.name.startsWith("effect.")));
  },
  // A call with an error maps to `error`, not `output`.
  "b-target-error": () => {
    const t = toTargetTrace(golden());
    const fetch = t.spans.find((s) => s.type === "tool" && s.name === "fetch");
    assert.equal(fetch.error, "connection refused");
    assert.ok(!Object.hasOwn(fetch, "output"));
  },
  // Unattributed effects appear in the target trace too.
  "b-target-unattributed": () => {
    const t = toTargetTrace(golden());
    const u = t.spans.filter((s) => s.name === "unattributed");
    assert.equal(u.length, 1);
    assert.equal(u[0].type, "span");
    assert.equal(u[0].spans.length, 1);
  },
};
