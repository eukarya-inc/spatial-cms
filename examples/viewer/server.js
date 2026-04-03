import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load .env if exists
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  }
}

const PORT = parseInt(process.env.PORT || "8090");
const CMS_URL = process.env.CMS_URL || "http://localhost:3001/api/v1";
const CMS_API_KEY = process.env.CMS_API_KEY || "";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Proxy /api/* → CMS Delivery API
  if (url.pathname.startsWith("/api/")) {
    const targetPath = url.pathname.replace(/^\/api/, "/delivery");
    const targetUrl = `${CMS_URL}${targetPath}${url.search}`;

    try {
      const headers = { "Content-Type": "application/json" };
      if (CMS_API_KEY) headers["X-API-Key"] = CMS_API_KEY;

      const cmsRes = await fetch(targetUrl, { headers });
      const body = await cmsRes.text();

      res.writeHead(cmsRes.status, {
        "Content-Type": cmsRes.headers.get("content-type") || "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(body);
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Proxy error: ${err.message}`, target: targetUrl }));
    }
    return;
  }

  // Serve static files
  let filePath = path.join(__dirname, url.pathname === "/" ? "index.html" : url.pathname);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Viewer running on http://localhost:${PORT}`);
  console.log(`CMS API: ${CMS_URL}`);
  console.log(`API Key: ${CMS_API_KEY ? CMS_API_KEY.substring(0, 13) + "..." : "(not set)"}`);
});
