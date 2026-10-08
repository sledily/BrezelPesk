const ROOM_KEY_PREFIX = 'dendarv.online.room.';
const RECOVERY_PREFIX = 'dendarv.online.recovery.';
const PENDING_PREFIX = 'dendarv.online.pending.';
const NAME_KEY = 'dendarv.online.name';
const SPECTATOR_KEY = 'dendarv.online.spectator';
const GAME_LIST_KEY = 'dendarv.online.games';
function siteRead(key) { try { return localStorage.getItem(key); } catch { return null; } }
function siteWrite(key, value) {
  try { localStorage.setItem(key, value); }
  catch { throw new OnlineError('SITE_STORAGE_UNAVAILABLE', 'Allow this site to store browser data before joining or changing an online game. Your saved game has not been deleted.'); }
}
function rememberedGames() {
  let saved = {};
  try {
    const parsed = JSON.parse(siteRead(GAME_LIST_KEY) ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed;
  } catch { /* A damaged convenience list never invalidates a seat. */ }
  const result = Object.fromEntries(Object.entries(saved).filter(([code, item]) => /^[A-Z2-9]{6}$/.test(code) && item && typeof item === 'object'));
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(ROOM_KEY_PREFIX)) continue;
      const code = key.slice(ROOM_KEY_PREFIX.length);
      if (/^[A-Z2-9]{6}$/.test(code)) result[code] ??= { code, name: `Game ${code}`, status: 'UNKNOWN' };
    }
  } catch { /* Existing remembered entries remain usable. */ }
  return result;
}
function rememberGameSummary(summary) {
  const games = rememberedGames(), code = summary.code;
  if (!/^[A-Z2-9]{6}$/.test(code)) return;
  games[code] = { code, name: summary.name, status: summary.status,
    players: (summary.players ?? []).map(({ seat, name }) => ({ seat, name })),
    year: summary.year, phase: summary.phase, actor: summary.actor,
    seat: summary.seat ?? games[code]?.seat ?? null,
    is_your_turn: Boolean(summary.is_your_turn), needs_recovery: Boolean(summary.needs_recovery),
    checked_at: new Date().toISOString() };
  // This is a convenience index. Failing to cache a view must not turn an
  // already-accepted server action into an apparent save failure.
  try { localStorage.setItem(GAME_LIST_KEY, JSON.stringify(games)); } catch { /* no-op */ }
}
export class OnlineError extends Error {
  constructor(code,message,status=0){super(message);this.name='OnlineError';this.code=code;this.status=status;}
}
function normalizeCode(code){return String(code??'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);}
function randomId(){return Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');}
async function api(path,{method='GET',token=null,body=null,spectatorId=null,requestId=null,etag=null,visible=false}={}){
  const headers={Accept:'application/json'};
  if(visible)headers['X-Dendarv-Visible']='1';
  if(token)headers.Authorization=`Bearer ${token}`;
  if(spectatorId)headers['X-Dendarv-Spectator']=spectatorId;
  if(body!==null)headers['Content-Type']='application/json';
  if(requestId)headers['Idempotency-Key']=requestId;
  if(etag)headers['If-None-Match']=etag;
  let response;
  try{response=await fetch(path,{method,headers,body:body===null?undefined:JSON.stringify(body),cache:'no-store'});}
  catch{throw new OnlineError('SERVER_UNREACHABLE','The online server could not be reached. Your pending request will be retried safely.');}
  if(response.status===304)return {unchanged:true,etag};
  let payload;
  try{payload=await response.json();}catch{throw new OnlineError('INVALID_SERVER_RESPONSE','The online response was unreadable. Retry safely.',response.status);}
  if(!response.ok)throw new OnlineError(payload.error?.code??'ONLINE_ERROR',payload.error?.message??'The online request failed',response.status);
  return {payload,etag:response.headers.get('etag')};
}
async function durableRequest(key,path,options){
  // Retain the SAME request and identity across connection loss and page reload.
  const existing=siteRead(PENDING_PREFIX+key);
  const pending=existing?JSON.parse(existing):{path,options:{...options,method:'POST',requestId:randomId()}};
  if(!existing)siteWrite(PENDING_PREFIX+key,JSON.stringify(pending));
  try{
    const {payload}=await api(pending.path,pending.options);
    localStorage.removeItem(PENDING_PREFIX+key);return payload;
  }catch(error){
    if(error.status>=400&&error.status<500)localStorage.removeItem(PENDING_PREFIX+key);
    throw error;
  }
}
export class OnlineClient {
  constructor(code,{spectate=false}={}){
    this.code=normalizeCode(code);this.spectate=spectate;
    this.token=spectate?null:siteRead(ROOM_KEY_PREFIX+this.code);
    this.spectatorId=siteRead(SPECTATOR_KEY)??randomId();
    try { localStorage.setItem(SPECTATOR_KEY,this.spectatorId); } catch {}
    this.lastView=null;this.etag=null;this.busy=false;
  }
  static rememberedName(){return siteRead(NAME_KEY)??'';}
  static rememberName(name){try { localStorage.setItem(NAME_KEY,String(name??'').trim()); } catch {}}
  static rememberedGames() { return Object.values(rememberedGames()); }
  static async refreshRememberedGames() {
    return Promise.all(OnlineClient.rememberedGames().map(async old => {
      try {
        const { payload } = await api(`/api/rooms/${old.code}/summary`, { token: siteRead(ROOM_KEY_PREFIX + old.code) });
        rememberGameSummary(payload);
        return { ...old, ...payload, error: null };
      } catch (error) {
        return { ...old, is_your_turn: false, error: error.code === 'ROOM_ACCESS_EXPIRED'
          ? 'The 30-day viewing period has ended.' : error.code === 'ROOM_CANCELLED'
            ? 'The host cancelled this unstarted room. Its invitation is closed.' : error.code === 'ROOM_NOT_FOUND'
            ? 'This room could not be found. Check the code or ask the host.'
            : 'Could not refresh. These are the last remembered details; try opening the game.' };
      }
    }));
  }
  rememberView() {
    const view = this.lastView;
    if (this.spectate || !this.token || !view?.room) return;
    rememberGameSummary({ code: this.code, name: view.room.name ?? `Game ${this.code}`, status: view.room.status,
      players: view.room.seating_mode === 'RANDOM' && view.room.status === 'LOBBY'
        ? view.room.participants.map(p => ({seat:null, name:p.name}))
        : Object.entries(view.room.seats).filter(([, p]) => p).map(([seat, p]) => ({ seat, name: p.name })),
      ...view.room.summary, seat: view.viewer.seat, is_your_turn: view.viewer.is_your_turn,
      needs_recovery: view.viewer.role !== 'PLAYER' });
  }
  forgetSeat() {
    this.token = null;
    localStorage.removeItem(ROOM_KEY_PREFIX + this.code);
    localStorage.removeItem(RECOVERY_PREFIX + this.code);
    const games = rememberedGames();
    delete games[this.code];
    try { localStorage.setItem(GAME_LIST_KEY, JSON.stringify(games)); } catch {}
  }
  accept(payload){
    if (payload.left || payload.cancelled) { this.forgetSeat(); return payload; }
    if(payload.token){
      this.token=payload.token;this.spectate=false;
      localStorage.setItem(ROOM_KEY_PREFIX+this.code,payload.token);
      if(payload.recoveryCode)localStorage.setItem(RECOVERY_PREFIX+this.code,payload.recoveryCode);
    }
    this.lastView=payload.view??payload;this.etag=null;this.rememberView();return this.lastView;
  }
  static async create({playerCount,playerName,seat,seatingMode='FREE'}){
    const payload=await durableRequest('create','/api/rooms',{body:{playerCount,playerName,seat,seatingMode,credentials:{token:randomId(),recoveryCode:randomId()}}});
    const client=new OnlineClient(payload.code);OnlineClient.rememberName(playerName);
    return {client,payload:client.accept(payload)};
  }
  async mutate(action,body={}){
    if(this.busy)throw new OnlineError('REQUEST_PENDING','Wait for the pending request');
    this.busy=true;
    try{return this.accept(await durableRequest(this.code,`/api/rooms/${this.code}/${action}`,{token:this.token,body:{...body,expectedRevision:this.lastView?.viewer.private_revision}}));}
    finally{this.busy=false;}
  }
  async join({playerName,seat}){OnlineClient.rememberName(playerName);return this.mutate('join',{playerName,seat,credentials:{token:randomId(),recoveryCode:randomId()}});}
  async view(){
    const pending=localStorage.getItem(PENDING_PREFIX+this.code);
    if(pending&&!this.busy&&!this.spectate){
      this.busy=true;
      try{const accepted=this.accept(await durableRequest(this.code,null,null)); if(accepted.cancelled)throw new OnlineError('ROOM_CANCELLED','This unstarted room was cancelled',410);}finally{this.busy=false;}
    }
    const response=await api(`/api/rooms/${this.code}`,{token:this.token,spectatorId:this.token?null:this.spectatorId,etag:this.etag,visible:typeof document!=='undefined'&&!document.hidden&&(!document.hasFocus||document.hasFocus())});
    if(response.unchanged&&this.lastView)return this.lastView;
    this.lastView=response.payload;this.etag=response.etag;this.rememberView();return this.lastView;
  }
  recoveryCode(){return localStorage.getItem(RECOVERY_PREFIX+this.code);}
  async recover(recoveryCode){return this.mutate('recover',{recoveryCode:String(recoveryCode).trim(),token:randomId()});}
  start(){return this.mutate('start');}
  command(command){return this.mutate('command',{command});}
  undo(){return this.mutate('undo');}
  pass(){return this.mutate('pass');}
  abandon(){return this.mutate('abandon',{confirmed:true});}
  rename(name){return this.mutate('rename',{name});}
  lobby(action,body={}) { return this.mutate(action,body); }
  async export(){return (await api(`/api/rooms/${this.code}/export`,{token:this.token})).payload;}
}
export function roomCodeFromLocation(){return normalizeCode(new URLSearchParams(location.search).get('room'));}
export function onlineShareUrl(code){const url=new URL(location.href);url.search='';url.hash='';url.searchParams.set('room',normalizeCode(code));return url.href;}
