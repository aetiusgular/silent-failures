// A loopback pass-through from the agents under test to the model server,
// written in P5. Agents connect to 127.0.0.1:<port> inside the sandbox; this
// forwards each request upstream (through srt's proxy when one is set) and
// streams the answer back. It counts requests per run and stores no prompt
// text.
//
// foldSystem: Claude Code sends its environment block as a `role: "system"`
// entry inside `messages`. llama.cpp hands it to the chat template, and the
// agent model's template raises "System message must be at the beginning"
// (derm tests/measure/README.md, "Claude Code against llama.cpp"). Folding moves
// those entries to the end of the top-level `system`; nothing else changes.
import { createServer, request as httpRequest } from "node:http";
import { upstreamOptions, proxyFor } from "./http.mjs";

export function foldSystem(buf) {
  let j;
  try {
    j = JSON.parse(buf.toString("utf8"));
  } catch {
    return { buf, folded: 0 };
  }
  if (!Array.isArray(j.messages)) return { buf, folded: 0 };
  const sys = j.messages.filter((m) => m.role === "system");
  if (!sys.length) return { buf, folded: 0 };
  j.messages = j.messages.filter((m) => m.role !== "system");
  const blocks = sys.flatMap((m) =>
    typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []).filter((b) => b.type === "text").map((b) => ({ type: "text", text: b.text })),
  );
  if (typeof j.system === "string") j.system = [{ type: "text", text: j.system }];
  j.system = [...(j.system ?? []), ...blocks];
  return { buf: Buffer.from(JSON.stringify(j)), folded: sys.length };
}

/** Start the proxy. Returns { url, stats(), reset(), close() }. */
export async function startModelProxy({ upstream, proxy = proxyFor() }) {
  let stats = { requests: 0, errors: 0, folded: 0 };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      if (req.method === "POST" && req.url.startsWith("/v1/messages")) {
        const f = foldSystem(body);
        body = f.buf;
        if (f.folded) stats.folded++;
      }
      stats.requests++;
      const headers = { ...req.headers };
      delete headers.host;
      delete headers.connection;
      headers["content-length"] = body.length;
      const target = new URL(req.url, upstream).href;
      const up = httpRequest(upstreamOptions(target, { method: req.method, headers, proxy }), (ur) => {
        if (ur.statusCode >= 400) stats.errors++;
        res.writeHead(ur.statusCode, ur.headers);
        ur.pipe(res);
      });
      up.on("error", (e) => {
        stats.errors++;
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end(`model proxy: ${e.message}`);
      });
      up.end(body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    stats: () => ({ ...stats }),
    reset: () => (stats = { requests: 0, errors: 0, folded: 0 }),
    close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))),
  };
}
