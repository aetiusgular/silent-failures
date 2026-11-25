// Local stub servers for tasks with `stubs` (contracts/tasks.md), written in P4
// for the cross-lane tests. Each route serves its responses in order, then
// repeats the last one; unknown routes get 404. Every request is appended to a
// JSONL stub log in the contracts/types.md shape. Listens on 127.0.0.1 only.
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

/** Start one server per stub. Returns { addrs, urls, logPath, close }. */
export async function startStubs(stubs, logPath) {
  writeFileSync(logPath, "");
  const servers = [];
  const addrs = {};
  const urls = {};
  for (const stub of stubs ?? []) {
    const served = new Map(); // "METHOD path" -> count
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const path = new URL(req.url, "http://stub").pathname;
        const route = (stub.routes ?? []).find((r) => r.method === req.method && r.path === path);
        let status = 404;
        let body = "not found";
        if (route) {
          const key = `${req.method} ${path}`;
          const i = served.get(key) ?? 0;
          served.set(key, i + 1);
          const r = route.responses[Math.min(i, route.responses.length - 1)];
          status = r.status;
          body = r.body ?? "";
        }
        appendFileSync(logPath, JSON.stringify({ ts: Date.now() / 1000, stub: stub.name, method: req.method, path, status, body: Buffer.concat(chunks).toString("utf8") }) + "\n");
        res.writeHead(status, { "content-type": "text/plain" });
        res.end(body);
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    addrs[stub.name] = `127.0.0.1:${port}`;
    urls[stub.name] = `http://127.0.0.1:${port}`;
    servers.push(server);
  }
  const close = () => Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return { addrs, urls, logPath, close };
}
