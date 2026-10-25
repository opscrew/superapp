// superapp: a tiny HTTP service whose memory use can be driven up on demand.
import http from "node:http";

const port = Number(process.env.PORT ?? 8080);
const hoard = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok\n");
  }
  if (url.pathname === "/hog") {
    // Allocate and retain `mb` megabytes so the container exceeds its memory limit.
    const mb = Number(url.searchParams.get("mb") ?? 256);
    for (let i = 0; i < mb; i++) hoard.push(Buffer.alloc(1024 * 1024, i % 251));
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end(`hoarding ${hoard.length} MB\n`);
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ app: "superapp", version: process.env.APP_VERSION ?? "dev", rssMb: Math.round(process.memoryUsage().rss / 1048576) }) + "\n");
});

server.listen(port, () => console.log(`superapp listening on ${port}`));
