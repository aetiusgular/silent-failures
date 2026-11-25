// The ground truth's claim judge (contracts/claim-judge.md), written in P5.
// The prompt is read from the contract at run time, so the frozen text is the
// text sent. Model and sampling come from models.lock `claim_judge`. Nothing
// under src/ imports this file (the check's classifier shares nothing with it).
import { readFileSync } from "node:fs";
import { fetchJson } from "./http.mjs";

const TASK_SLOT = "<the task's prompt, with stub URLs filled in>";
const TEXT_SLOT = "<the run's final text>";

export function loadJudgePrompt(contractPath) {
  const md = readFileSync(contractPath, "utf8");
  const block = (label) => {
    const m = new RegExp(`^${label}:\\s*\\n+\`\`\`\\n([\\s\\S]*?)\\n\`\`\``, "m").exec(md);
    if (!m) throw new Error(`claim-judge.md: no ${label} block`);
    return m[1];
  };
  const system = block("System");
  const user = block("User");
  if (!user.includes(TASK_SLOT) || !user.includes(TEXT_SLOT)) throw new Error("claim-judge.md: user block lost its slots");
  return { system, user };
}

export function judgeMessages(prompt, taskPrompt, finalText) {
  // split/join, not replace: a "$&" in the agent's text must stay literal.
  const user = prompt.user.split(TASK_SLOT).join(taskPrompt).split(TEXT_SLOT).join(finalText);
  return [
    { role: "system", content: prompt.system },
    { role: "user", content: user },
  ];
}

/** "CLAIM" -> true, "NO_CLAIM" -> false, anything else -> null (judge_error). */
export function parseJudge(text) {
  const first = String(text ?? "").trim().split(/\s+/)[0] ?? "";
  const word = first.replace(/[^A-Za-z_]/g, "").toUpperCase();
  if (word === "CLAIM") return true;
  if (word === "NO_CLAIM") return false;
  return null;
}

/** Ask the judge. Returns { claim: bool|null, raw, error? }. */
export async function judgeClaim({ url, modelId, sampling, prompt, taskPrompt, finalText, timeoutMs = 120000 }) {
  const body = JSON.stringify({
    model: modelId,
    messages: judgeMessages(prompt, taskPrompt, finalText),
    temperature: sampling.temperature,
    seed: sampling.seed,
    max_tokens: sampling.max_tokens,
    stream: false,
  });
  try {
    const r = await fetchJson(`${url}/v1/chat/completions`, { method: "POST", body, timeoutMs });
    if (r.status !== 200) return { claim: null, raw: null, error: `HTTP ${r.status}: ${r.body.slice(0, 200)}` };
    const raw = r.json?.choices?.[0]?.message?.content ?? "";
    const claim = parseJudge(raw);
    return claim === null ? { claim, raw, error: "unparsable answer" } : { claim, raw };
  } catch (e) {
    return { claim: null, raw: null, error: e.message };
  }
}
