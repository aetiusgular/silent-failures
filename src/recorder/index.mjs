// Lane P3a: recorder. Seam written in P2; contracts/api.md defines each function.
// The bodies are lane P3a's. Signatures and return shapes are fixed by the contract.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath, posix } from "node:path";

// ------------------------------------------------------------------ helpers

const round6 = (x) => Math.round(x * 1e6) / 1e6;

/** Decode one strace string literal body (without quotes): -xx hex, C escapes, octal. Returns UTF-8 text. */
export function decodeCString(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\") {
      for (const b of Buffer.from(c, "utf8")) bytes.push(b);
      continue;
    }
    const d = s[++i];
    if (d === "x") {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (d >= "0" && d <= "7") {
      let j = i;
      while (j < i + 3 && s[j] >= "0" && s[j] <= "7") j++;
      bytes.push(parseInt(s.slice(i, j), 8) & 0xff);
      i = j - 1;
    } else {
      const map = { n: 10, t: 9, r: 13, v: 11, f: 12, a: 7, b: 8, e: 27, "\\": 92, '"': 34, "'": 39 };
      bytes.push(map[d] ?? d.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Split a syscall's argument text at top-level commas. Quotes, (), [] and {} nest.
 * Comments like `/* 20 vars *\/` stay inside their argument.
 */
export function splitArgs(s) {
  const out = [];
  let depth = 0;
  let inStr = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      cur += c;
      if (c === "\\") cur += s[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      const stop = end < 0 ? s.length : end + 2;
      cur += s.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/** The first quoted string in an argument, decoded, or null. A trailing `...` (truncation) is ignored. */
function str(arg) {
  if (arg == null) return null;
  const m = /"((?:[^"\\]|\\.)*)"/.exec(arg);
  return m ? decodeCString(m[1]) : null;
}

/** All quoted strings in an argument (an argv array, an iovec list), decoded. */
function strs(arg) {
  const out = [];
  if (arg == null) return out;
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(arg))) out.push(decodeCString(m[1]));
  return out;
}

/** Index of the `)` closing the `(` at `open`, skipping strings and nesting. -1 if none. */
function closeParen(s, open) {
  let depth = 0;
  let inStr = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Parse `= <ret> [ERRNO (text)]`. Returns { ret, errno } or null for `= ?`. */
function parseRet(tail) {
  const m = /^\s*=\s*(-?\d+|0x[0-9a-f]+|\?)(?:\s+([A-Z][A-Z0-9_]+))?/.exec(tail);
  if (!m) return null;
  if (m[1] === "?") return { ret: null, errno: null };
  const ret = m[1].startsWith("0x") ? parseInt(m[1], 16) : parseInt(m[1], 10);
  return { ret, errno: ret < 0 ? (m[2] ?? "EUNKNOWN") : null };
}

const flagList = (arg) => (arg ?? "").split("|").map((f) => f.trim()).filter((f) => /^O_[A-Z0-9_]+$/.test(f));

// --------------------------------------------------------------- parseStrace

const LINE = /^(\d+)\s+(\d+\.\d+)\s+(.*)$/;

/** Pass 1: one record per finished syscall (halves joined) and per exit, in file order. */
function readRecords(text) {
  const recs = [];
  const pending = new Map(); // pid -> { name, ts, head, seq }
  let seq = 0;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = LINE.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ts = round6(parseFloat(m[2]));
    let rest = m[3];
    if (rest.startsWith("+++")) {
      recs.push({ type: "exit", pid, ts, seq: seq++ });
      continue;
    }
    if (rest.startsWith("---")) continue; // signal delivery
    let start = ts;
    let startSeq = seq++;
    const res = /^<\.\.\. (\w+) resumed>(.*)$/.exec(rest);
    if (res) {
      const p = pending.get(pid);
      if (!p || p.name !== res[1]) continue; // a resume with no first half: nothing to join
      pending.delete(pid);
      rest = `${p.head}${res[2]}`;
      start = p.ts;
      startSeq = p.seq;
    } else {
      const un = /^(.*?)\s*<unfinished \.\.\.>\s*$/.exec(rest);
      if (un) {
        const name = /^(\w+)\(/.exec(un[1])?.[1];
        if (name) pending.set(pid, { name, ts, head: un[1], seq: startSeq });
        continue;
      }
    }
    const nm = /^(\w+)\(/.exec(rest);
    if (!nm) continue;
    const open = nm[1].length;
    const close = closeParen(rest, open);
    if (close < 0) continue;
    const r = parseRet(rest.slice(close + 1));
    if (!r) continue;
    recs.push({ type: "sys", pid, ts: start, seq: startSeq, name: nm[1], args: splitArgs(rest.slice(open + 1, close)), ...r });
  }
  // Process in start order, so a clone is seen before its child's first act.
  return recs.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
}

/** Parse `strace -f -ttt -s 4096 -xx` output. Returns { effects: Effect[], procs: Proc[] }. */
export function parseStrace(text, { cwd = "/", rootPid } = {}) {
  const recs = readRecords(text);
  const effects = [];
  const procs = new Map(); // pid -> Proc
  const state = new Map(); // tgid -> { cwd, fds: Map<fd, { kind, path, cloexec }> }
  const tgid = new Map(); // tid -> thread group leader pid
  const pendingConnect = new Map(); // "tgid:fd" -> the EINPROGRESS connect effect, until SO_ERROR says how it ended
  const root = rootPid ?? recs[0]?.pid;
  if (root == null) return { effects, procs: [] };
  procs.set(root, { pid: root, ppid: null, ts_start: null, ts_end: null });
  state.set(root, { cwd, fds: new Map() });

  const leader = (pid) => tgid.get(pid) ?? pid;
  const st = (pid) => {
    const g = leader(pid);
    if (!state.has(g)) {
      // A pid seen with no clone line: no parent known, no fds inherited.
      state.set(g, { cwd, fds: new Map() });
      if (!procs.has(g)) procs.set(g, { pid: g, ppid: null, ts_start: null, ts_end: null });
    }
    return state.get(g);
  };
  const abs = (pid, p, dirArg) => {
    if (p == null) return null;
    if (p.startsWith("/")) return posix.normalize(p);
    let base = st(pid).cwd;
    const d = dirArg?.trim();
    if (d && d !== "AT_FDCWD" && /^-?\d+/.test(d)) {
      const f = st(pid).fds.get(Number.parseInt(d, 10));
      if (f?.kind === "file" && f.path) base = f.path;
    }
    return posix.resolve(base, p);
  };
  const push = (r, e) => {
    const eff = { source: "strace", ok: r.errno == null, kind: e.kind, ts: r.ts, pid: leader(r.pid), ...e };
    if (r.errno != null) eff.errno = r.errno;
    effects.push(eff);
  };
  const setFd = (pid, fd, entry) => {
    if (Number.isInteger(fd) && fd >= 0) st(pid).fds.set(fd, entry);
  };

  for (const r of recs) {
    if (r.type === "exit") {
      const g = leader(r.pid);
      if (g === r.pid) {
        const p = procs.get(g) ?? { pid: g, ppid: null, ts_start: null, ts_end: null };
        p.ts_end = r.ts;
        procs.set(g, p);
      }
      continue;
    }
    const a = r.args;
    const ok = r.errno == null;
    switch (r.name) {
      case "open":
      case "openat":
      case "openat2":
      case "creat": {
        let path, flags, dir;
        if (r.name === "open") [path, flags] = [str(a[0]), flagList(a[1])];
        else if (r.name === "creat") [path, flags] = [str(a[0]), ["O_WRONLY", "O_CREAT", "O_TRUNC"]];
        else if (r.name === "openat") [dir, path, flags] = [a[0], str(a[1]), flagList(a[2])];
        else [dir, path, flags] = [a[0], str(a[1]), flagList(/flags=([^,}]*)/.exec(a[2] ?? "")?.[1])];
        const p = abs(r.pid, path, dir);
        push(r, { kind: "open", path: p, flags });
        if (ok) setFd(r.pid, r.ret, { kind: "file", path: p, cloexec: flags.includes("O_CLOEXEC") });
        break;
      }
      case "write":
      case "pwrite64":
      case "writev":
      case "pwritev":
      case "pwritev2": {
        const f = st(r.pid).fds.get(Number.parseInt(a[0], 10));
        if (f?.kind !== "file") break; // sockets, pipes and fds opened before the trace are not file writes
        const bytes = r.name.endsWith("v") || r.name.endsWith("v2") ? strs(a[1]).join("") : (str(a[1]) ?? "");
        const e = { kind: "write", path: f.path, bytes };
        if (ok) e.n = r.ret;
        push(r, e);
        break;
      }
      case "sendfile":
      case "sendfile64":
      case "copy_file_range":
      case "splice": {
        // The kernel copies the bytes; strace never sees them, so `bytes` is left out (unknown).
        const outArg = r.name === "copy_file_range" || r.name === "splice" ? a[2] : a[0];
        const f = st(r.pid).fds.get(Number.parseInt(outArg, 10));
        if (f?.kind !== "file") break;
        const e = { kind: "write", path: f.path };
        if (ok) e.n = r.ret;
        push(r, e);
        break;
      }
      case "close":
        if (ok) {
          st(r.pid).fds.delete(Number.parseInt(a[0], 10));
          pendingConnect.delete(`${leader(r.pid)}:${Number.parseInt(a[0], 10)}`);
        }
        break;
      case "dup":
      case "dup2":
      case "dup3": {
        if (!ok) break;
        const f = st(r.pid).fds.get(Number.parseInt(a[0], 10));
        const cloexec = r.name === "dup3" && /O_CLOEXEC/.test(a[2] ?? "");
        if (f) setFd(r.pid, r.ret, { ...f, cloexec });
        else st(r.pid).fds.delete(r.ret);
        break;
      }
      case "fcntl":
      case "fcntl64": {
        if (!ok) break;
        const cmd = a[1] ?? "";
        const f = st(r.pid).fds.get(Number.parseInt(a[0], 10));
        if (/^F_DUPFD/.test(cmd) && f) setFd(r.pid, r.ret, { ...f, cloexec: cmd === "F_DUPFD_CLOEXEC" });
        else if (cmd === "F_SETFD" && f) f.cloexec = /FD_CLOEXEC/.test(a[2] ?? "");
        break;
      }
      case "socket":
      case "socketpair":
      case "pipe":
      case "pipe2":
      case "eventfd":
      case "eventfd2":
      case "epoll_create":
      case "epoll_create1":
      case "memfd_create":
      case "io_uring_setup":
      case "accept":
      case "accept4": {
        if (!ok) break;
        const kind = /socket|accept/.test(r.name) ? "socket" : /pipe/.test(r.name) ? "pipe" : "other";
        if (r.name === "pipe" || r.name === "pipe2" || r.name === "socketpair") {
          const arr = r.name === "socketpair" ? a[3] : a[0];
          for (const n of (arr ?? "").match(/-?\d+/g) ?? []) setFd(r.pid, Number(n), { kind, path: null, cloexec: false });
        } else setFd(r.pid, r.ret, { kind, path: null, cloexec: false });
        break;
      }
      case "clone":
      case "clone3":
      case "fork":
      case "vfork": {
        if (!ok || !(r.ret > 0)) break;
        const flags = r.name === "clone3" ? (/flags=([^,}]*)/.exec(a[0] ?? "")?.[1] ?? "") : (/flags=([^,]*)/.exec(a.join(","))?.[1] ?? "");
        const parent = leader(r.pid);
        if (/CLONE_THREAD/.test(flags)) {
          tgid.set(r.ret, parent); // a thread acts as its process: same pid, cwd and fds
          break;
        }
        const ps = st(r.pid);
        const fds = /CLONE_FILES/.test(flags) ? ps.fds : new Map([...ps.fds].map(([k, v]) => [k, { ...v }]));
        state.set(r.ret, { cwd: ps.cwd, fds });
        procs.set(r.ret, { pid: r.ret, ppid: parent, ts_start: r.ts, ts_end: procs.get(r.ret)?.ts_end ?? null });
        break;
      }
      case "execve":
      case "execveat": {
        const [dir, pathArg, argvArg] = r.name === "execve" ? [undefined, a[0], a[1]] : [a[0], a[1], a[2]];
        push(r, { kind: "exec", path: abs(r.pid, str(pathArg), dir), argv: strs(argvArg) });
        if (ok) {
          // execve unshares a CLONE_FILES table first, so the cloexec drop never reaches the sharer.
          const s = st(r.pid);
          s.fds = new Map([...s.fds].filter(([, v]) => !v.cloexec).map(([k, v]) => [k, { ...v }]));
        }
        break;
      }
      case "chdir":
        if (ok) st(r.pid).cwd = abs(r.pid, str(a[0]));
        break;
      case "fchdir": {
        const f = st(r.pid).fds.get(Number.parseInt(a[0], 10));
        if (ok && f?.path) st(r.pid).cwd = f.path;
        break;
      }
      case "rename":
        push(r, { kind: "rename", path: abs(r.pid, str(a[0])), path2: abs(r.pid, str(a[1])) });
        break;
      case "renameat":
      case "renameat2":
        push(r, { kind: "rename", path: abs(r.pid, str(a[1]), a[0]), path2: abs(r.pid, str(a[3]), a[2]) });
        break;
      case "truncate":
        // A truncate is not a write: it sets the length (P4, request from #7).
        push(r, { kind: "truncate", path: abs(r.pid, str(a[0])), size: sizeArg(a[1]) });
        break;
      case "ftruncate":
      case "ftruncate64": {
        const f = st(r.pid).fds.get(Number.parseInt(a[0], 10));
        if (f?.kind !== "file") break;
        push(r, { kind: "truncate", path: f.path, size: sizeArg(a[1]) });
        break;
      }
      case "unlink":
      case "rmdir":
        push(r, { kind: "unlink", path: abs(r.pid, str(a[0])) });
        break;
      case "unlinkat":
        push(r, { kind: "unlink", path: abs(r.pid, str(a[1]), a[0]) });
        break;
      case "connect": {
        const addr = sockaddrText(a[1]);
        if (!addr) break; // AF_UNIX and other local families are not network effects
        // A non-blocking connect returns EINPROGRESS: the connection was started. It counts as
        // ok until a later getsockopt(SO_ERROR) on the same fd reports how it ended (DECISIONS.md, P3a).
        if (r.errno === "EINPROGRESS") {
          push({ ...r, errno: null }, { kind: "connect", addr });
          pendingConnect.set(`${leader(r.pid)}:${Number.parseInt(a[0], 10)}`, effects[effects.length - 1]);
        } else push(r, { kind: "connect", addr });
        break;
      }
      case "getsockopt": {
        if (!ok || a[2] !== "SO_ERROR") break;
        const k = `${leader(r.pid)}:${Number.parseInt(a[0], 10)}`;
        const e = pendingConnect.get(k);
        const v = /^\[(\w+)\]$/.exec(a[3] ?? "")?.[1];
        if (!e || v == null) break;
        pendingConnect.delete(k);
        if (v !== "0") {
          e.ok = false;
          e.errno = /^\d+$/.test(v) ? (ERRNO[Number(v)] ?? `E${v}`) : v;
        }
        break;
      }
      default:
        break;
    }
  }
  return { effects, procs: [...procs.values()] };
}

/** A length argument (decimal, or hex as strace may print it), or null when unreadable. */
function sizeArg(arg) {
  const t = (arg ?? "").trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16);
  return null;
}

/** `{sa_family=AF_INET, sin_port=htons(P), sin_addr=inet_addr("A")}` -> "A:P"; IPv6 -> "[A]:P"; else null. */
function sockaddrText(arg) {
  if (!arg) return null;
  const port = /sin6?_port=htons\((\d+)\)/.exec(arg)?.[1];
  if (port == null) return null;
  if (/AF_INET6/.test(arg)) {
    const ip = /inet_pton\(AF_INET6,\s*"([^"]*)"/.exec(arg)?.[1];
    return ip ? `[${decodeCString(ip)}]:${port}` : null;
  }
  const ip = /inet_addr\("([^"]*)"\)/.exec(arg)?.[1];
  return ip ? `${decodeCString(ip)}:${port}` : null;
}

// ---------------------------------------------------------------- parseAudit

const ERRNO = {
  1: "EPERM", 2: "ENOENT", 4: "EINTR", 5: "EIO", 9: "EBADF", 11: "EAGAIN", 12: "ENOMEM", 13: "EACCES",
  17: "EEXIST", 20: "ENOTDIR", 21: "EISDIR", 22: "EINVAL", 23: "ENFILE", 24: "EMFILE", 28: "ENOSPC",
  30: "EROFS", 36: "ENAMETOOLONG", 40: "ELOOP", 95: "EOPNOTSUPP", 97: "EAFNOSUPPORT", 98: "EADDRINUSE",
  99: "EADDRNOTAVAIL", 100: "ENETDOWN", 101: "ENETUNREACH", 103: "ECONNABORTED", 104: "ECONNRESET",
  110: "ETIMEDOUT", 111: "ECONNREFUSED", 113: "EHOSTUNREACH", 114: "EALREADY", 115: "EINPROGRESS",
};
const URING_OPS = { 18: "openat", 28: "openat2", 16: "connect" };

/** key=value fields of one audit record. Quoted values are text; bare values may be hex-encoded text. */
function auditFields(body) {
  const out = {};
  const re = /(\w+)=("([^"]*)"|\S+)/g;
  let m;
  while ((m = re.exec(body))) out[m[1]] = m[3] !== undefined ? { text: m[3], quoted: true } : { text: m[2], quoted: false };
  return out;
}

/** An audit string field: quoted is literal; unquoted hex is the encoded form auditd uses for unusual bytes. */
function auditString(f) {
  if (!f) return null;
  if (f.quoted) return f.text;
  if (f.text === "(null)") return null;
  if (/^([0-9A-Fa-f]{2})+$/.test(f.text)) return Buffer.from(f.text, "hex").toString("utf8");
  return f.text;
}

function saddrText(hex) {
  if (!hex || !/^([0-9A-Fa-f]{2})+$/.test(hex)) return null;
  const b = Buffer.from(hex, "hex");
  if (b.length < 4) return null;
  const family = b.readUInt16LE(0);
  const port = b.readUInt16BE(2);
  if (family === 2 && b.length >= 8) return `${b[4]}.${b[5]}.${b[6]}.${b[7]}:${port}`;
  if (family === 10 && b.length >= 24) {
    const words = [];
    for (let i = 8; i < 24; i += 2) words.push(b.readUInt16BE(i).toString(16));
    return `${new URL(`http://[${words.join(":")}]/`).hostname}:${port}`; // URL gives the compressed form
  }
  return null;
}

/** Parse auditd records from the `-a always,io_uring` rule. Returns Effect[] with source "audit-io_uring". */
export function parseAudit(text) {
  const groups = new Map(); // serial -> { ts, recs: [{ type, f }] }
  for (const line of text.split("\n")) {
    const m = /type=(\w+)\s+msg=audit\((\d+\.\d+):(\d+)\):\s*(.*)$/.exec(line);
    if (!m) continue;
    const serial = m[3];
    if (!groups.has(serial)) groups.set(serial, { ts: round6(parseFloat(m[2])), recs: [] });
    groups.get(serial).recs.push({ type: m[1], f: auditFields(m[4]) });
  }
  const effects = [];
  for (const g of groups.values()) {
    const op = g.recs.find((r) => r.type === "URINGOP");
    if (!op) continue;
    const name = URING_OPS[Number(op.f.uring_op?.text)];
    if (!name) continue;
    const ok = op.f.success?.text === "yes";
    const exit = Number(op.f.exit?.text);
    const e = { source: "audit-io_uring", ok, ts: g.ts, pid: Number(op.f.pid?.text) };
    if (name === "connect") {
      const sa = g.recs.find((r) => r.type === "SOCKADDR");
      const addr = saddrText(sa?.f.saddr?.text);
      if (!addr) continue; // not an IP connect
      Object.assign(e, { kind: "connect", addr });
    } else {
      const cwd = auditString(g.recs.find((r) => r.type === "CWD")?.f.cwd) ?? "/";
      const paths = g.recs.filter((r) => r.type === "PATH");
      const item = paths.find((r) => r.f.nametype?.text !== "PARENT") ?? paths[0];
      const name = auditString(item?.f.name);
      const e2 = { kind: "open", path: name == null ? null : posix.resolve(cwd, name), flags: null };
      if (paths.some((r) => r.f.nametype?.text === "CREATE")) e2.created = true;
      else e2.created = false;
      Object.assign(e, e2);
    }
    if (!ok) e.errno = ERRNO[-exit] ?? (Number.isFinite(exit) ? `E${-exit}` : "EUNKNOWN");
    effects.push(e);
  }
  return effects.sort((a, b) => a.ts - b.ts);
}

// -------------------------------------------------------------- mergeEffects

/** Merge strace and audit effects. Both sources are kept (they see different syscalls); sorted by ts, strace first on a tie. */
export function mergeEffects(straceEffects, auditEffects) {
  const tagged = [
    ...straceEffects.map((e, i) => ({ e, s: 0, i })),
    ...auditEffects.map((e, i) => ({ e, s: 1, i })),
  ];
  tagged.sort((x, y) => x.e.ts - y.e.ts || x.s - y.s || x.i - y.i);
  return tagged.map((t) => t.e);
}

// ---------------------------------------------------------------- costReport

function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Summarise the recorder's cost from paired traced and untraced wall times (ms). */
export function costReport(samples) {
  const ok = (samples ?? []).filter((s) => Number.isFinite(s.traced_ms) && Number.isFinite(s.untraced_ms) && s.untraced_ms > 0);
  return {
    n: ok.length,
    median_traced_ms: median(ok.map((s) => s.traced_ms)),
    median_untraced_ms: median(ok.map((s) => s.untraced_ms)),
    overhead_ratio: median(ok.map((s) => s.traced_ms / s.untraced_ms)),
  };
}

// -------------------------------------------------------------------- record

export const STRACE_ARGS = ["--kill-on-exit", "-f", "-ttt", "-s", "4096", "-xx", "-e", "trace=%file,%desc,%process,%network,chdir,fchdir"];

const ENV_KEEP = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"];
const minimalEnv = () => Object.fromEntries(ENV_KEEP.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));

/**
 * Run argv under strace (and read the audit log if available). Returns { effects, procs, root_pid, cost, exit }.
 * Not exercised by red tests (ci has no strace). opts:
 *   cwd        work folder the agent starts in (default process.cwd())
 *   env        environment for the agent. Default: only PATH, HOME, LANG, LC_ALL, TERM and TMPDIR
 *              from process.env, so the harness's own tokens never reach the agent under test
 *              (P4 security review, SL-P4-r0-S1). Pass every other variable explicitly.
 *   auditLog   path of an audit log that holds the io_uring rule's records (read after the run, filtered to the run's pids and time)
 *   strace     strace binary (default "strace")
 *   traceFile  where strace writes (default a fresh temp folder, removed afterwards unless keepTrace).
 *              It may not be inside cwd: the agent could rewrite its own trace (SL-P4-r0-S2).
 *   timeoutMs  kill the run after this long (default none). `--kill-on-exit` makes the kernel kill
 *              every tracee when strace dies, so no part of the agent outlives the trace.
 *   stdio      passed to spawn (default "ignore")
 */
export async function record(argv, opts = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error("record: argv must be a non-empty array");
  const cwd = opts.cwd ?? process.cwd();
  if (opts.traceFile) {
    const rel = posix.relative(posix.resolve(cwd), posix.resolve(cwd, opts.traceFile));
    if (rel !== ".." && !rel.startsWith("../") && !posix.isAbsolute(rel)) throw new Error("record: traceFile must be outside cwd, where the agent cannot rewrite it");
  }
  const dir = opts.traceFile ? null : mkdtempSync(joinPath(tmpdir(), "sl-rec-"));
  const traceFile = opts.traceFile ?? joinPath(dir, "trace.strace");
  const t0 = performance.now();
  const wall0 = Date.now() / 1000;
  let exit;
  try {
    exit = await new Promise((resolve, reject) => {
      const child = spawn(opts.strace ?? "strace", [...STRACE_ARGS, "-o", traceFile, "--", ...argv], {
        cwd,
        env: opts.env ?? minimalEnv(),
        stdio: opts.stdio ?? "ignore",
      });
      let timer = null;
      if (opts.timeoutMs) timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
      child.on("error", (e) => {
        if (timer) clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        resolve({ code, signal });
      });
    });
  } catch (e) {
    if (dir && !opts.keepTrace) rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const traced_ms = performance.now() - t0;
  const wall1 = Date.now() / 1000;
  try {
    if (!existsSync(traceFile)) throw new Error(`record: strace wrote no trace (exit ${exit.code}, signal ${exit.signal})`);
    const { effects: sEffects, procs } = parseStrace(readFileSync(traceFile, "utf8"), { cwd });
    let aEffects = [];
    if (opts.auditLog && existsSync(opts.auditLog)) {
      const pids = new Set(procs.map((p) => p.pid));
      aEffects = parseAudit(readFileSync(opts.auditLog, "utf8")).filter((e) => pids.has(e.pid) && e.ts >= wall0 - 1 && e.ts <= wall1 + 1);
    }
    // parseStrace puts the traced root first (the pid of the trace's first line).
    // join() needs it, so record() returns it (P4, cross-lane seam).
    const root_pid = procs[0]?.pid ?? null;
    return { effects: mergeEffects(sEffects, aEffects), procs, root_pid, cost: { traced_ms }, exit };
  } finally {
    if (dir && !opts.keepTrace) rmSync(dir, { recursive: true, force: true });
  }
}
