import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
      DENDARV_DATA_DIR: directory,
      DATABASE_URL: "",
      NODE_ENV: "test",
      RENDER: "",
      DENDARV_ADMIN_PASSWORD: "synthetic-test-password-32-characters",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill("SIGTERM"));
  context.after(() => rmSync(directory,{recursive:true,force:true}));
  const match = await waitForLine(child.stdout, /127\.0\.0\.1:(\d+)/);
  const origin = `http://127.0.0.1:${match[1]}`;

  const health = await fetch(`${origin}/api/health`).then((response) => response.json());
  assert.equal(health.ok, true);

  const createdResponse = await fetch(`${origin}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "a".repeat(32) },
    body: JSON.stringify({ playerCount: 2, playerName: "Host", seat: "WHITE", credentials: { token: "b".repeat(48), recoveryCode: "c".repeat(48) } }),
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

  for (const path of ['/server.mjs','/src/rooms.js','/src/persistent-rooms.js','/src/room-storage.js','/package.json','/.env','/.git/config','/.dendarv-data/rooms.json','/src%2Frooms.js','/tests/rooms.test.js']) {
    assert.equal((await fetch(origin+path)).status,404,path);
  }
  assert.equal((await fetch(origin+'/%ZZ')).status,400);
  assert.equal((await fetch(origin+'/api/admin')).status,403);
  assert.equal((await fetch(origin+`/api/rooms/${created.code}/export`)).status,403);
  const repeat = await fetch(`${origin}/api/rooms`, {
    method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'a'.repeat(32)},
    body:JSON.stringify({playerCount:2,playerName:'Host',seat:'WHITE',credentials:{token:'b'.repeat(48),recoveryCode:'c'.repeat(48)}}),
  }).then(r=>r.json());
  assert.equal(repeat.code,created.code);
  const rejectedLogin=await fetch(origin+'/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'wrong'})});
  assert.equal(rejectedLogin.status,403);
  const login=await fetch(origin+'/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'synthetic-test-password-32-characters'})});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
  assert.match(login.headers.get('set-cookie'),/HttpOnly/);
  assert.equal((await fetch(origin+'/api/admin',{headers:{Cookie:cookie}})).status,200);
  const adminBody={confirmed:true,requestId:'d'.repeat(32),seat:'WHITE',token:'e'.repeat(48),recoveryCode:'f'.repeat(48)};
  const recoverPath=origin+`/api/admin/rooms/${created.code}/recover`;
  assert.equal((await fetch(recoverPath,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(adminBody)})).status,403);
  assert.equal((await fetch(recoverPath,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-Admin-CSRF':csrf},body:JSON.stringify(adminBody)})).status,200);
  const revoked=await fetch(origin+`/api/rooms/${created.code}`,{headers:{Authorization:`Bearer ${created.token}`}}).then(r=>r.json());
  assert.equal(revoked.viewer.role,'SPECTATOR');
  const html = await fetch(origin).then((response) => response.text());
  assert.match(html, /Play or watch online/);
});
