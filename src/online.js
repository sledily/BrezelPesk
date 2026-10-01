const ROOM_KEY_PREFIX = 'dendarv.online.room.';
const RECOVERY_PREFIX = 'dendarv.online.recovery.';
const PENDING_PREFIX = 'dendarv.online.pending.';
const NAME_KEY = 'dendarv.online.name';
const SPECTATOR_KEY = 'dendarv.online.spectator';
export class OnlineError extends Error {
  constructor(code,message,status=0){super(message);this.name='OnlineError';this.code=code;this.status=status;}
}
function normalizeCode(code){return String(code??'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);}
function randomId(){return Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');}
async function api(path,{method='GET',token=null,body=null,spectatorId=null,requestId=null,etag=null}={}){
  const headers={Accept:'application/json'};
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
  const existing=localStorage.getItem(PENDING_PREFIX+key);
  const pending=existing?JSON.parse(existing):{path,options:{...options,method:'POST',requestId:randomId()}};
  if(!existing)localStorage.setItem(PENDING_PREFIX+key,JSON.stringify(pending));
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
    this.token=spectate?null:localStorage.getItem(ROOM_KEY_PREFIX+this.code);
    this.spectatorId=localStorage.getItem(SPECTATOR_KEY)??randomId();
    localStorage.setItem(SPECTATOR_KEY,this.spectatorId);this.lastView=null;this.etag=null;this.busy=false;
  }
  static rememberedName(){return localStorage.getItem(NAME_KEY)??'';}
  static rememberName(name){localStorage.setItem(NAME_KEY,String(name??'').trim());}
  accept(payload){
    if(payload.token){
      this.token=payload.token;this.spectate=false;
      localStorage.setItem(ROOM_KEY_PREFIX+this.code,payload.token);
      if(payload.recoveryCode)localStorage.setItem(RECOVERY_PREFIX+this.code,payload.recoveryCode);
    }
    this.lastView=payload.view??payload;this.etag=null;return this.lastView;
  }
  static async create({playerCount,playerName,seat}){
    const payload=await durableRequest('create','/api/rooms',{body:{playerCount,playerName,seat,credentials:{token:randomId(),recoveryCode:randomId()}}});
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
      try{this.accept(await durableRequest(this.code,null,null));}finally{this.busy=false;}
    }
    const response=await api(`/api/rooms/${this.code}`,{token:this.token,spectatorId:this.token?null:this.spectatorId,etag:this.etag});
    if(response.unchanged&&this.lastView)return this.lastView;
    this.lastView=response.payload;this.etag=response.etag;return this.lastView;
  }
  recoveryCode(){return localStorage.getItem(RECOVERY_PREFIX+this.code);}
  async recover(recoveryCode){return this.mutate('recover',{recoveryCode:String(recoveryCode).trim(),token:randomId()});}
  start(){return this.mutate('start');}
  command(command){return this.mutate('command',{command});}
  undo(){return this.mutate('undo');}
  pass(){return this.mutate('pass');}
  abandon(){return this.mutate('abandon',{confirmed:true});}
  async export(){return (await api(`/api/rooms/${this.code}/export`,{token:this.token})).payload;}
}
export function roomCodeFromLocation(){return normalizeCode(new URLSearchParams(location.search).get('room'));}
export function onlineShareUrl(code){const url=new URL(location.href);url.search='';url.hash='';url.searchParams.set('room',normalizeCode(code));return url.href;}
