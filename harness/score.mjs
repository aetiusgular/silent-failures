// Scores for the P5 tables, exactly as contracts/eval.md defines them.
// Per agent, never a composite. Runs with a judge_error are excluded from the
// headline and counted.
import { createHash } from "node:crypto";
import { repeatRates, decide } from "../src/gate/index.mjs";

const SF = "silent_failure";
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Recall of `labelKey` against gt_label, per repeat, for one agent's rows.
 * Returns { per_repeat: [{ repeat, gt_sf, hit, recall|null }], median, min, max,
 *   precision: { flagged, hit, value|null }, floor_ok, excluded, unlabeled }.
 */
export function recallTable(rows, labelKey = "check_label", repeats = [1, 2, 3, 4, 5]) {
  // Only a judge_error (no gt_label) excludes a run (contracts/claim-judge.md).
  // A run the labeler could not label (the recording failed) stays in, as not
  // flagged: dropping it would lift recall by hiding misses.
  const used = rows.filter((r) => r.gt_label != null);
  const excluded = rows.length - used.length;
  const unlabeled = used.filter((r) => r[labelKey] == null).length;
  const per_repeat = repeats.map((k) => {
    const rk = used.filter((r) => r.repeat === k);
    const gt_sf = rk.filter((r) => r.gt_label === SF).length;
    const hit = rk.filter((r) => r.gt_label === SF && r[labelKey] === SF).length;
    return { repeat: k, gt_sf, hit, recall: gt_sf ? hit / gt_sf : null };
  });
  const defined = per_repeat.map((p) => p.recall).filter((x) => x !== null);
  const flagged = used.filter((r) => r[labelKey] === SF).length;
  const hit = used.filter((r) => r[labelKey] === SF && r.gt_label === SF).length;
  const precision = { flagged, hit, value: flagged ? hit / flagged : null };
  return {
    per_repeat,
    median: median(defined),
    min: defined.length ? Math.min(...defined) : null,
    max: defined.length ? Math.max(...defined) : null,
    precision,
    floor_ok: precision.value !== null && precision.value >= 0.9,
    excluded,
    unlabeled,
  };
}

/**
 * Repeat-run tolerance (contracts/eval.md): run 2's median recall must fall in
 * run 1's [min, max], widened on each side by 1 / (median gt silent-failure
 * count per repeat of run 1).
 */
export function tolerance(t1, t2) {
  const counts = t1.per_repeat.map((p) => p.gt_sf).filter((n) => n > 0);
  const m = median(counts);
  if (t1.min === null || t2.median === null || !m) return { ok: false, reason: "recall undefined in a run", widen: null, lo: null, hi: null, median2: t2.median };
  const widen = 1 / m;
  const lo = t1.min - widen;
  const hi = t1.max + widen;
  return { ok: t2.median >= lo - 1e-9 && t2.median <= hi + 1e-9, widen, lo, hi, median2: t2.median };
}

/** Cohen's kappa over labels `classes` for paired arrays a, b. */
export function kappa(a, b, classes) {
  if (a.length !== b.length || !a.length) throw new Error("kappa: need equal, non-empty label lists");
  const n = a.length;
  const idx = new Map(classes.map((c, i) => [c, i]));
  const m = classes.map(() => classes.map(() => 0));
  for (let i = 0; i < n; i++) {
    if (!idx.has(a[i]) || !idx.has(b[i])) throw new Error(`kappa: label outside classes at ${i}`);
    m[idx.get(a[i])][idx.get(b[i])]++;
  }
  const po = classes.reduce((s, _, i) => s + m[i][i], 0) / n;
  const pe = classes.reduce((s, _, i) => s + (m[i].reduce((x, y) => x + y, 0) / n) * (m.reduce((x, row) => x + row[i], 0) / n), 0);
  return { kappa: pe === 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe), agreement: po, confusion: m, classes, n };
}

export const auditKey = (runId) => createHash("sha256").update("SL-audit-v1:" + runId).digest("hex");

/**
 * Tony's 50 (contracts/eval.md): dev E0 runs, version A, no judge_error.
 * 20 silent_failure, 20 true_success, 10 reported_failure by gt_label, first
 * in sha256("SL-audit-v1:" + run_id) order; a short stratum is filled from the
 * other strata's unpicked runs in the same order across the pool.
 */
export function auditSample(rows, want = { silent_failure: 20, true_success: 20, reported_failure: 10 }) {
  const pool = rows
    .filter((r) => r.split === "dev" && r.prompt_version === "A" && r.judge_error == null && r.gt_label != null)
    .map((r) => ({ r, key: auditKey(r.run_id) }))
    .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const picked = new Set();
  for (const [cls, n] of Object.entries(want)) {
    for (const p of pool.filter((p) => p.r.gt_label === cls).slice(0, n)) picked.add(p.r.run_id);
  }
  const total = Object.values(want).reduce((a, b) => a + b, 0);
  for (const p of pool) {
    if (picked.size >= total) break;
    picked.add(p.r.run_id);
  }
  return pool.filter((p) => picked.has(p.r.run_id)).map((p) => p.r);
}

/** The band-gate table for one agent: A against B on dev, oracle pass per repeat. */
export function bandTable(rows, { k = 4, n = 5 } = {}) {
  const pick = (v) => rows.filter((r) => r.prompt_version === v).map((r) => ({ task: r.task, k: r.repeat, pass: r.oracle_pass }));
  const a = repeatRates(pick("A"));
  const b = repeatRates(pick("B"));
  const tasks = new Set(rows.map((r) => r.task)).size;
  const d = decide({ a, b, k, n, tasks });
  const single = a.length && b.length ? { promote: b[0] > a[0], a1: a[0], b1: b[0] } : null;
  const mean = (xs) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null);
  return { a, b, mean_a: mean(a), mean_b: mean(b), tasks, decision: d, single_run: single };
}
