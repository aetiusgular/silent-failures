// Lane P3a: join. Seam written in P2; contracts/api.md defines it, contracts/types.md the rule.

const inWindow = (c, ts) => ts != null && ts >= c.ts_start && ts <= c.ts_end;

/** The call whose window holds ts; on overlap the one that started last (then the later one in the list). */
function callAt(calls, ts) {
  let best = -1;
  for (let i = 0; i < calls.length; i++) {
    if (!inWindow(calls[i], ts)) continue;
    if (best < 0 || calls[i].ts_start >= calls[best].ts_start) best = i;
  }
  return best;
}

/** Credit each effect to a tool call. Returns a JoinedRun (contracts/types.md). */
export function join({ runId, rootPid, calls = [], effects = [], procs = [] }) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const owner = new Map(); // pid -> call index or -1
  const belongs = (pid, seen = new Set()) => {
    if (owner.has(pid)) return owner.get(pid);
    const p = byPid.get(pid);
    let i = -1;
    if (p && !seen.has(pid)) {
      seen.add(pid);
      if (p.ppid === rootPid) i = callAt(calls, p.ts_start); // rule 1: spawned by the root inside a window
      else if (p.ppid != null && p.ppid !== pid) i = belongs(p.ppid, seen); // rule 1: its parent's call
    }
    owner.set(pid, i);
    return i;
  };

  const out = calls.map((c) => ({ ...c, effects: [] }));
  const unattributed = [];
  for (const e of effects) {
    const i = e.pid === rootPid ? callAt(calls, e.ts) : belongs(e.pid); // rules 2 and 3
    (i >= 0 ? out[i].effects : unattributed).push(e); // rule 4: nothing is dropped
  }
  return { run_id: runId, root_pid: rootPid, calls: out, unattributed, procs };
}
