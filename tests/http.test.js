import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function waitForLine(stream, pattern, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let text = "";
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}`)), timeoutMs);
    stream.on("data", (chunk) => {
      text += chunk;
      const match = text.match(pattern);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match);
    });
  });
}

test("the HTTP server exposes room creation, joining, spectator views, and static assets", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "dendarv-http-"));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: "0",
      DENDARV_PORT: "0",
      DENDARV_HOST: "127.0.0.1",
      DENDARV_DATA_PATH: join(directory, "rooms.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill("SIGTERM"));
  const match = await waitForLine(child.stdout, /127\.0\.0\.1:(\d+)/);
  const origin = `http://127.0.0.1:${match[1]}`;

  const health = await fetch(`${origin}/api/health`).then((response) => response.json());
  assert.equal(health.ok, true);

  const createdResponse = await fetch(`${origin}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerCount: 2, playerName: "Host", seat: "WHITE", seed: "http-smoke" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.match(created.code, /^[A-Z2-9]{6}$/);
  assert.ok(created.token);

  const spectatorResponse = await fetch(`${origin}/api/rooms/${created.code}`, {
    headers: { "X-Dendarv-Spectator": "test-spectator" },
  });
  const spectator = await spectatorResponse.json();
  assert.equal(spectator.viewer.role, "SPECTATOR");
  assert.equal(spectator.room.spectator_count, 1);

  const html = await fetch(origin).then((response) => response.text());
  assert.match(html, /Play or watch online/);
});
