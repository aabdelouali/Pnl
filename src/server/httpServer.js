import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function parseFilters(searchParams) {
  return {
    assetClass: searchParams.get("assetClass") || "ALL",
    desk: searchParams.get("desk") || "ALL",
    trader: searchParams.get("trader") || "ALL",
    timeframe: searchParams.get("timeframe") || "15m"
  };
}

async function serveStatic(response, publicDir, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const resolvedPath = path.normalize(path.join(publicDir, requestedPath));
  const normalizedRoot = publicDir.endsWith(path.sep) ? publicDir : `${publicDir}${path.sep}`;

  if (resolvedPath !== publicDir && !resolvedPath.startsWith(normalizedRoot)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(resolvedPath);
    const ext = path.extname(resolvedPath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(file);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

export function createHttpServer({ engine, publicDir }) {
  return createServer(async (request, response) => {
    const host = request.headers.host || "localhost";
    const requestUrl = new URL(request.url || "/", `http://${host}`);

    if (requestUrl.pathname === "/api/health") {
      sendJson(response, 200, {
        status: "ok",
        timestamp: Date.now(),
        system: engine.getSystemStats()
      });
      return;
    }

    if (requestUrl.pathname === "/api/meta") {
      sendJson(response, 200, engine.getMeta());
      return;
    }

    if (requestUrl.pathname === "/api/snapshot") {
      const filters = parseFilters(requestUrl.searchParams);
      sendJson(response, 200, engine.getSnapshot(filters));
      return;
    }

    await serveStatic(response, publicDir, decodeURIComponent(requestUrl.pathname));
  });
}
