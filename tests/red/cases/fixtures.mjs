// Shared fixture loading for the red tests. Lanes do not edit this folder.
import { readFileSync } from "node:fs";

const root = new URL("../../../", import.meta.url);
export const text = (p) => readFileSync(new URL(p, root), "utf8");
export const json = (p) => JSON.parse(text(p));
export const T = 1764000100;
export const at = (d) => Math.round((T + d) * 1e6) / 1e6;

// (call id, kind, path or addr, ok) per effect, sorted, for comparing joins.
export function projection(joined) {
  const row = (call, e) => `${call}|${e.kind}|${e.path ?? e.addr ?? ""}|${e.path2 ?? ""}|${e.ok}`;
  return [
    ...joined.calls.flatMap((c) => c.effects.map((e) => row(c.id, e))),
    ...joined.unattributed.map((e) => row("unattributed", e)),
  ].sort();
}
