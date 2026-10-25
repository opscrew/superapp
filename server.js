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
    // Allocate and retain `mb` megabytes in large touched chunks so the container blows through its
    // memory limit fast enough for the kernel to OOM-kill it rather than thrash at the ceiling.
    const mb = Number(url.searchParams.get("mb") ?? 1024);
    const chunkMb = 64;
    for (let allocated = 0; allocated < mb; allocated += chunkMb) hoard.push(Buffer.alloc(chunkMb * 1024 * 1024, 1));
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end(`hoarding ${hoard.length} MB\n`);
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ app: "superapp", version: process.env.APP_VERSION ?? "dev", rssMb: Math.round(process.memoryUsage().rss / 1048576) }) + "\n");
});

server.listen(port, () => console.log(`superapp listening on ${port}`));
