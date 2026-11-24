// Lane P3b: spans. Seam written in P2; contracts/api.md defines each function.

/** JoinedRun -> OTLP/JSON trace ({ resourceSpans }). */
export function toOtlp(joined) {
  throw new Error("not implemented: spans.toOtlp");
}

/** JoinedRun -> the target's trace shape ({ spans: [...] } with `tool` spans). */
export function toTargetTrace(joined) {
  throw new Error("not implemented: spans.toTargetTrace");
}
