# silent-failures

Agent runs that report success while their recorded effects say otherwise, and a gate that catches them.

Built in phases with the forge method. The pick and the headline are in `SPEC.md`. Phase P2 (base) holds the following: the contracts in `contracts/`, 40 tasks with end-state oracles in `fixtures/tasks/` and `oracle/`, the frozen dev/heldout split, and 47 red tests for lanes P3a to P3c. No results yet.


## Lane P3a: recorder and join

`src/recorder/` parses `strace -f -ttt -s 4096 -xx` output and the io_uring audit records into effects, and `record()` runs a command under strace. `src/join/` credits each effect to a tool call with the rule in `contracts/types.md`. Beyond the red tests, the lane handles the following:
- Threads (`CLONE_THREAD`) act as their process. Node's thread pool writes are credited to the node process.
- `O_CLOEXEC` fds are dropped on exec. `CLONE_FILES` shares the fd table until the child execs.
- strace runs with `--kill-on-exit`, so a `timeoutMs` kill ends the whole traced tree.
- Writes to pipes, sockets and fds opened before the trace started are not file writes.
- A non-blocking connect (`EINPROGRESS`) counts as ok until a later `getsockopt(SO_ERROR)` on the same fd reports an error.
- `sendfile`, `copy_file_range` and `splice` are writes whose bytes are unknown, so `bytes` is left out.

What ran (2026-11-24, local Linux worktree, kernel 7.0.0, Node v24.22.1, strace 6.19):
- `bash scripts/forge-gate.sh P3a` passed. The 15 P3a red tests are green, and the 32 P3b and P3c tests still fail for their stated reason.
- `bash scripts/test.sh` passed: the P2 oracle tests plus 25 lane unit tests (22 in round 1, plus 3 from review round 1).
- Two unit tests run `record()` under a real strace. One covers a shell redirect, mv, rm, a node thread-pool write and a connect to a local listener. The other checks that a timeout leaves no survivor. Both skip where strace or ptrace is not available, which may include ci.
- No model ran and no results row was written. The recorder's cost on real runs is measured in P5.
