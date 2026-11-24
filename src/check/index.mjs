// Lane P3c: silent-failure check and the trace-only baseline. Seam written in
// P2; contracts/api.md defines each function. This classifier must not call
// or copy the ground truth's claim judge (SPEC.md "Ground truth").

/** Does the final report claim the task succeeded? Returns { claim: boolean, cue: string|null }. */
export function classifyClaim(finalText) {
  throw new Error("not implemented: check.classifyClaim");
}

/** Label one run from its report and joined effects. Returns a CheckResult (contracts/types.md). */
export function checkRun({ finalText, joined, task, ctx }) {
  throw new Error("not implemented: check.checkRun");
}

/** Trace-only baseline: final text against the tool outputs only, no effects. Returns a CheckResult. */
export function traceOnlyCheck({ finalText, calls }) {
  throw new Error("not implemented: check.traceOnlyCheck");
}
