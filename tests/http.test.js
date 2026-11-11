import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { COURT_ART } from '../src/court-art.js';

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
      DENDARV_MAINTENANCE_TOKEN: "synthetic-maintenance-secret-for-tests-only",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill("SIGTERM"));
  context.after(() => rmSync(directory,{recursive:true,force:true}));
  const match = await waitForLine(child.stdout, /127\.0\.0\.1:(\d+)/);
  const origin = `http://127.0.0.1:${match[1]}`;

  const health = await fetch(`${origin}/api/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  for (const path of Object.values(COURT_ART)) {
    const asset = await fetch(`${origin}/${path}`, {method:'HEAD'});
    assert.equal(asset.status,200,path);
    assert.equal(asset.headers.get('content-type'),'image/jpeg');
  }
  const art = Buffer.from(await fetch(`${origin}/${COURT_ART['KING:CLOVERS']}`).then(r=>r.arrayBuffer()));
  assert.equal(art.readUInt16BE(0), 0xffd8, 'original JPEG signature');
  assert.equal(art.readUInt16BE(art.length - 2), 0xffd9, 'complete JPEG asset');
  assert.equal((await fetch(origin+'/assets/court/unlisted.jpg')).status,404);
  const pushConfig=await fetch(origin+'/api/notifications/config').then(r=>r.json());
  assert.equal(pushConfig.enabled,false);assert.equal(pushConfig.publicKey,null);
  assert.equal((await fetch(origin+'/notification-worker.js')).status,200);
  assert.equal((await fetch(origin+'/src/notifications.js')).status,404);
  assert.equal((await fetch(origin+'/src/web-push.js')).status,404);
  assert.equal((await fetch(origin+'/api/maintenance',{method:'POST'})).status,403);
  assert.equal((await fetch(origin+'/api/maintenance',{method:'POST',headers:{Authorization:'Bearer wrong'}})).status,403);
  assert.equal((await fetch(origin+'/api/maintenance',{method:'POST',headers:{Authorization:'Bearer synthetic-maintenance-secret-for-tests-only'}})).status,200);
  assert.equal((await fetch(origin+'/src/tabletop.js')).status,200);

  const createdResponse = await fetch(`${origin}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "a".repeat(32) },
    body: JSON.stringify({ playerCount: 2, playerName: "Host", seat: "WHITE", credentials: { token: "b".repeat(48), recoveryCode: "c".repeat(48) } }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.match(created.code, /^[A-Z2-9]{6}$/);
  assert.ok(created.token);

  assert.match(created.view.room.name, /^[A-Za-z]+ [A-Za-z]+$/);
  const renameResponse=await fetch(`${origin}/api/rooms/${created.code}/rename`,{
    method:'POST',headers:{Authorization:`Bearer ${created.token}`,'Content-Type':'application/json','Idempotency-Key':'r'.repeat(32)},
    body:JSON.stringify({name:'The Breton Table',expectedRevision:created.view.viewer.private_revision}),
  });
  assert.equal(renameResponse.status,200);
  const summary=await fetch(`${origin}/api/rooms/${created.code}/summary`,{headers:{Authorization:`Bearer ${created.token}`}}).then(r=>r.json());
  assert.equal(summary.name,'The Breton Table');
  assert.equal(summary.seat,'WHITE');
  assert.equal(summary.game,undefined);
  assert.equal(summary.needs_recovery,false);

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
  for (const path of ['/private-backup.dump','/scripts/storage-scenarios.mjs','/test-support/postgres-backup.js','/STORAGE_AND_RECOVERY.md']) {
    assert.equal((await fetch(origin+path)).status,404,path);
  }
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
  let sequence=100;
  const action=async(kind,token,body={})=>{
    const current=await fetch(origin+`/api/rooms/${created.code}`,{headers:{Authorization:`Bearer ${token}`}}).then(r=>r.json());
    const reply=await fetch(origin+`/api/rooms/${created.code}/${kind}`,{method:'POST',
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,'Idempotency-Key':String(sequence++).padStart(32,'0')},
      body:JSON.stringify({...body,expectedRevision:current.viewer.private_revision})});
    const payload=await reply.json();assert.equal(reply.status,200,JSON.stringify(payload));return payload;
  };
  const black=await action('join','g'.repeat(48),{playerName:'Black',seat:'BLACK',credentials:{token:'h'.repeat(48),recoveryCode:'i'.repeat(48)}});
  await action('start',adminBody.token);
  await action('command',black.token,{command:{type:'CHOOSE_SOVEREIGN',noble_id:'NC-K-S'}});
  let playing=await action('command',adminBody.token,{command:{type:'CHOOSE_SOVEREIGN',noble_id:'NC-K-H'}});
  if(playing.game.harvest?.failsafe_pending) playing=await action('command',adminBody.token,{command:{type:'RESOLVE_HARVEST_FAILSAFE',use_failsafe:false}});
  // A compulsory response can remain private until its normal publication boundary.
  if(!playing.viewer.can_resign) await action('pass',adminBody.token);
  const ended=await action('resign',black.token,{confirmed:true});
  assert.equal(ended.room.status,'COMPLETE');assert.equal(ended.terminal_record.state.winner,'WHITE');
  const publicEnd=await fetch(origin+`/api/rooms/${created.code}`).then(r=>r.json());
  assert.equal(publicEnd.terminal_record,null);
  assert.equal((await fetch(origin+`/api/rooms/${created.code}/export`)).status,403);
  const lobbyResponse=await fetch(origin+'/api/rooms',{
    method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'l'.repeat(32)},
    body:JSON.stringify({playerCount:2,playerName:'Random host',seatingMode:'RANDOM',credentials:{token:'1'.repeat(48),recoveryCode:'2'.repeat(48)}}),
  });
  assert.equal(lobbyResponse.status,201);
  const lobby=await lobbyResponse.json();
  assert.equal(lobby.view.viewer.seat,null);
  assert.deepEqual(lobby.view.room.seats,{});
  const cancellation=await fetch(origin+`/api/rooms/${lobby.code}/cancel`,{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${lobby.token}`,'Idempotency-Key':'m'.repeat(32)},
    body:JSON.stringify({confirmed:true,expectedRevision:lobby.view.viewer.private_revision}),
  });
  assert.equal(cancellation.status,200);
  assert.equal((await cancellation.json()).cancelled,true);
  assert.equal((await fetch(origin+`/api/rooms/${lobby.code}`)).status,410);
  const adminHTML=await fetch(origin+'/admin');
  assert.equal(adminHTML.status,200);assert.match(await adminHTML.text(),/Administrator sign in/);
  assert.match(adminHTML.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal((await fetch(origin+'/src/admin.js')).status,200);
  assert.equal((await fetch(origin+'/src/admin-auth.js')).status,404);
  assert.equal((await fetch(origin+'/src/archive-zip.js')).status,404);
  assert.equal((await fetch(origin+'/api/admin/archives.zip')).status,403);
  assert.equal((await fetch(origin+'/api/admin/session',{headers:{Authorization:`Bearer ${black.token}`}})).status,403);
  const session=await fetch(origin+'/api/admin/session',{headers:{Cookie:cookie}}).then(r=>r.json());
  assert.equal(session.csrf,csrf);assert.ok(session.expires>Date.now());
  const adminHeaders={Cookie:cookie,'Content-Type':'application/json','X-Admin-CSRF':csrf};
  const inspected=await fetch(origin+`/api/admin/rooms/${created.code}`,{headers:adminHeaders}).then(r=>r.json());
  assert.equal(inspected.status,'COMPLETE');assert.equal(inspected.record.state.winner,'WHITE');
  assert.doesNotMatch(JSON.stringify(inspected),/token_hash|recovery_hash/);
  assert.equal((await fetch(origin+`/api/admin/rooms/${created.code}/abandon`,{headers:adminHeaders})).status,404,'GET must never perform an action');
  assert.equal((await fetch(origin+`/api/admin/rooms/${created.code}/recover`,{method:'PUT',headers:adminHeaders})).status,404);
  const download=await fetch(origin+'/api/admin/archives.zip',{headers:adminHeaders});
  assert.equal(download.status,200);assert.equal(download.headers.get('content-type'),'application/zip');
  assert.equal(download.headers.get('cache-control'),'no-store');assert.match(download.headers.get('content-disposition'),/attachment/);
  assert.equal(Buffer.from(await download.arrayBuffer()).readUInt32LE(0),0x04034b50);
  assert.equal((await fetch(origin+`/api/admin/rooms/${created.code}`,{headers:adminHeaders})).status,200);
  const deletePath=origin+`/api/admin/rooms/${created.code}/delete-archive`,deleteBody={confirmed:true,confirmCode:created.code,requestId:'z'.repeat(32)};
  assert.equal((await fetch(deletePath,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(deleteBody)})).status,403);
  assert.equal((await fetch(deletePath,{method:'POST',headers:{...adminHeaders,Origin:'https://elsewhere.invalid'},body:JSON.stringify(deleteBody)})).status,403);
  assert.equal((await fetch(deletePath,{method:'POST',headers:adminHeaders,body:JSON.stringify({...deleteBody,confirmCode:'WRONG2'})})).status,409);
  assert.equal((await fetch(deletePath,{method:'POST',headers:adminHeaders,body:JSON.stringify(deleteBody)})).status,200);
  assert.equal((await fetch(deletePath,{method:'POST',headers:adminHeaders,body:JSON.stringify(deleteBody)})).status,200);
  assert.equal((await fetch(origin+`/api/rooms/${created.code}`,{headers:{Authorization:`Bearer ${black.token}`}})).status,410);
  const tombstone=await fetch(origin+`/api/admin/rooms/${created.code}`,{headers:adminHeaders}).then(r=>r.json());
  assert.equal(tombstone.record,null);assert.equal(tombstone.audit.at(-1).action,'DELETE-ARCHIVE');
  const logout=await fetch(origin+'/api/admin/logout',{method:'POST',headers:adminHeaders,body:'{}'});
  assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await fetch(origin+'/api/admin',{headers:adminHeaders})).status,403);
  const html = await fetch(origin).then((response) => response.text());
  assert.match(html, /Play or watch online/);
});
