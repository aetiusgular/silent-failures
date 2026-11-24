// Lane P3a unit tests for the recorder, beyond the red tests: strace and audit forms the
// P2 fixture does not show, and record() against a real strace when this machine has one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { createServer } from "node:net";
import { parseStrace, parseAudit, mergeEffects, costReport, record, decodeCString, splitArgs } from "./index.mjs";

const hex = (s) => [...Buffer.from(s, "utf8")].map((b) => `\\x${b.toString(16).padStart(2, "0")}`).join("");
const q = (s) => `"${hex(s)}"`;
const L = (pid, t, rest) => `${pid} ${(1764000000 + t).toFixed(6)} ${rest}`;
const lines = (...xs) => xs.join("\n") + "\n";
const only = (effects, kind) => effects.filter((e) => e.kind === kind);

test("decodeCString handles hex, C escapes and octal", () => {
  assert.equal(decodeCString("\\x68\\x69\\n\\t\\\\\\\"\\101"), 'hi\n\t\\"A');
  assert.equal(decodeCString(hex("héllo")), "héllo");
});

test("splitArgs keeps strings, arrays and structs whole", () => {
  assert.deepEqual(splitArgs('3, "a,b", [1, 2], {x=1, y=2}, 0x10 /* c, d */'), ["3", '"a,b"', "[1, 2]", "{x=1, y=2}", "0x10 /* c, d */"]);
});

test("threads act as their process: same pid, shared fds", () => {
  const { effects, procs } = parseStrace(
    lines(
      L(10, 0.1, `openat(AT_FDCWD, ${q("a.txt")}, O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC, 0644) = 7`),
      L(10, 0.2, "clone3({flags=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD|CLONE_SYSVSEM, exit_signal=0} => {parent_tid=[11]}, 88) = 11"),
      L(11, 0.3, `write(7, ${q("from thread")}, 11) = 11`),
      L(11, 0.4, "+++ exited with 0 +++"),
      L(10, 0.5, "+++ exited with 0 +++"),
    ),
    { cwd: "/w" },
  );
  const [w] = only(effects, "write");
  assert.equal(w.pid, 10);
  assert.equal(w.path, "/w/a.txt");
  assert.equal(w.bytes, "from thread");
  assert.deepEqual(procs.map((p) => p.pid), [10], "a thread is not a separate process");
  assert.equal(procs[0].ts_end, 1764000000.5, "a thread's exit does not end its process");
});

test("a forked child gets a copy of the fd table; its close does not touch the parent's", () => {
  const { effects } = parseStrace(
    lines(
      L(10, 0.1, `openat(AT_FDCWD, ${q("log")}, O_WRONLY|O_CREAT|O_APPEND, 0644) = 3`),
      L(10, 0.2, "clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x1) = 20"),
      L(20, 0.3, "close(3) = 0"),
      L(10, 0.4, `write(3, ${q("parent")}, 6) = 6`),
      L(20, 0.5, `write(3, ${q("child")}, 5) = -1 EBADF (Bad file descriptor)`),
    ),
    { cwd: "/w" },
  );
  const writes = only(effects, "write");
  assert.equal(writes.length, 1, "the child's write on a closed fd is not a file write");
  assert.equal(writes[0].pid, 10);
});

test("O_CLOEXEC fds are gone after exec; dup2 targets survive", () => {
  const { effects } = parseStrace(
    lines(
      L(10, 0.1, `openat(AT_FDCWD, ${q("secret")}, O_WRONLY|O_CREAT|O_CLOEXEC, 0600) = 4`),
      L(10, 0.11, `openat(AT_FDCWD, ${q("out.log")}, O_WRONLY|O_CREAT|O_TRUNC, 0644) = 5`),
      L(10, 0.12, "dup2(5, 1) = 1"),
      L(10, 0.2, `execve(${q("/bin/prog")}, [${q("prog")}], 0x7ffd /* 3 vars */) = 0`),
      L(10, 0.3, `write(4, ${q("x")}, 1) = 1`),
      L(10, 0.4, `write(1, ${q("ok\n")}, 3) = 3`),
    ),
    { cwd: "/w" },
  );
  assert.deepEqual(only(effects, "write").map((e) => [e.path, e.bytes]), [["/w/out.log", "ok\n"]]);
});

test("writes to pipes, sockets and fds opened before the trace are not file writes", () => {
  const { effects } = parseStrace(
    lines(
      L(10, 0.1, "pipe2([3, 4], O_CLOEXEC) = 0"),
      L(10, 0.2, `write(4, ${q("pipe")}, 4) = 4`),
      L(10, 0.3, "socket(AF_INET, SOCK_STREAM, IPPROTO_TCP) = 5"),
      L(10, 0.4, `write(5, ${q("GET /")}, 5) = 5`),
      L(10, 0.5, `write(1, ${q("stdout")}, 6) = 6`),
    ),
    { cwd: "/w" },
  );
  assert.equal(only(effects, "write").length, 0);
});

test("writev joins its iovecs; sendfile and copy_file_range write with unknown bytes", () => {
  const { effects } = parseStrace(
    lines(
      L(10, 0.1, `openat(AT_FDCWD, ${q("v.txt")}, O_WRONLY|O_CREAT, 0644) = 3`),
      L(10, 0.2, `writev(3, [{iov_base=${q("ab")}, iov_len=2}, {iov_base=${q("cd")}, iov_len=2}], 2) = 4`),
      L(10, 0.3, `openat(AT_FDCWD, ${q("src")}, O_RDONLY) = 4`),
      L(10, 0.4, `openat(AT_FDCWD, ${q("dst")}, O_WRONLY|O_CREAT|O_TRUNC, 0644) = 5`),
      L(10, 0.5, "copy_file_range(4, NULL, 5, NULL, 9223372035781033984, 0) = 12"),
      L(10, 0.6, "sendfile(5, 4, NULL, 100) = 0"),
    ),
    { cwd: "/w" },
  );
  const [v, c, s] = only(effects, "write");
  assert.equal(v.bytes, "abcd");
  assert.equal(v.n, 4);
  assert.equal(c.path, "/w/dst");
  assert.equal(c.n, 12);
  assert.ok(!("bytes" in c), "copied bytes are unknown, not empty");
  assert.equal(s.path, "/w/dst");
});

test("renameat2, unlinkat with a dir fd, openat2 and creat resolve their paths", () => {
  const { effects } = parseStrace(
    lines(
      L(10, 0.1, `openat(AT_FDCWD, ${q("sub")}, O_RDONLY|O_DIRECTORY) = 3`),
      L(10, 0.2, `renameat2(AT_FDCWD, ${q("a")}, 3, ${q("b")}, RENAME_NOREPLACE) = 0`),
      L(10, 0.3, `unlinkat(3, ${q("old")}, 0) = 0`),
      L(10, 0.4, `openat2(AT_FDCWD, ${q("../x/./y")}, {flags=O_WRONLY|O_CREAT, mode=0644, resolve=0}, 24) = 4`),
      L(10, 0.5, `creat(${q("/abs/c")}, 0644) = 5`),
      L(10, 0.6, `rmdir(${q("gone")}) = 0`),
    ),
    { cwd: "/w/d" },
  );
  const [rn] = only(effects, "rename");
  assert.deepEqual([rn.path, rn.path2], ["/w/d/a", "/w/d/sub/b"]);
  assert.deepEqual(only(effects, "unlink").map((e) => e.path), ["/w/d/sub/old", "/w/d/gone"]);
  const opens = only(effects, "open");
  assert.deepEqual(opens[1], { source: "strace", ok: true, kind: "open", ts: 1764000000.4, pid: 10, path: "/w/x/y", flags: ["O_WRONLY", "O_CREAT"] });
  assert.deepEqual(opens[2].flags, ["O_WRONLY", "O_CREAT", "O_TRUNC"]);
});

test("a non-blocking connect is ok until SO_ERROR says otherwise", () => {
  const { effects } = parseStrace(
    lines(
      L(10, 0.1, "socket(AF_INET, SOCK_STREAM|SOCK_NONBLOCK, IPPROTO_TCP) = 5"),
      L(10, 0.2, `connect(5, {sa_family=AF_INET, sin_port=htons(9), sin_addr=inet_addr(${q("127.0.0.1")})}, 16) = -1 EINPROGRESS (Operation now in progress)`),
      L(10, 0.3, "getsockopt(5, SOL_SOCKET, SO_ERROR, [ECONNREFUSED], [4]) = 0"),
      L(10, 0.4, "socket(AF_INET, SOCK_STREAM|SOCK_NONBLOCK, IPPROTO_TCP) = 6"),
      L(10, 0.5, `connect(6, {sa_family=AF_INET, sin_port=htons(8080), sin_addr=inet_addr(${q("127.0.0.1")})}, 16) = -1 EINPROGRESS (Operation now in progress)`),
      L(10, 0.6, "getsockopt(6, SOL_SOCKET, SO_ERROR, [0], [4]) = 0"),
      L(10, 0.7, `connect(7, {sa_family=AF_INET6, sin6_port=htons(443), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, ${q("::1")}, &sin6_addr), sin6_scope_id=0}, 28) = 0`),
      L(10, 0.8, `connect(8, {sa_family=AF_UNIX, sun_path=${q("/run/nscd/socket")}}, 110) = -1 ENOENT (No such file or directory)`),
    ),
    { cwd: "/w" },
  );
  const cs = only(effects, "connect");
  assert.deepEqual(cs.map((e) => [e.addr, e.ok, e.errno]), [
    ["127.0.0.1:9", false, "ECONNREFUSED"],
    ["127.0.0.1:8080", true, undefined],
    ["[::1]:443", true, undefined],
  ]);
});

test("failed execve is kept as ok:false; a kill ends the process; a lone resume is skipped", () => {
  const { effects, procs } = parseStrace(
    lines(
      L(10, 0.1, `execve(${q("/usr/local/bin/x")}, [${q("x")}], 0x1 /* 2 vars */) = -1 ENOENT (No such file or directory)`),
      L(10, 0.2, "<... openat resumed>) = 3"),
      L(10, 0.3, "--- SIGTERM {si_signo=SIGTERM, si_code=SI_USER, si_pid=1, si_uid=0} ---"),
      L(10, 0.4, "+++ killed by SIGKILL +++"),
    ),
    { cwd: "/w" },
  );
  assert.equal(effects.length, 1);
  assert.deepEqual([effects[0].kind, effects[0].ok, effects[0].errno, effects[0].argv], ["exec", false, "ENOENT", ["x"]]);
  assert.equal(procs[0].ts_end, 1764000000.4);
});

test("a child that writes before its parent's clone returns still inherits the parent's state", () => {
  const { effects, procs } = parseStrace(
    lines(
      L(10, 0.1, `chdir(${q("/w/sub")}) = 0`),
      L(10, 0.2, "clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>"),
      L(20, 0.21, `openat(AT_FDCWD, ${q("f")}, O_WRONLY|O_CREAT, 0644) = 3`),
      L(10, 0.22, "<... clone resumed>) = 20"),
    ),
    { cwd: "/w" },
  );
  assert.equal(effects[0].path, "/w/sub/f");
  assert.equal(procs.find((p) => p.pid === 20).ppid, 10);
  assert.equal(procs.find((p) => p.pid === 20).ts_start, 1764000000.2);
});

test("parseAudit: hex-encoded names, PARENT items, IPv6, other ops and other records", () => {
  const name = Buffer.from("dir/my file").toString("hex").toUpperCase();
  const text = lines(
    "type=SYSCALL msg=audit(1764000000.100:1): arch=c000003e syscall=257 success=yes exit=3 pid=10",
    "type=URINGOP msg=audit(1764000000.200:2): uring_op=28 success=no exit=-2 items=2 ppid=1 pid=10",
    'type=CWD msg=audit(1764000000.200:2): cwd="/w"',
    'type=PATH msg=audit(1764000000.200:2): item=0 name="dir/" nametype=PARENT',
    `type=PATH msg=audit(1764000000.200:2): item=1 name=${name} nametype=UNKNOWN`,
    "type=URINGOP msg=audit(1764000000.300:3): uring_op=16 success=yes exit=0 items=0 ppid=1 pid=10",
    "type=SOCKADDR msg=audit(1764000000.300:3): saddr=0A0001BB000000000000000000000000000000000000000100000000",
    "type=URINGOP msg=audit(1764000000.400:4): uring_op=22 success=yes exit=0 items=0 ppid=1 pid=10",
    "type=URINGOP msg=audit(1764000000.500:5): uring_op=16 success=yes exit=0 items=0 ppid=1 pid=10",
    "type=SOCKADDR msg=audit(1764000000.500:5): saddr=01002F746D702F73",
  );
  const e = parseAudit(text);
  assert.equal(e.length, 2, "only openat, openat2 and IP connects are effects");
  assert.deepEqual(e[0], { source: "audit-io_uring", ok: false, ts: 1764000000.2, pid: 10, kind: "open", path: "/w/dir/my file", flags: null, created: false, errno: "ENOENT" });
  assert.deepEqual([e[1].kind, e[1].addr, e[1].ok], ["connect", "[::1]:443", true]);
});

test("mergeEffects keeps every effect and puts strace first on a tie", () => {
  const s = [{ ts: 2, source: "strace", id: "s2" }, { ts: 1, source: "strace", id: "s1" }];
  const a = [{ ts: 1, source: "audit-io_uring", id: "a1" }, { ts: 3, source: "audit-io_uring", id: "a3" }];
  assert.deepEqual(mergeEffects(s, a).map((e) => e.id), ["s1", "a1", "s2", "a3"]);
});

test("costReport: even sample counts take the middle mean; no samples gives nulls", () => {
  assert.deepEqual(costReport([{ traced_ms: 4, untraced_ms: 2 }, { traced_ms: 9, untraced_ms: 3 }]), { n: 2, median_traced_ms: 6.5, median_untraced_ms: 2.5, overhead_ratio: 2.5 });
  assert.deepEqual(costReport([]), { n: 0, median_traced_ms: null, median_untraced_ms: null, overhead_ratio: null });
});

// ------------------------------------------------------------- real strace

const canTrace = spawnSync("strace", ["-f", "-o", "/dev/null", "--", "true"], { stdio: "ignore" }).status === 0;

test("record() runs a real command under strace", { skip: canTrace ? false : "strace or ptrace not available here" }, async () => {
  const dir = realpathSync(mkdtempSync(joinPath(tmpdir(), "sl-rec-test-")));
  const server = createServer((s) => s.end());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const script = [
      "mkdir -p out",
      "echo hi > out/a.txt",
      "mv out/a.txt out/b.txt",
      "rm -f out/b.txt",
      `node -e "require('fs').writeFile('out/c.txt','async',()=>{require('net').connect(${port},'127.0.0.1').on('connect',function(){this.end()})})"`,
    ].join(" && ");
    const r = await record(["sh", "-c", script], { cwd: dir, timeoutMs: 30000 });
    assert.equal(r.exit.code, 0);
    assert.ok(r.cost.traced_ms > 0);
    const root = r.procs.find((p) => p.ppid === null);
    assert.ok(root, "the traced root has no parent");
    const has = (pred, what) => assert.ok(r.effects.some(pred), `no ${what}`);
    has((e) => e.kind === "write" && e.path === `${dir}/out/a.txt` && e.bytes === "hi\n" && e.ok, "shell redirect write");
    has((e) => e.kind === "rename" && e.path === `${dir}/out/a.txt` && e.path2 === `${dir}/out/b.txt`, "rename");
    has((e) => e.kind === "unlink" && e.path === `${dir}/out/b.txt`, "unlink");
    has((e) => e.kind === "exec" && e.argv[0] === "mv", "exec of mv");
    has((e) => e.kind === "write" && e.path === `${dir}/out/c.txt` && e.bytes === "async", "write from node's thread pool");
    has((e) => e.kind === "connect" && e.addr === `127.0.0.1:${port}` && e.ok, "connect to the local listener");
    const nodePid = r.effects.find((e) => e.kind === "exec" && e.argv[0] === "node").pid;
    assert.equal(r.effects.find((e) => e.path === `${dir}/out/c.txt` && e.kind === "write").pid, nodePid, "a thread's write is credited to its process");
    for (let i = 1; i < r.effects.length; i++) assert.ok(r.effects[i - 1].ts <= r.effects[i].ts);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("record() rejects an empty argv", async () => {
  await assert.rejects(record([]), /argv must be a non-empty array/);
});
