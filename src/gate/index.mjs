// Lane P3c: band gate. Seam written in P2; contracts/eval.md section "Band gate" fixes the method.

/** Band from repeat pass rates. Returns { lo, hi, width, n, tasks }. */
export function band(repeats, { tasks } = {}) {
  throw new Error("not implemented: gate.band");
}

/** Promote B over A? Returns a GateDecision (contracts/types.md). */
export function decide({ a, b, k, n, tasks }) {
  throw new Error("not implemented: gate.decide");
}

/** Per-repeat pass rates from run rows [{ task, k, pass }]. Returns number[] ordered by repeat. */
export function repeatRates(rows) {
  throw new Error("not implemented: gate.repeatRates");
}
