import { formatGameRecord } from './notation.js';

export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pretty = value => JSON.stringify(value,null,2);
const label = status => ({LOBBY:'Lobby',ACTIVE:'Active',COMPLETE:'Complete',ABANDONED:'Unfinished / Abandoned',CANCELLED:'Cancelled',DELETED:'Deleted'})[status] ?? status;
const details = (title,value) => `<details><summary>${escapeHTML(title)}</summary><pre>${escapeHTML(value)}</pre></details>`;
const confirmation = (action,code,text,button) => `<form data-action="${action}"><p>${text}</p><label for="confirm-${action}">Type ${escapeHTML(code)} to confirm</label><input id="confirm-${action}" name="confirmCode" required autocomplete="off" spellcheck="false" pattern="${escapeHTML(code)}"><button class="danger" type="submit">${button}</button></form>`;
export function collectionHTML(rows,filter) {
  const shown=rows.filter(row=>filter==='all' || (filter==='live'?['LOBBY','ACTIVE']:filter==='archive'?['COMPLETE','ABANDONED']:['CANCELLED','DELETED']).includes(row.status));
  if(!shown.length)return '<p>No games in this view.</p>';
  return `<div class="table-wrap"><table><thead><tr><th scope="col">Game</th><th scope="col">Status</th><th scope="col">Archive</th><th scope="col">Inspect</th></tr></thead><tbody>${shown.map(row=>`<tr><td>${escapeHTML(row.name)}<small>${escapeHTML(row.code)}</small></td><td>${escapeHTML(label(row.status))}<small>${escapeHTML(row.deleted_at ?? row.ended_at ?? '')}</small></td><td>${escapeHTML(row.archive_status ?? '—')}${row.archive_attempts?`<small>${Number(row.archive_attempts)} formatting attempts</small>`:''}${row.archive_failure?'<small>Storage retry needs attention</small>':''}</td><td><button data-inspect="${escapeHTML(row.code)}" aria-label="Inspect ${escapeHTML(row.name)}">Open</button></td></tr>`).join('')}</tbody></table></div>`;
}
export function inspectionHTML(data,now=Date.now()) {
  const {record,code,status}=data;
  let html=`<p class="eyebrow">Private inspection · ${escapeHTML(code)}</p><h2>${escapeHTML(record?.name ?? code)}</h2><p>${escapeHTML(label(status))}</p>`;
  if(record) {
    html+='<p class="muted">This read-only inspection includes hidden Courts, private draws and unfinished decisions. Refresh to see the latest saved state.</p>';
    if(record.state) {
      try {html+=details('Complete Chronicle',formatGameRecord(record));}
      catch {html+='<p>The Chronicle could not be formatted. The machine-facing record below remains available for inspection.</p>';}
    }
    html+=details('Authoritative state and complete machine-facing record',pretty(record));
    html+=details('Archive processing',pretty({status:data.archive?.status??'none',attempts:data.archive?.attempts??0,next_attempt:data.archive?.next_attempt??null,completed_at:data.archive?.completed_at??null,storage_failure_at:data.archive_failure}));
    html+=details('Notification delivery status',pretty(data.notifications));
    if(['LOBBY','ACTIVE','COMPLETE','ABANDONED'].includes(status) && (!record.ended_at || now<Date.parse(record.ended_at)+30*86400000)) {
      const seats=Object.entries(record.seats).filter(([,value])=>value.name!==undefined);
      if(seats.length)html+=`<div class="intervention"><h3>Replace a lost recovery code</h3><form data-action="recover"><p>Use only when the player has lost both browser access and their code. This invalidates their former code and controlling session, and preserves the exact saved game.${record.ended_at?' Access remains read-only until the original 30-day window ends.':''}</p><label for="seat">Player</label><select id="seat" name="seat">${seats.map(([seat,value])=>`<option value="${escapeHTML(seat)}">${escapeHTML(value.name)} · ${escapeHTML(seat)}</option>`).join('')}</select><label for="confirm-recover">Type ${escapeHTML(code)} to confirm</label><input id="confirm-recover" name="confirmCode" required autocomplete="off" pattern="${escapeHTML(code)}"><button type="submit">Replace recovery code</button></form></div>`;
    }
    if(status==='ACTIVE')html+=`<div class="intervention"><h3>Abandon this game</h3>${confirmation('abandon',code,'Permanently end this unfinished game with no winner. Its complete saved state, including unfinished decisions, will be archived. It cannot be reopened.','Abandon game')}</div>`;
    if(data.archive?.status==='pending')html+=`<div class="intervention"><h3>Retry archive processing</h3><form data-action="retry-archive"><p>Retry the saved archive job. Game state and history stay unchanged.</p><button type="submit">Retry archive job</button></form></div>`;
    if(['COMPLETE','ABANDONED'].includes(status))html+=`<div class="intervention"><h3>Delete this archive</h3>${confirmation('delete-archive',code,'Permanently delete this game’s stored history, archive and participant access. Download any copy you need first. A small administrator audit entry remains; previously downloaded copies and backups are not erased.','Delete archive permanently')}</div>`;
  } else html+='<p>The game record was deleted. Only the administrator audit and deletion receipt remain.</p>';
  return html+details('Administrator operational audit',pretty(data.audit));
}

export function createAdminApp(env=globalThis) {
  const doc=env.document,$=id=>doc.getElementById(id),pendingKey='dendarv.admin.pending.v1';
  let csrf=null,rows=[],selected=null,revision=null,busy=false,epoch=0,expiryTimer=null,pending=null;
  const message=text=>{$('message').textContent=text;};
  const readPending=()=>{try {return JSON.parse(env.sessionStorage.getItem(pendingKey)??'null');}catch{return null;}};
  const clearPending=()=>{pending=null;env.sessionStorage.removeItem(pendingKey);$('pending-panel').hidden=true;};
  const showPending=()=>{
    pending=readPending();$('pending-panel').hidden=!pending;
    $('pending-description').textContent=pending?`${pending.action} · ${pending.code}`:'';
  };
  const clearRecovery=()=>{$('recovery-panel').hidden=true;$('recovery-code').value='';$('recovery-description').textContent='';};
  function lock(text='Sign in to continue.') {
    epoch++;csrf=null;selected=null;revision=null;rows=[];env.clearTimeout(expiryTimer);
    $('workspace').hidden=true;$('login-panel').hidden=false;$('logout').hidden=true;
    $('inspection').innerHTML='';$('inspection').hidden=true;$('collection').innerHTML='';$('capacity').textContent='';clearRecovery();message(text);
  }
  function authenticated(session) {
    csrf=session.csrf;$('workspace').hidden=false;$('login-panel').hidden=true;$('logout').hidden=false;
    env.clearTimeout(expiryTimer);expiryTimer=env.setTimeout(()=>lock('Administrator session expired. Sign in again.'),Math.max(0,session.expires-Date.now()));
    showPending();
  }
  async function api(path,{body,binary=false}={}) {
    const current=epoch;
    const response=await env.fetch('/api/admin'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',
      headers:body===undefined?{}:{'Content-Type':'application/json','X-Admin-CSRF':csrf??''},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:env.AbortSignal.timeout(20000)});
    const result=binary && response.ok?await response.blob():await response.json();
    if(current!==epoch)throw new Error('The administrator session changed. Sign in again.');
    if(!response.ok) {
      if(result.error?.code==='ADMIN_REQUIRED')lock('Administrator session expired. Sign in again.');
      const error=new Error(result.error?.message??'Request failed');error.code=result.error?.code;error.status=response.status;throw error;
    }
    return result;
  }
  const renderCollection=()=>{$('collection').innerHTML=collectionHTML(rows,$('filter').value);};
  async function inspect(code) {
    const result=await api('/rooms/'+code);selected=code;revision=result.revision;$('inspection').innerHTML=inspectionHTML(result);$('inspection').hidden=false;
  }
  async function refresh() {
    const data=await api('');rows=data.rooms;renderCollection();
    const count=rows.filter(row=>row.counts_as_game).length,bytes=rows.reduce((n,row)=>n+Number(row.bytes),0);
    $('capacity').textContent=`${count} / ${data.limits.maxGames} game slots · ${(bytes/1048576).toFixed(1)} / ${(data.limits.totalBytes/1048576).toFixed(1)} MiB allocated (includes active-game reserves)`;
    if(selected)await inspect(selected);
  }
  async function run(fn) {
    if(busy)return;busy=true;
    doc.querySelectorAll('button').forEach(button=>{button.disabled=true;});
    try {await fn();}catch(error){message(error.name==='TimeoutError'?'The request timed out. Retry any pending action to confirm its outcome.':error.message);}
    finally {busy=false;doc.querySelectorAll('button').forEach(button=>{button.disabled=false;});}
  }
  const random=()=>Array.from(env.crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
  async function sendPending() {
    if(!pending)return;
    const request=pending;
    try {await api(`/rooms/${request.code}/${request.action}`,{body:request.body});}
    catch(error) {
      // Keep the exact credentials/receipt for unknown outcomes and expired login.
      if(error.status>=400 && error.status<500 && !['ADMIN_REQUIRED','CSRF_REQUIRED','RATE_LIMIT'].includes(error.code))clearPending();
      throw error;
    }
    clearPending();
    if(request.action==='recover') {
      $('recovery-code').value=request.body.recoveryCode;
      $('recovery-description').textContent=`${request.code} · ${request.body.seat}`;$('recovery-panel').hidden=false;
    }
    message('Action saved.');await refresh();
  }
  $('login').addEventListener('submit',event=>{event.preventDefault();run(async()=>{
    const password=$('password').value;$('password').value='';
    const session=await api('/login',{body:{password}});authenticated(session);message('Signed in.');await refresh();
  });});
  $('logout').addEventListener('click',()=>run(async()=>{
    await api('/logout',{body:{}});clearPending();lock('Signed out.');
  }));
  $('refresh').addEventListener('click',()=>run(refresh));
  $('filter').addEventListener('change',renderCollection);
  $('collection').addEventListener('click',event=>{
    const button=event.target.closest('[data-inspect]');if(button)run(()=>inspect(button.dataset.inspect));
  });
  $('inspection').addEventListener('submit',event=>{
    event.preventDefault();if(busy)return;
    const form=event.target,action=form.dataset.action;if(!action)return;
    run(async()=>{
      if(pending)throw new Error('Retry the pending action before starting another.');
      const code=selected,fields=new env.FormData(form);
      if(action!=='retry-archive' && fields.get('confirmCode')!==code)throw new Error('Type the room code exactly to confirm.');
      const body={confirmed:true,requestId:random(),expectedRevision:revision,confirmCode:fields.get('confirmCode')};
      if(action==='recover')Object.assign(body,{seat:fields.get('seat'),token:random(),recoveryCode:random()});
      const request={code,action,body};
      // Save before sending. If this fails, no server action is attempted.
      env.sessionStorage.setItem(pendingKey,JSON.stringify(request));showPending();clearRecovery();await sendPending();
    });
  });
  $('retry').addEventListener('click',()=>run(sendPending));
  $('copy-code').addEventListener('click',()=>run(async()=>{await env.navigator.clipboard.writeText($('recovery-code').value);message('Recovery code copied. Share it privately with that player.');}));
  $('download').addEventListener('click',()=>run(async()=>{
    const blob=await api('/archives.zip',{binary:true}),url=env.URL.createObjectURL(blob),link=doc.createElement('a');
    link.href=url;link.download='BrezelPesk-archives.zip';doc.body.append(link);link.click();link.remove();
    env.setTimeout(()=>env.URL.revokeObjectURL(url),1000);message('Archive download prepared. All server records remain stored.');
  }));
  env.addEventListener('pagehide',()=>lock('Sign in to continue.'));
  env.addEventListener('pageshow',event=>{if(event.persisted)run(resume);});
  async function resume() {
    try {authenticated(await api('/session'));message('');await refresh();}
    catch(error){lock(error.code==='ADMIN_REQUIRED'?'':error.message);}
  }
  return {start:()=>run(resume)};
}
if(typeof document!=='undefined')createAdminApp().start();
