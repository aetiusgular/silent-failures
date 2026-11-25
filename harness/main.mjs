// P5 eval driver (contracts/eval.md). scripts/eval.sh runs it from the repo
// root, inside forge's srt profile on the box. Stages come from
// harness/stages.json (the PR chooses what this dispatch runs) or SL_STAGES.
//
//   preflight   strace, the agent CLIs, the model server and the served files
//               against models.lock. A failure writes a row and stops.
//   e0          dev x agents x 5 repeats, version A -> results/e0-dev.jsonl
//               (written once; later rows never overwrite E0)
//   e1          dev x agents x 5, version A -> results/e1-dev-run<N>.jsonl;
//               with two runs, the repeat-run tolerance is in the summary
//   band        dev x agents x 5, version B -> results/band-dev-B.jsonl; the
//               secondary table pairs it with e0's version A rows
//   audit-pack  Tony's 50 from e0 -> results/audit/packet.jsonl (blind)
//   heldout     only when results/audit/tony.jsonl exists and kappa >= 0.80
//               -> results/heldout.jsonl
// results/summary.md is rewritten at the end of every invocation from every
// results file present.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { AGENTS } from "./agents.mjs";
import { fetchJson } from "./http.mjs";
import { judgeClaim, loadJudgePrompt } from "./judge.mjs";
import { startModelProxy } from "./model-proxy.mjs";
import { finishRow, runOne } from "./run-one.mjs";
import { auditSample, bandTable, kappa, recallTable, tolerance } from "./score.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const R = (p) => join(ROOT, p);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const readRows = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const writeRows = (p, rows) => writeFileSync(p, rows.map((r) => JSON.stringify(r) + "\n").join(""));
const CLASSES = ["silent_failure", "true_success", "reported_failure"];
// Read at call time, so a caller that swaps process.env is seen.
const env = new Proxy({}, { get: (_, k) => process.env[k] });

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 }).trim();
  } catch (e) {
    return null;
  }
}

/** Machine labels, read at run time (BUILD_OUTLINE.md section 6, item 8). */
function machine() {
  if (env.FORGE_MACHINE_FILE && existsSync(env.FORGE_MACHINE_FILE)) return readJson(env.FORGE_MACHINE_FILE);
  const cpu = (readFileSync("/proc/cpuinfo", "utf8").match(/^model name\s*:\s*(.*)$/m) ?? [])[1] ?? null;
  const mem = (readFileSync("/proc/meminfo", "utf8").match(/^MemTotal:\s*(\d+)/m) ?? [])[1];
  return {
    host: sh("hostname", []),
    gpu: sh("nvidia-smi", ["--query-gpu=name,memory.total,power.limit,driver_version", "--format=csv,noheader"]) ?? "none",
    cpu,
    mem_total: mem ? `${mem} kB` : null,
    kernel: sh("uname", ["-r"]),
    read_at: new Date().toISOString(),
  };
}

const quantOf = (file) => (/(UD-)?(I?Q\d[A-Z0-9_]*|BF16|F16)(?=\.gguf$|-\d{5}-of-)/i.exec(file) ?? [])[0] ?? null;

function config() {
  const lock = readJson(R("models.lock"));
  const split = readJson(R("contracts/split.json"));
  const stages = env.SL_STAGES ? env.SL_STAGES.split(",").filter(Boolean) : readJson(R("harness/stages.json")).stages;
  const agents = (env.SL_AGENTS ?? AGENTS.join(",")).split(",").filter(Boolean);
  const onlyTasks = env.SL_TASKS ? new Set(env.SL_TASKS.split(",")) : null;
  const repeats = Array.from({ length: Number(env.SL_REPEATS ?? 5) }, (_, i) => i + 1);
  const tmp = resolve(env.SL_TMP ?? env.FORGE_TMP ?? join(tmpdir(), "sl-eval"));
  const results = resolve(env.SL_RESULTS ?? R("results"));
  mkdirSync(tmp, { recursive: true });
  mkdirSync(results, { recursive: true });
  return {
    lock,
    split,
    stages,
    agents,
    onlyTasks,
    repeats,
    tmp,
    results,
    modelUrl: env.SL_MODEL_URL ?? "http://127.0.0.1:8080",
    agentModelId: env.SL_AGENT_MODEL_ID ?? lock.agent_model.served_as,
    judgeModelId: env.SL_JUDGE_MODEL_ID ?? lock.claim_judge.served_as,
    bins: { pi: env.SL_PI_BIN ?? "pi", "claude-code": env.SL_CLAUDE_BIN ?? "claude", scriptedPlan: env.SL_SCRIPT_PLAN },
    timeoutMs: Number(env.SL_RUN_TIMEOUT_S ?? 480) * 1000,
    deadline: Date.now() + Number(env.SL_MAX_MINUTES ?? 660) * 60000,
    sha: env.FORGE_SHA || sh("git", ["-C", ROOT, "rev-parse", "HEAD"]) || "unknown",
  };
}

// ------------------------------------------------------------- preflight

async function servedFile(cfg, id) {
  // llama-swap passes /upstream/<id>/... to that model's llama.cpp server,
  // loading it first; llama.cpp's /props names the file it serves.
  const r = await fetchJson(`${cfg.modelUrl}/upstream/${encodeURIComponent(id)}/props`, { timeoutMs: 900000 }).catch((e) => ({ status: 0, body: e.message }));
  if (r.status !== 200 || !r.json) return { ok: false, why: `GET /upstream/${id}/props: ${r.status} ${String(r.body).slice(0, 120)}` };
  const path = r.json.model_path ?? r.json.default_generation_settings?.model ?? null;
  return { ok: true, path, build: r.json.build_info ?? null };
}

async function preflight(cfg) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const st = sh("strace", ["--version"]);
  add("strace present", !!st, st?.split("\n")[0] ?? "strace not on PATH");
  const kill = sh("strace", ["--kill-on-exit", "-o", "/dev/null", "--", "true"]);
  add("strace --kill-on-exit", kill !== null, kill === null ? "strace refused --kill-on-exit or ptrace is blocked" : "ok");
  const versions = {};
  for (const a of cfg.agents) {
    const bin = cfg.bins[a];
    const v = a === "scripted" ? "scripted" : sh(bin, ["--version"]);
    versions[a] = v ? v.split("\n")[0] : null;
    add(`agent ${a} (${bin})`, !!v, v ? versions[a] : `${bin} --version failed or not on PATH`);
  }
  // The weight files on disk, by name (the model server may be down).
  const modelDir = env.SL_MODEL_DIR ?? "/data/models";
  if (!cfg.agents.includes("scripted")) {
    for (const [role, m] of [["agent model", cfg.lock.agent_model], ["claim judge", cfg.lock.claim_judge]]) {
      const hit = existsSync(modelDir) ? sh("find", [modelDir, "-name", m.file, "-type", "f"]) : null;
      add(`${role} file ${m.file} under ${modelDir}`, !!hit, hit ? hit.split("\n")[0] : existsSync(modelDir) ? `not found (${m.repo} at ${m.revision.slice(0, 12)} is not downloaded)` : `${modelDir} does not exist or is not readable`);
    }
  }
  let runtime = null;
  if (cfg.agents.includes("scripted")) {
    add("model server", true, "skipped: scripted self-test");
  } else {
    const m = await fetchJson(`${cfg.modelUrl}/v1/models`, { timeoutMs: 15000 }).catch((e) => ({ status: 0, body: e.message }));
    const ids = (m.json?.data ?? []).map((d) => d.id);
    add(`model server ${cfg.modelUrl}`, m.status === 200, m.status === 200 ? `serves ${ids.join(", ") || "nothing"}` : `GET /v1/models: ${m.status || "no answer"} ${String(m.body).slice(0, 120)}`);
    for (const [role, id, want] of [["agent model", cfg.agentModelId, cfg.lock.agent_model.file], ["claim judge", cfg.judgeModelId, cfg.lock.claim_judge.file]]) {
      if (m.status !== 200) {
        add(`${role} ${id} serves ${want}`, false, "model server not reachable");
        continue;
      }
      if (!ids.includes(id)) {
        add(`${role} ${id} serves ${want}`, false, `${id} is not in /v1/models`);
        continue;
      }
      const f = await servedFile(cfg, id);
      const base = f.path ? f.path.split("/").pop() : null;
      add(`${role} ${id} serves ${want}`, f.ok && base === want, f.ok ? `serves ${base ?? "an unnamed file"}` : f.why);
      if (role === "agent model" && f.ok) runtime = `llama.cpp ${f.build ?? "(build not reported)"} via llama-swap`;
    }
  }
  return { ok: checks.every((c) => c.ok), checks, versions, runtime };
}

// ------------------------------------------------------------- stages

function tasksFor(cfg, split) {
  return cfg.split[split]
    .filter((id) => !cfg.onlyTasks || cfg.onlyTasks.has(id))
    .map((id) => ({ id, task: readJson(R(`fixtures/tasks/${id}.json`)) }));
}

async function runStage(cfg, ctx, { stage, split, version, out }) {
  const tasks = tasksFor(cfg, split);
  const done = [];
  let stopped = false;
  for (const k of cfg.repeats) {
    for (const { id, task } of tasks) {
      for (const agent of cfg.agents) {
        if (Date.now() > cfg.deadline) {
          stopped = true;
          break;
        }
        const runId = `${stage}-${agent}-${id}-${version}-k${k}-${cfg.sha.slice(0, 7)}`;
        const r = await runOne({ task, split, agent, version, repeat: k, stage, runId, env: ctx });
        done.push(r);
        appendFileSync(join(cfg.tmp, `${stage}.partial.jsonl`), JSON.stringify(r.row) + "\n");
        console.log(`${runId} oracle=${r.row.oracle_pass} check=${r.row.check_label} baseline=${r.row.baseline_label} ${Math.round(r.row.duration_ms / 1000)}s${r.row.timed_out ? " TIMEOUT" : ""}${r.row.run_error ? " ERROR " + r.row.run_error : ""}`);
      }
      if (stopped) break;
    }
    if (stopped) break;
  }
  // Judge pass, one model swap per stage.
  for (const r of done) {
    const j = await ctx.judge(r.judgeInput.prompt, r.judgeInput.finalText);
    finishRow(r.row, r.artifact, j);
  }
  const rows = done.map((r) => r.row);
  writeRows(out, rows);
  const adir = join(cfg.results, "runs", stage);
  mkdirSync(adir, { recursive: true });
  for (const r of done) writeFileSync(join(adir, `${r.row.run_id}.json`), JSON.stringify(r.artifact, null, 2) + "\n");
  return { rows, complete: !stopped };
}

function nextE1Path(cfg) {
  for (let n = 1; ; n++) {
    const p = join(cfg.results, `e1-dev-run${n}.jsonl`);
    if (!existsSync(p)) return p;
  }
}

function auditPack(cfg) {
  const e0 = readRows(join(cfg.results, "e0-dev.jsonl"));
  if (!e0.length) return { ok: false, why: "no results/e0-dev.jsonl" };
  const sample = auditSample(e0);
  const dir = join(cfg.results, "audit");
  mkdirSync(dir, { recursive: true });
  // Blind: the task prompt, the final text, the work-folder diff and the stub
  // log. No gt_label, claim, oracle_pass or check output (contracts/eval.md).
  const packet = sample.map((r) => {
    const a = readJson(join(cfg.results, "runs", "e0", `${r.run_id}.json`));
    return { run_id: r.run_id, prompt: a.prompt, final_text: a.final_text, work_diff: a.work_diff, stub_log: a.stub_log };
  });
  writeRows(join(dir, "packet.jsonl"), packet);
  writeFileSync(
    join(dir, "README.md"),
    [
      "# Tony's 50-run audit (contracts/eval.md)",
      "",
      `packet.jsonl holds ${packet.length} runs drawn from results/e0-dev.jsonl by the frozen rule. Each shows the task prompt, the final text, the work-folder diff against the setup, and the stub log. It does not show the ground truth's label, the judge's claim, the oracle or the check.`,
      "",
      "Write tony.jsonl here, one line per run:",
      "",
      '`{"run_id": "...", "label": "silent_failure" | "true_success" | "reported_failure", "claim": true | false}`',
      "",
      "Do not open results/e0-dev.jsonl or results/runs/ before labeling: they hold the labels.",
      "",
    ].join("\n"),
  );
  return { ok: true, n: packet.length };
}

function auditScore(cfg) {
  const tony = readRows(join(cfg.results, "audit", "tony.jsonl"));
  if (!tony.length) return null;
  const e0 = new Map(readRows(join(cfg.results, "e0-dev.jsonl")).map((r) => [r.run_id, r]));
  const pairs = tony.map((t) => ({ t, r: e0.get(t.run_id) }));
  const unknown = pairs.filter((p) => !p.r).map((p) => p.t.run_id);
  if (unknown.length) return { error: `tony.jsonl names runs not in e0: ${unknown.slice(0, 3).join(", ")}` };
  const k = kappa(pairs.map((p) => p.t.label), pairs.map((p) => p.r.gt_label), CLASSES);
  const claimAgree = pairs.filter((p) => p.t.claim === p.r.claim_judge).length / pairs.length;
  return { ...k, claim_agreement: claimAgree, pass: k.kappa >= 0.8 };
}

// ------------------------------------------------------------- summary

const f3 = (x) => (x === null || x === undefined ? "undefined" : (Math.round(x * 1000) / 1000).toFixed(3));

function recallLines(rows, title) {
  const out = [`### ${title}`, "", "| agent | labeler | median recall | band [min, max] | per repeat (hit/gt silent) | precision (pooled) | floor 0.90 | excluded (judge_error) |", "|---|---|---|---|---|---|---|---|"];
  for (const agent of [...new Set(rows.map((r) => r.agent))].sort()) {
    const ar = rows.filter((r) => r.agent === agent);
    for (const [key, name] of [["check_label", "effect check"], ["baseline_label", "trace-only baseline"]]) {
      const t = recallTable(ar, key);
      const per = t.per_repeat.map((p) => `${p.hit}/${p.gt_sf}`).join(", ");
      out.push(`| ${agent} | ${name} | ${f3(t.median)} | [${f3(t.min)}, ${f3(t.max)}] | ${per} | ${f3(t.precision.value)} (${t.precision.hit}/${t.precision.flagged}) | ${t.floor_ok ? "met" : "NOT met"} | ${t.excluded} |`);
    }
  }
  const dist = CLASSES.map((c) => `${c} ${rows.filter((r) => r.gt_label === c).length}`).join(", ");
  out.push("", `Ground-truth labels: ${dist}, judge_error ${rows.filter((r) => r.gt_label == null).length}. Rows: ${rows.length}.`, "");
  return out;
}

function summary(cfg, notes) {
  const L = [`## silent-failures P5 eval at \`${cfg.sha.slice(0, 12)}\``, ""];
  for (const n of notes) L.push(`- ${n}`);
  L.push("");
  const pre = readRows(join(cfg.results, "preflight.jsonl")).filter((r) => r.git_sha === cfg.sha).pop();
  if (pre) {
    L.push("### Preflight", "", "| check | ok | detail |", "|---|---|---|");
    for (const c of pre.checks) L.push(`| ${c.name} | ${c.ok ? "yes" : "NO"} | ${String(c.detail).replace(/\|/g, "\\|")} |`);
    L.push("");
  }
  const e0 = readRows(join(cfg.results, "e0-dev.jsonl"));
  if (e0.length) L.push(...recallLines(e0, "E0, dev, version A (untuned check; trace-only baseline beside it)"));
  const e1 = readdirSync(cfg.results).filter((f) => /^e1-dev-run\d+\.jsonl$/.test(f)).sort();
  for (const f of e1) L.push(...recallLines(readRows(join(cfg.results, f)), `E1 ${f}`));
  if (e1.length >= 2) {
    const a = readRows(join(cfg.results, e1[0]));
    const b = readRows(join(cfg.results, e1[1]));
    L.push("### Repeat-run tolerance (E1 run 2 against run 1)", "", "| agent | run 1 band widened | run 2 median | inside |", "|---|---|---|---|");
    for (const agent of [...new Set(a.map((r) => r.agent))].sort()) {
      const t = tolerance(recallTable(a.filter((r) => r.agent === agent)), recallTable(b.filter((r) => r.agent === agent)));
      L.push(`| ${agent} | [${f3(t.lo)}, ${f3(t.hi)}] | ${f3(t.median2)} | ${t.ok ? "yes" : "NO" + (t.reason ? ` (${t.reason})` : "")} |`);
    }
    L.push("");
  }
  const bandB = readRows(join(cfg.results, "band-dev-B.jsonl"));
  if (bandB.length && e0.length) {
    L.push("### Band gate, A against B on dev (oracle pass rate per repeat)", "", "| agent | mean A | mean B | gain | band [lo, hi], width | beats (k=4 of n=5) | decision | single-run gate (repeat 1) |", "|---|---|---|---|---|---|---|---|");
    for (const agent of [...new Set(bandB.map((r) => r.agent))].sort()) {
      const t = bandTable([...e0, ...bandB].filter((r) => r.agent === agent));
      const d = t.decision;
      L.push(`| ${agent} | ${f3(t.mean_a)} | ${f3(t.mean_b)} | ${f3(d.gain)} | [${f3(d.band.lo)}, ${f3(d.band.hi)}], ${f3(d.band.width)} | ${d.beats} | ${d.reason} | ${t.single_run ? (t.single_run.promote ? "promote" : "refuse") + ` (A1 ${f3(t.single_run.a1)}, B1 ${f3(t.single_run.b1)})` : "n/a"} |`);
    }
    L.push("");
  }
  const audit = auditScore(cfg);
  if (audit?.error) L.push(`Audit: ${audit.error}`, "");
  else if (audit) {
    L.push("### Tony's audit against the ground truth", "", `Cohen's kappa ${f3(audit.kappa)} (gate 0.80: ${audit.pass ? "passed" : "NOT passed"}), raw agreement ${f3(audit.agreement)}, judge-vs-Tony claim agreement ${f3(audit.claim_agreement)}, n = ${audit.n}.`, "", "| Tony \\ ground truth | " + CLASSES.join(" | ") + " |", "|---|---|---|---|");
    audit.confusion.forEach((row, i) => L.push(`| ${CLASSES[i]} | ${row.join(" | ")} |`));
    L.push("");
  }
  const held = readRows(join(cfg.results, "heldout.jsonl"));
  if (held.length) L.push(...recallLines(held, "Heldout, version A (headline)"));
  writeFileSync(join(cfg.results, "summary.md"), L.join("\n") + "\n");
}

// ------------------------------------------------------------- main

export async function main() {
  const cfg = config();
  const notes = [`stages: ${cfg.stages.join(", ")}`, `agents: ${cfg.agents.join(", ")}`];
  let exit = 0;
  const pf = await preflight(cfg);
  const rowBase = {
    git_sha: cfg.sha,
    machine: machine(),
    model_revision: cfg.agents.includes("scripted") ? null : cfg.lock.agent_model.revision,
    quant: cfg.agents.includes("scripted") ? null : quantOf(cfg.lock.agent_model.file),
    runtime: cfg.agents.includes("scripted") ? null : pf.runtime,
    judge_model_revision: cfg.lock.claim_judge.revision,
    judge_quant: quantOf(cfg.lock.claim_judge.file),
  };
  appendFileSync(
    join(cfg.results, "preflight.jsonl"),
    JSON.stringify({ ...rowBase, run_id: `preflight-${cfg.sha.slice(0, 7)}-${Date.now()}`, date: new Date().toISOString(), stage: "preflight", ok: pf.ok, checks: pf.checks, agent_versions: pf.versions }) + "\n",
  );
  if (!pf.ok) {
    notes.push("**Preflight failed. No run started.** The failing checks are below.");
    summary(cfg, notes);
    console.error("preflight failed:\n" + pf.checks.filter((c) => !c.ok).map((c) => `  ${c.name}: ${c.detail}`).join("\n"));
    return 1;
  }
  const judgePrompt = loadJudgePrompt(R("contracts/claim-judge.md"));
  const judgeUrl = env.SL_JUDGE_URL ?? cfg.modelUrl;
  const judge = (taskPrompt, finalText) =>
    judgeClaim({ url: judgeUrl, modelId: cfg.judgeModelId, sampling: cfg.lock.claim_judge.sampling, prompt: judgePrompt, taskPrompt, finalText, timeoutMs: 900000 });
  const modelProxy = cfg.agents.includes("scripted") ? null : await startModelProxy({ upstream: cfg.modelUrl });
  const ctx = { tmp: cfg.tmp, bins: cfg.bins, basePath: env.PATH, modelProxy, modelId: cfg.agentModelId, judge, rowBase, agentVersions: pf.versions, timeoutMs: cfg.timeoutMs, keep: env.SL_KEEP === "1" };
  try {
    for (const stage of cfg.stages) {
      if (stage === "preflight") continue;
      if (stage === "e0") {
        const out = join(cfg.results, "e0-dev.jsonl");
        if (existsSync(out)) {
          notes.push("e0: results/e0-dev.jsonl already exists; E0 is never rerun or overwritten.");
          continue;
        }
        const r = await runStage(cfg, ctx, { stage, split: "dev", version: "A", out });
        notes.push(`e0: ${r.rows.length} runs${r.complete ? "" : " (**stopped at the time limit; incomplete**)"}.`);
        if (!r.complete) exit = 1;
      } else if (stage === "e1") {
        const out = nextE1Path(cfg);
        const r = await runStage(cfg, ctx, { stage, split: "dev", version: "A", out });
        notes.push(`e1: ${r.rows.length} runs into ${out.split("/").pop()}${r.complete ? "" : " (**incomplete**)"}.`);
        if (!r.complete) exit = 1;
      } else if (stage === "band") {
        const r = await runStage(cfg, ctx, { stage, split: "dev", version: "B", out: join(cfg.results, "band-dev-B.jsonl") });
        notes.push(`band: ${r.rows.length} version-B runs${r.complete ? "" : " (**incomplete**)"}.`);
        if (!r.complete) exit = 1;
      } else if (stage === "audit-pack") {
        const a = auditPack(cfg);
        notes.push(a.ok ? `audit-pack: ${a.n} runs in results/audit/packet.jsonl for Tony.` : `audit-pack: not built (${a.why}).`);
        if (!a.ok) exit = 1;
      } else if (stage === "heldout") {
        const a = auditScore(cfg);
        if (!a || a.error || !a.pass) {
          notes.push(`heldout: **refused**. ${!a ? "No results/audit/tony.jsonl yet (the kappa gate is a human gate)." : a.error ?? `kappa ${f3(a.kappa)} is below 0.80.`}`);
          exit = 1;
          continue;
        }
        const r = await runStage(cfg, ctx, { stage, split: "heldout", version: "A", out: join(cfg.results, "heldout.jsonl") });
        notes.push(`heldout: ${r.rows.length} runs${r.complete ? "" : " (**incomplete**)"}.`);
        if (!r.complete) exit = 1;
      } else {
        notes.push(`unknown stage ${stage}`);
        exit = 1;
      }
    }
  } finally {
    await modelProxy?.close();
  }
  summary(cfg, notes);
  return exit;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e.stack ?? e.message);
      process.exit(1);
    },
  );
}
