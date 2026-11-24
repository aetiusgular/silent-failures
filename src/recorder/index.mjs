// Lane P3a: recorder. Seam written in P2; contracts/api.md defines each function.
// The lane replaces the bodies. Signatures and return shapes are fixed by the contract.

/** Parse `strace -f -ttt -s 4096 -xx` output. Returns { effects: Effect[], procs: Proc[] }. */
export function parseStrace(text, { cwd } = {}) {
  throw new Error("not implemented: recorder.parseStrace");
}

/** Parse auditd records from the `-a always,io_uring` rule. Returns Effect[] with source "audit-io_uring". */
export function parseAudit(text) {
  throw new Error("not implemented: recorder.parseAudit");
}

/** Merge strace and audit effects; one effect per act, strace wins ties. Returns Effect[] sorted by ts. */
export function mergeEffects(straceEffects, auditEffects) {
  throw new Error("not implemented: recorder.mergeEffects");
}

/** Summarise the recorder's cost from paired traced and untraced wall times (ms). */
export function costReport(samples) {
  throw new Error("not implemented: recorder.costReport");
}

/** Run argv under strace (and read the audit log if available). Returns a Recording. Not exercised by red tests (needs strace). */
export async function record(argv, opts = {}) {
  throw new Error("not implemented: recorder.record");
}
