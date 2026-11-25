// HTTP to the box's model server, written in P5. Inside forge's srt profile the
// only way off the sandbox's loopback is srt's HTTP proxy (HTTP_PROXY), so a
// request to the host's 127.0.0.1:<port> goes through it in absolute form.
// Outside a sandbox (no HTTP_PROXY) the request goes direct.
import { request as httpRequest } from "node:http";

export function proxyFor(env = process.env) {
  const p = env.HTTP_PROXY || env.http_proxy || "";
  if (!p) return null;
  const u = new URL(p);
  const auth = u.username ? "Basic " + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64") : null;
  return { host: u.hostname, port: Number(u.port || 80), auth };
}

/** Options for http.request to `url`, through the proxy when one is set. */
export function upstreamOptions(url, { method = "GET", headers = {}, proxy = proxyFor() } = {}) {
  const u = new URL(url);
  if (u.protocol !== "http:") throw new Error(`only http upstreams: ${url}`);
  if (!proxy) return { host: u.hostname, port: Number(u.port || 80), path: u.pathname + u.search, method, headers };
  const h = { ...headers, host: u.host };
  if (proxy.auth) h["proxy-authorization"] = proxy.auth;
  return { host: proxy.host, port: proxy.port, path: u.href, method, headers: h };
}

/** One request; resolves { status, body } (body as text). */
export function fetchText(url, { method = "GET", body = null, headers = {}, timeoutMs = 30000, proxy } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body != null) {
      h["content-type"] ??= "application/json";
      h["content-length"] = Buffer.byteLength(body);
    }
    const req = httpRequest(upstreamOptions(url, { method, headers: h, proxy }), (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs} ms: ${method} ${url}`)));
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

export async function fetchJson(url, opts) {
  const r = await fetchText(url, opts);
  let json = null;
  try {
    json = JSON.parse(r.body);
  } catch {}
  return { status: r.status, json, body: r.body };
}
