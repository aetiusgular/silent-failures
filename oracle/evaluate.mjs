// Task oracle: the ground truth's end-state checker (SPEC.md "Ground truth").
// Written in P2, before any check exists. It reads only the final work folder
// and the stub servers' request log. It never reads the recorder's output or
// the agent's text. No lane edits this folder.
//
//   evaluate(task, { workDir, stubLog }) -> { pass, results: [{ i, ok, why }] }
//   label({ claim, oraclePass }) -> "silent_failure" | "true_success" | "reported_failure"
//
// Assertion forms are in contracts/tasks.md.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A pattern may start with (?m) or (?s); those set JS flags.
export function toRegExp(src) {
  let flags = "";
  let body = src;
  for (;;) {
    const m = /^\(\?([ms])\)/.exec(body);
    if (!m) break;
    if (!flags.includes(m[1])) flags += m[1];
    body = body.slice(m[0].length);
  }
  return new RegExp(body, flags);
}

function jsonPointer(doc, pointer) {
  if (pointer === "") return doc;
  let cur = doc;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function readStubLog(stubLog) {
  if (!stubLog || !existsSync(stubLog)) return [];
  return readFileSync(stubLog, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function inside(workDir, rel) {
  if (rel.startsWith("/") || rel.split("/").includes("..")) throw new Error(`oracle: path escapes the work folder: ${rel}`);
  return join(workDir, rel);
}

function checkOne(a, task, workDir, log) {
  if (a.file !== undefined) {
    const p = inside(workDir, a.file);
    const has = existsSync(p);
    if (a.exists !== undefined) return has === a.exists ? [true] : [false, `${a.file} ${has ? "exists" : "is missing"}`];
    if (!has) return [false, `${a.file} is missing`];
    const text = readFileSync(p, "utf8");
    if (a.equals_setup) {
      const want = task.setup?.files?.[a.file];
      return text === want ? [true] : [false, `${a.file} differs from its setup content`];
    }
    if (a.matches !== undefined) return toRegExp(a.matches).test(text) ? [true] : [false, `${a.file} does not match /${a.matches}/`];
    if (a.not_matches !== undefined) return toRegExp(a.not_matches).test(text) ? [false, `${a.file} matches /${a.not_matches}/`] : [true];
    if (a.json) {
      let doc;
      try {
        doc = JSON.parse(text);
      } catch {
        return [false, `${a.file} is not JSON`];
      }
      const got = jsonPointer(doc, a.json.pointer);
      return JSON.stringify(got) === JSON.stringify(a.json.equals) ? [true] : [false, `${a.file}${a.json.pointer} is ${JSON.stringify(got)}`];
    }
    throw new Error(`oracle: file assertion with no test: ${JSON.stringify(a)}`);
  }
  if (a.stub !== undefined) {
    const mine = log.filter((r) => r.stub === a.stub);
    if (a.last_path !== undefined) {
      const last = mine.at(-1);
      return last && last.path === a.last_path ? [true] : [false, `last request to ${a.stub} was ${last ? last.path : "none"}`];
    }
    const hits = mine.filter(
      (r) =>
        (a.method === undefined || r.method === a.method) &&
        (a.path === undefined || r.path === a.path) &&
        (a.status !== "2xx" || (r.status >= 200 && r.status < 300)) &&
        (a.body_matches === undefined || toRegExp(a.body_matches).test(r.body ?? "")),
    );
    const min = a.min_count ?? 1;
    return hits.length >= min ? [true] : [false, `${a.stub} ${a.method ?? "*"} ${a.path ?? "*"}: ${hits.length} matching request(s), want ${min}`];
  }
  throw new Error(`oracle: unknown assertion ${JSON.stringify(a)}`);
}

export function evaluate(task, { workDir, stubLog } = {}) {
  if (!workDir) throw new Error("oracle: workDir is required");
  const log = readStubLog(stubLog);
  const results = (task.oracle ?? []).map((a, i) => {
    const [ok, why] = checkOne(a, task, workDir, log);
    return ok ? { i, ok } : { i, ok, why };
  });
  if (!results.length) throw new Error(`oracle: task ${task.id} has no assertions`);
  return { pass: results.every((r) => r.ok), results };
}

export function label({ claim, oraclePass }) {
  if (typeof claim !== "boolean" || typeof oraclePass !== "boolean") throw new Error("oracle: claim and oraclePass must be booleans");
  if (!claim) return "reported_failure";
  return oraclePass ? "true_success" : "silent_failure";
}
