import type { Server } from "http";
import app from "../../src/app.js";

let server: Server | null = null;
let port = 0;

/** Start the test server on a random port */
export async function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      const addr = server!.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(`http://localhost:${port}`);
    });
  });
}

/** Stop the test server */
export async function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
}

/** Make an API request to the test server */
export async function apiRequest(
  path: string,
  options: { method?: string; body?: object; headers?: Record<string, string> } = {},
) {
  const url = `http://localhost:${port}/api/v1${path}`;
  const res = await fetch(url, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json", ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data };
}
