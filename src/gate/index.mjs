// Lane P3c: band gate. Seam written in P2; contracts/eval.md section "Band gate" fixes the method.

// Pass rates are shares of a whole number of tasks, so float noise sits far
// below one task's step. EPS keeps a sum like 0.85 + 0.05 from reading as
// "above" 0.9 when the two are the same share.
const EPS = 1e-9;

const isRate = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
const posInt = (x) => Number.isInteger(x) && x > 0;
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const fmt = (x) => (Math.round(x * 1e4) / 1e4).toString();

function rates(name, xs) {
  if (!Array.isArray(xs) || !xs.every(isRate)) throw new Error(`gate: ${name} must be an array of pass rates in [0, 1]`);
  return xs;
}

/** Band from repeat pass rates. Returns { lo, hi, width, n, tasks }. */
export function band(repeats, { tasks } = {}) {
  rates("repeats", repeats);
  if (repeats.length === 0) throw new Error("gate: band needs at least one repeat");
  if (!posInt(tasks)) throw new Error("gate: band needs tasks, a positive integer (the width floor is 1 / tasks)");
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of repeats) {
    if (r < lo) lo = r;
    if (r > hi) hi = r;
  }
  return { lo, hi, width: Math.max(hi - lo, 1 / tasks), n: repeats.length, tasks };
}

/** Promote B over A? Returns a GateDecision (contracts/types.md). */
export function decide({ a, b, k, n, tasks }) {
  rates("a", a);
  rates("b", b);
  if (!posInt(n) || !posInt(k) || k > n) throw new Error("gate: need positive integers k <= n");
  if (a.length === 0 || b.length === 0) throw new Error("gate: a and b each need at least one repeat");
  const bd = band(a, { tasks });
  const gain = mean(b) - mean(a);
  let beats = 0;
  for (const r of b) if (r > bd.hi + EPS) beats++;
  const out = (promote, reason) => ({ promote, gain, band: bd, beats, k, n, reason });

  if (a.length < n || b.length < n) return out(false, `refused: need ${n} repeats of each version, have ${a.length} of A and ${b.length} of B`);
  if (!(gain > bd.width + EPS)) return out(false, `refused: gain ${fmt(gain)} is inside the band (width ${fmt(bd.width)})`);
  if (beats < k) return out(false, `refused: B beat the band's top ${fmt(bd.hi)} on ${beats} of ${b.length} repeats, below k of n (${k} of ${n})`);
  return out(true, `promoted: gain ${fmt(gain)} is outside the band (width ${fmt(bd.width)}) and B beat its top on ${beats} of ${b.length} repeats (k of n: ${k} of ${n})`);
}

/** Per-repeat pass rates from run rows [{ task, k, pass }]. Returns number[] ordered by repeat. */
export function repeatRates(rows) {
  if (!Array.isArray(rows)) throw new Error("gate: repeatRates needs an array of rows");
  const byK = new Map();
  for (const r of rows) {
    if (!r || !Number.isInteger(r.k) || typeof r.pass !== "boolean" || r.task === undefined) {
      throw new Error(`gate: row needs task, an integer k and a boolean pass: ${JSON.stringify(r)}`);
    }
    let m = byK.get(r.k);
    if (!m) byK.set(r.k, (m = new Map()));
    if (m.has(r.task)) throw new Error(`gate: task ${JSON.stringify(r.task)} appears twice in repeat ${r.k}`);
    m.set(r.task, r.pass);
  }
  return [...byK.keys()]
    .sort((x, y) => x - y)
    .map((key) => {
      const m = byK.get(key);
      let pass = 0;
      for (const p of m.values()) if (p) pass++;
      return pass / m.size;
    });
}
