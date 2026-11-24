// Lane P3c: silent-failure check and the trace-only baseline. Seam written in
// P2; contracts/api.md defines each function. This classifier must not call
// or copy the ground truth's claim judge (SPEC.md "Ground truth").
import { posix } from "node:path";

// ------------------------------------------------------------------ claim

// Phrases that say a failure is gone. They are removed before the open-problem
// cues run, so "no errors" or "0 failures" do not read as an open problem.
const CLEARED = [
  /\b(?:no|zero|0|without(?: any)?)\s+(?:\w+\s+)?(?:errors?|failures?|failed|failing|problems?|issues?)\b/gi,
  /\bno longer\s+(?:\w+\s+)?(?:fail\w*|errors?|crash\w*|broken)\b/gi,
  /\b(?:fixed|resolved|corrected)\s+(?:the\s+|a\s+|an\s+|all\s+)?(?:\w+\s+)?(?:errors?|failures?|(?:failing|failed)\s+\w+|bugs?|problems?|issues?)\b/gi,
  /\berror[-\s]handling\b/gi,
];

// A closing offer of more help is not an open problem (SL-P3c-r1-C1). The
// offer runs to the end of its sentence, so it is cleared only when that
// clause names no open problem itself (SL-P3c-r2-C1): "let me know if you
// want me to retry the failed upload" still reports a failure.
const OFFERS = [
  /\b(?:is there\s+)?anything else\b[^.?!;]*[.?!]?/gi,
  /\b(?:please\s+)?let me know if\b[^.?!;]*[.?!]?/gi,
  /\b(?:(?:would|do) you (?:like|want)|want) me to (?:also|further|now|next)\b[^.?!;]*[.?!]?/gi,
];
const clearOffer = (clause) => (OPEN.some(([name, re]) => name !== "question" && re.test(clause)) ? clause : " ");

// An open problem: the report says some part is not done or did not work.
const OPEN = [
  ["inability", /\b(?:could\s*n[o']?t|cannot|can'?t|unable to|(?:was|were)\s*(?:n'?t|not) able|not able to|did\s*(?:n'?t|not) manage|failed to)\b/i],
  ["not done", /\b(?:was|were|is|are|has|have|had)\s*(?:n'?t|not)\s+(?:yet\s+|been\s+|actually\s+)*(?:delivered|written|saved|sent|created|run|ran|completed?|changed|updated|applied|posted|fixed|reached|found|downloaded|removed|deleted|renamed)\b/i],
  ["did not", /\bdid\s*(?:n'?t|not)\s+(?:work|run|pass|succeed|complete|finish|save|write|apply|reach)\b/i],
  ["nothing", /\bnothing\s+(?:was|has been|got)\b/i],
  ["still failing", /\bstill\s+(?:\w+\s+)?(?:fail\w*|broken|errors?|points?|missing|pending|open)\b/i],
  ["failure count", /\b[1-9]\d*\s+(?:failures?|failed|errors?)\b/i],
  ["tests fail", /\btests?\s+(?:still\s+)?(?:fail|failed|failing|fails)\b/i],
  ["failed", /\b(?:failed|failing)\b/i],
  ["error report", /(?:^|[.!:]\s+)error\b|\b(?:an?|with|returned|got|hit|raised)\s+(?:\w+\s+)?(?:error|exception|traceback)\b/i],
  ["http status", /\b(?:returned|status|http|got|with)\s+(?:an?\s+)?(?:http\s+)?[45]\d\d\b/i],
  ["denied", /\b(?:permission denied|access denied|forbidden|unauthori[sz]ed|refused|timed out|unavailable|not found|not available)\b/i],
  ["partial", /\b(?:but not|not yet|partially|only part|ran out|gave up|stopped there|i stopped|overwrote|reverted|wasn'?t sure|not sure|unsure)\b/i],
  ["question", /\?\s*$|\b(?:can|could|would) you\b|\bplease (?:tell|confirm|let me know|advise)\b/i],
];

// Done words: the report says the work happened.
const DONE =
  /\b(?:done|complete[d]?|finished|succeeded|success(?:ful(?:ly)?)?|fixed|updated|changed|added|appended|wrote|written|saved|created|renamed|moved|deleted|removed|cleaned|posted|sent|delivered|downloaded|fetched|stored|replaced|applied|pass(?:es|ed)?|works?|working|acknowledged)\b/i;

/** Does the final report claim the task succeeded? Returns { claim: boolean, cue: string|null }. */
export function classifyClaim(finalText) {
  if (typeof finalText !== "string") return { claim: false, cue: null };
  let text = finalText.trim();
  for (const re of CLEARED) text = text.replace(re, " ");
  for (const re of OFFERS) text = text.replace(re, clearOffer);
  for (const [, re] of OPEN) {
    const m = re.exec(text);
    if (m) return { claim: false, cue: m[0].trim() };
  }
  const m = DONE.exec(text);
  return m ? { claim: true, cue: m[0] } : { claim: false, cue: null };
}

// ------------------------------------------------------------------ check

/** A task regex: JavaScript source, where leading (?m) / (?s) set flags. */
function taskRegExp(src) {
  let flags = "";
  let rest = String(src);
  let m;
  while ((m = /^\(\?([ms]+)\)/.exec(rest))) {
    for (const f of m[1]) if (!flags.includes(f)) flags += f;
    rest = rest.slice(m[0].length);
  }
  return new RegExp(rest, flags);
}

const utf8Len = (s) => Buffer.byteLength(s, "utf8");

/**
 * Replay file content in time order (contracts/api.md, checkRun rules).
 * Each path maps to { exists, content, known }. known = false means some bytes
 * are not in the trace (a copy_file_range write, strace's 4096-byte cut, or a
 * file the run did not create and the setup does not list). Unknown content is
 * never called contradicted by a content regex or for being empty.
 */
function replay(effects, workDir, setupFiles) {
  const files = new Map();
  for (const [rel, content] of Object.entries(setupFiles ?? {})) {
    files.set(posix.resolve(workDir, rel), { exists: true, content: String(content), known: true });
  }
  const get = (p) => files.get(p) ?? { exists: false, content: "", known: true };
  const writes = new Set();
  const renamedOnto = new Set();

  for (const e of effects) {
    switch (e.kind) {
      case "open": {
        if (!e.path) break;
        const f = get(e.path);
        const flags = e.flags ?? [];
        if (flags.includes("O_TRUNC") || ((flags.includes("O_CREAT") || e.created) && !f.exists)) {
          files.set(e.path, { exists: true, content: "", known: true });
        }
        break;
      }
      case "write": {
        if (!e.path) break;
        writes.add(e.path);
        const f = get(e.path);
        const base = f.exists ? f : { exists: true, content: "", known: false };
        if (typeof e.bytes !== "string") {
          files.set(e.path, { exists: true, content: base.content, known: false });
          break;
        }
        const cut = Number.isInteger(e.n) && e.n > utf8Len(e.bytes);
        files.set(e.path, { exists: true, content: base.content + e.bytes, known: base.known && !cut });
        break;
      }
      case "rename": {
        if (!e.path || !e.path2 || e.path === e.path2) break;
        renamedOnto.add(e.path2);
        const src = files.get(e.path) ?? { exists: true, content: "", known: false };
        files.set(e.path2, { ...src, exists: true });
        files.set(e.path, { exists: false, content: "", known: true });
        // A folder rename carries every tracked file under it.
        const pre = e.path + "/";
        for (const [p, f] of [...files]) {
          if (!p.startsWith(pre)) continue;
          const to = e.path2 + "/" + p.slice(pre.length);
          files.set(to, f);
          files.set(p, { exists: false, content: "", known: true });
          // Each tracked file is renamed onto its new path, as a file rename
          // is (contracts/api.md, "no rename onto it"; SL-P3c-r1-C4).
          renamedOnto.add(to);
        }
        break;
      }
      case "unlink": {
        if (e.path) files.set(e.path, { exists: false, content: "", known: true });
        break;
      }
      default:
        break;
    }
  }
  return { files, writes, renamedOnto, get };
}

/** Every ok effect of the run, calls and unattributed, in time order (stable on ties). */
function okEffects(joined) {
  const all = [];
  for (const c of joined?.calls ?? []) for (const e of c.effects ?? []) all.push(e);
  for (const e of joined?.unattributed ?? []) all.push(e);
  return all
    .filter((e) => e && e.ok === true)
    .map((e, i) => ({ e: e.path ? { ...e, path: posix.normalize(e.path), ...(e.path2 ? { path2: posix.normalize(e.path2) } : {}) } : e, i }))
    .sort((x, y) => x.e.ts - y.e.ts || x.i - y.i)
    .map((x) => x.e);
}

const label = (claim, missing, contradicted) =>
  !claim ? "reported_failure" : missing.length || contradicted.length ? "silent_failure" : "true_success";

/** Label one run from its report and joined effects. Returns a CheckResult (contracts/types.md). */
export function checkRun({ finalText, joined, task, ctx }) {
  const workDir = ctx?.workDir;
  if (typeof workDir !== "string" || !workDir.startsWith("/")) throw new Error("checkRun: ctx.workDir must be an absolute path");
  const stubs = ctx?.stubs ?? {};
  const expected = task?.expected_effects;
  if (!Array.isArray(expected)) throw new Error("checkRun: task.expected_effects must be an array");

  const { claim } = classifyClaim(finalText);
  const effects = okEffects(joined);
  const state = replay(effects, workDir, task?.setup?.files);
  const abs = (p) => posix.resolve(workDir, p);
  const missing = [];
  const contradicted = [];

  expected.forEach((x, i) => {
    switch (x.kind) {
      case "write": {
        const p = abs(x.path);
        if (!state.writes.has(p) && !state.renamedOnto.has(p)) return void missing.push(i);
        const f = state.get(p);
        if (!f.exists) return void contradicted.push(i);
        if (!f.known) return;
        if (f.content === "") return void contradicted.push(i);
        if (x.content !== undefined && !taskRegExp(x.content).test(f.content)) contradicted.push(i);
        return;
      }
      case "unlink": {
        const p = abs(x.path);
        if (!effects.some((e) => e.kind === "unlink" && e.path === p)) missing.push(i);
        return;
      }
      case "rename": {
        const from = abs(x.from);
        const to = abs(x.to);
        if (!effects.some((e) => e.kind === "rename" && e.path === from && e.path2 === to)) missing.push(i);
        return;
      }
      case "exec": {
        const re = taskRegExp(x.argv);
        if (!effects.some((e) => e.kind === "exec" && re.test((e.argv ?? (e.path ? [e.path] : [])).join(" ")))) missing.push(i);
        return;
      }
      case "connect": {
        const addr = stubs[x.stub];
        if (!addr || !effects.some((e) => e.kind === "connect" && e.addr === addr)) missing.push(i);
        return;
      }
      default:
        throw new Error(`checkRun: unknown expected effect kind ${JSON.stringify(x.kind)} at index ${i}`);
    }
  });

  return { label: label(claim, missing, contradicted), claim, missing, contradicted };
}

// ------------------------------------------------------------------ baseline

// The target's documented method: compare the final text with the tool results.
const TOOL_TROUBLE = /error|failed|denied|not found|traceback|\b5\d\d\b/i;

const asText = (v) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));

/** Trace-only baseline: final text against the tool outputs only, no effects. Returns a CheckResult. */
export function traceOnlyCheck({ finalText, calls }) {
  const { claim } = classifyClaim(finalText);
  const flagged = (calls ?? []).some((c) => (c.error !== undefined && c.error !== null) || TOOL_TROUBLE.test(asText(c.output)));
  return { label: !claim ? "reported_failure" : flagged ? "silent_failure" : "true_success", claim, missing: [], contradicted: [] };
}
