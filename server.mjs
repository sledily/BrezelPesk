import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, normalize, resolve, sep } from "node:path";
import { RoomError, RoomStore } from "./src/rooms.js";

const root = resolve(import.meta.dirname);
const port = Number(process.env.PORT ?? process.env.DENDARV_PORT ?? 4173);
const host = process.env.DENDARV_HOST ?? (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const roomStore = new RoomStore({
  filePath: process.env.DENDARV_DATA_PATH ?? resolve(root, ".dendarv-data", "rooms.json"),
});
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function bearerToken(request) {
  const authorization = request.headers.authorization ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : null;
}

function readJson(request) {
  return new Promise((accept, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) reject(new RoomError("REQUEST_TOO_LARGE", "Request body is too large", 413));
    });
    request.on("end", () => {
      if (!body) return accept({});
      try {
        accept(JSON.parse(body));
      } catch {
        reject(new RoomError("INVALID_JSON", "Request body must be valid JSON", 400));
      }
    });
    request.on("error", reject);
  });
}

async function handleApi(request, response, url) {
  const segments = url.pathname.split("/").filter(Boolean);
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, service: "brezelpesk" });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/rooms") {
    const result = roomStore.create(await readJson(request));
    sendJson(response, 201, result);
    return true;
  }
  if (segments[0] !== "api" || segments[1] !== "rooms" || !segments[2]) return false;
  const code = segments[2];
  const action = segments[3] ?? null;
  const token = bearerToken(request);
  if (request.method === "GET" && !action) {
    const result = roomStore.view(code, token, request.headers["x-dendarv-spectator"] ?? null);
    sendJson(response, 200, result);
    return true;
  }
  if (request.method !== "POST") return false;
  let result;
  if (action === "join") result = roomStore.join(code, await readJson(request));
  else if (action === "start") result = roomStore.start(code, token);
  else if (action === "command") result = roomStore.command(code, token, (await readJson(request)).command);
  else if (action === "undo") result = roomStore.undo(code, token);
  else if (action === "pass") result = roomStore.pass(code, token);
  else return false;
  sendJson(response, 200, result);
  return true;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/") && await handleApi(request, response, url)) return;
  } catch (error) {
    if (error instanceof RoomError) {
      sendJson(response, error.status, { error: { code: error.code, message: error.message } });
      return;
    }
    process.stderr.write(`${error.stack ?? error}\n`);
    sendJson(response, 500, { error: { code: "SERVER_ERROR", message: "The Dendarv server could not complete this request" } });
    return;
  }
  const requestPath = decodeURIComponent(url.pathname);
  const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const filePath = normalize(resolve(root, relative));
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "Content-Type": types[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
});

server.listen(port, host, () => {
  const address = server.address();
  process.stdout.write(`BrezelPesk is running at http://${host}:${address.port}\n`);
});
