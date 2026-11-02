// superapp: a web page in front of superapp2. Every call it serves calls superapp2 (UPSTREAM_URL), waits for its
// answer and shows it, with timing stats; a load control has superapp call superapp2 at a steady rate. How long
// each upstream call took is the OpenTelemetry histogram superapp.upstream.duration, exported for Prometheus on
// METRICS_PORT. Its memory use can still be driven up on demand (/hog), for the OOMKilled scenarios.
import http from "node:http";
import https from "node:https";
import { metrics } from "@opentelemetry/api";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { MeterProvider } from "@opentelemetry/sdk-metrics";

const port = Number(process.env.PORT ?? 8080);
const metricsPort = Number(process.env.METRICS_PORT ?? 9464);
const upstream = process.env.UPSTREAM_URL ?? "http://superapp2.superapp2";
const timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 15000);

// On every interface: the exporter listens on localhost only unless told otherwise, out of Prometheus's reach.
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [new PrometheusExporter({ host: "0.0.0.0", port: metricsPort })] }));
const upstreamDuration = metrics.getMeter("superapp").createHistogram("superapp.upstream.duration", {
  description: "How long a call to superapp's upstream (superapp2) took, until its answer or failure",
  unit: "s",
  advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15] },
});

/** The latest upstream calls, newest last, for the page's stats. */
const KEPT = 300;
const calls = [];
let errors = 0;

/** Failed calls are logged at most once every LOG_EVERY_MS, with how many failed since. */
const LOG_EVERY_MS = 10_000;
let failedSinceLog = 0;
let lastLog = 0;
function logFailure(status, ms) {
  failedSinceLog++;
  if (Date.now() - lastLog < LOG_EVERY_MS) return;
  console.warn(`upstream ${upstream} failed: ${status} after ${Math.round(ms)} ms (${failedSinceLog} failed calls since the last report)`);
  failedSinceLog = 0;
  lastLog = Date.now();
}

// A connection of its own for every call to superapp2, closed once it has answered (Connection: close).
// superapp2's Service is balanced by kube-proxy per connection, not per request: kept-alive connections, which
// fetch uses by default, pin every call to the superapp2 pod they first reached, so its other replicas get no load.
const upstreamClient = new URL(upstream).protocol === "https:" ? https : http;
const upstreamAgent = new upstreamClient.Agent({ keepAlive: false });

/** GETs url on a fresh connection; resolves with its status code and body, rejects on failure or when signal aborts. */
function getOnce(url, signal) {
  return new Promise((resolve, reject) => {
    const req = upstreamClient.get(url, { agent: upstreamAgent, signal }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

/** Calls the upstream once, records how long it took, and gives back its answer or why it failed. */
async function callUpstream(source) {
  const started = performance.now();
  let status = "ok";
  let answer = null;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await getOnce(upstream, signal);
    if (response.status < 200 || response.status >= 300) status = `http ${response.status}`;
    try {
      answer = JSON.parse(response.body);
    } catch {
      answer = null;
    }
  } catch (error) {
    status = signal.aborted ? "timeout" : `error ${error.code ?? error.message}`;
  }
  const ms = performance.now() - started;
  if (status !== "ok") logFailure(status, ms);
  upstreamDuration.record(ms / 1000, { upstream: "superapp2", outcome: status === "ok" ? "ok" : "error" });
  if (status !== "ok") errors++;
  calls.push({ at: Date.now(), ms, status, source });
  if (calls.length > KEPT) calls.shift();
  return { ms, status, answer };
}

/** The load control: superapp calling the upstream at a steady rate, whether or not earlier calls returned. */
let loadRps = Number(process.env.LOAD_RPS ?? 0);
let loadTimer = null;
function setLoad(rps) {
  loadRps = Math.max(0, Math.min(100, rps));
  if (loadTimer) clearInterval(loadTimer);
  loadTimer = loadRps > 0 ? setInterval(() => void callUpstream("load"), 1000 / loadRps) : null;
}
setLoad(loadRps);

function percentile(sorted, p) {
  return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Timing stats over the last minute, and the latest calls for the chart. */
function stats() {
  const recent = calls.filter((c) => c.at > Date.now() - 60_000);
  const sorted = recent.map((c) => c.ms).sort((a, b) => a - b);
  return {
    upstream,
    loadRps,
    lastMinute: {
      calls: recent.length,
      errors: recent.filter((c) => c.status !== "ok").length,
      avgMs: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      maxMs: sorted.at(-1) ?? null,
    },
    last: calls.at(-1) ?? null,
    errorsSinceStart: errors,
    recent: calls.slice(-120).map((c) => ({ at: c.at, ms: Math.round(c.ms), status: c.status })),
  };
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body) + "\n");
};

const hoard = [];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok\n");
  }
  if (url.pathname === "/hog") {
    // Allocate and retain `mb` megabytes in large touched chunks so the container blows through its
    // memory limit fast enough for the kernel to OOM-kill it rather than thrash at the ceiling.
    const mb = Number(url.searchParams.get("mb") ?? 1024);
    const chunkMb = 64;
    for (let allocated = 0; allocated < mb; allocated += chunkMb) hoard.push(Buffer.alloc(chunkMb * 1024 * 1024, 1));
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end(`hoarding ${hoard.length} MB\n`);
  }
  if (url.pathname === "/api/call") return json(res, 200, await callUpstream("page"));
  if (url.pathname === "/api/stats") return json(res, 200, stats());
  if (url.pathname === "/api/load" && req.method === "POST") {
    setLoad(Number(url.searchParams.get("rps") ?? 0));
    console.log(`load set to ${loadRps} rps`);
    return json(res, 200, { loadRps });
  }
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }
  json(res, 404, { error: "not found" });
});

server.listen(port, () => console.log(`superapp listening on ${port}, calling ${upstream}; metrics on ${metricsPort}/metrics`));

// Node as a container's PID 1 has no default signal handlers: without these, a pod waits out its whole grace
// period before Kubernetes kills it. Stop taking connections, let those in flight finish, and exit.
function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  setLoad(0);
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>superapp</title>
<style>
  :root { --bg: #f6f5f1; --card: #fff; --ink: #1f1d1a; --muted: #6b665e; --line: #e4e1da; --ok: #1f6b5c; --bad: #b3261e; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 32px 16px; display: grid; gap: 16px; }
  h1 { margin: 0; font-size: 22px; }
  .muted { color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; display: grid; gap: 10px; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  button { background: var(--ink); color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; font: inherit; cursor: pointer; }
  input { width: 80px; padding: 7px 8px; border: 1px solid var(--line); border-radius: 6px; font: inherit; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; }
  .stat b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; }
  .stat span { color: var(--muted); font-size: 12px; }
  pre { margin: 0; background: var(--bg); padding: 10px; border-radius: 6px; overflow-x: auto; }
  svg { width: 100%; height: 120px; display: block; }
  .bad { color: var(--bad); }
</style>
</head>
<body>
<main>
  <div>
    <h1>superapp</h1>
    <p class="muted">Every call goes to <code id="upstream"></code> and waits for its answer.</p>
  </div>
  <section class="card">
    <div class="row"><button id="call">Call superapp2</button><span id="result" class="muted">Not called yet.</span></div>
    <pre id="answer">{}</pre>
  </section>
  <section class="card">
    <div class="row">
      <strong>Load</strong>
      <span class="muted">superapp calls superapp2 at</span>
      <input id="rps" type="number" min="0" max="100" step="0.5" />
      <span class="muted">requests per second</span>
      <button id="setLoad">Set</button>
    </div>
  </section>
  <section class="card">
    <strong>Upstream timing, last minute</strong>
    <div class="stats">
      <div class="stat"><b id="calls">-</b><span>calls</span></div>
      <div class="stat"><b id="avg">-</b><span>average</span></div>
      <div class="stat"><b id="p50">-</b><span>p50</span></div>
      <div class="stat"><b id="p95">-</b><span>p95</span></div>
      <div class="stat"><b id="max">-</b><span>slowest</span></div>
      <div class="stat"><b id="errors">-</b><span>errors</span></div>
    </div>
    <svg id="chart" viewBox="0 0 600 120" preserveAspectRatio="none" aria-label="Latest upstream call times"></svg>
    <span class="muted" id="chartNote"></span>
  </section>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const ms = (v) => (v === null || v === undefined ? "-" : v < 1000 ? Math.round(v) + " ms" : (v / 1000).toFixed(2) + " s");
  $("call").onclick = async () => {
    $("result").textContent = "Calling…";
    const r = await (await fetch("/api/call")).json();
    $("result").innerHTML = r.status === "ok" ? "Answered in <b>" + ms(r.ms) + "</b>" : "<span class='bad'>" + r.status + " after " + ms(r.ms) + "</span>";
    $("answer").textContent = JSON.stringify(r.answer, null, 2);
    refresh();
  };
  $("setLoad").onclick = async () => {
    await fetch("/api/load?rps=" + encodeURIComponent($("rps").value || 0), { method: "POST" });
    refresh();
  };
  let editing = false;
  $("rps").onfocus = () => (editing = true);
  $("rps").onblur = () => (editing = false);
  async function refresh() {
    const s = await (await fetch("/api/stats")).json();
    $("upstream").textContent = s.upstream;
    if (!editing) $("rps").value = s.loadRps;
    $("calls").textContent = s.lastMinute.calls;
    $("avg").textContent = ms(s.lastMinute.avgMs);
    $("p50").textContent = ms(s.lastMinute.p50Ms);
    $("p95").textContent = ms(s.lastMinute.p95Ms);
    $("max").textContent = ms(s.lastMinute.maxMs);
    $("errors").textContent = s.lastMinute.errors;
    $("errors").className = s.lastMinute.errors > 0 ? "bad" : "";
    const top = Math.max(100, ...s.recent.map((c) => c.ms));
    const w = 600 / Math.max(1, s.recent.length);
    $("chart").innerHTML = s.recent.map((c, i) => {
      const h = Math.max(1, (c.ms / top) * 116);
      return '<rect x="' + i * w + '" y="' + (120 - h) + '" width="' + Math.max(1, w - 1) + '" height="' + h + '" fill="' + (c.status === "ok" ? "#1f6b5c" : "#b3261e") + '"><title>' + ms(c.ms) + " " + c.status + "</title></rect>";
    }).join("");
    $("chartNote").textContent = s.recent.length ? "The last " + s.recent.length + " calls; the tallest bar is " + ms(top) + "." : "No calls yet.";
  }
  refresh();
  setInterval(refresh, 1000);
</script>
</body>
</html>
`;
