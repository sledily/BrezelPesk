import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {createAdminApp,collectionHTML,inspectionHTML} from '../src/admin.js';
const code='ABC234';
const record={name:'Private <img src=x onerror=alert(1)>',code,status:'LOBBY',ended_at:null,seats:{WHITE:{name:'Alice <script>bad</script>'}},state:null};
const inspection={code,status:'LOBBY',record,revision:0,archive:null,audit:[],notifications:{jobs:[]}};
function harness({storage=new Map(),mutation=()=>({ok:true})}={}) {
  class Element {
    constructor(id){this.id=id;this.hidden=false;this.value='';this.innerHTML='';this.textContent='';this.listeners={};this.disabled=false;}
    addEventListener(type,fn){this.listeners[type]=fn;}
  }
  const elements=new Map();
  for(const match of readFileSync(new URL('../admin.html',import.meta.url),'utf8').matchAll(/id="([^"]+)"/g))elements.set(match[1],new Element(match[1]));
  elements.get('filter').value='all';elements.get('recovery-panel').hidden=true;
  const calls=[],timers=[],events={};let signedIn=true;
  const env={document:{getElementById:id=>elements.get(id),querySelectorAll:()=>[],body:{append(){}},createElement:()=>({click(){},remove(){}})},
    sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    crypto:webcrypto,AbortSignal,FormData:class {constructor(form){this.fields=form.fields;}get(key){return this.fields[key]??null;}},
    clearTimeout(){},setTimeout:fn=>{timers.push(fn);return timers.length;},addEventListener:(event,fn)=>{events[event]=fn;},
    navigator:{clipboard:{writeText:async()=>{}}},URL:{createObjectURL:()=> 'blob:synthetic',revokeObjectURL(){}},
    fetch:async(url,options)=>{
      calls.push({url,...options});const body=options.body?JSON.parse(options.body):undefined;
      const ok=data=>({ok:true,status:200,json:async()=>data});
      if(url.endsWith('/login')){signedIn=true;return ok({csrf:'session-csrf',expires:Date.now()+3600000});}
      if(!signedIn)return {ok:false,status:403,json:async()=>({error:{code:'ADMIN_REQUIRED',message:'Administrator login required'}})};
      if(url.endsWith('/session'))return ok({csrf:'session-csrf',expires:Date.now()+3600000});
      if(url.endsWith('/logout')){signedIn=false;return ok({ok:true});}
      if(url==='/api/admin')return ok({rooms:[{code,name:record.name,status:'LOBBY',bytes:10,counts_as_game:true}],limits:{maxGames:5,totalBytes:1048576}});
      if(url===`/api/admin/rooms/${code}`)return ok(inspection);
      const result=await mutation(url,body);return ok(result);
    }};
  const app=createAdminApp(env),tick=()=>new Promise(resolve=>setImmediate(resolve));
  const fire=async(id,event,target={})=>{elements.get(id).listeners[event]({preventDefault(){},target});await tick();};
  const open=()=>fire('collection','click',{closest:()=>({dataset:{inspect:code}})});
  const recover=()=>fire('inspection','submit',{dataset:{action:'recover'},fields:{seat:'WHITE',confirmCode:code}});
  return {app,elements,calls,timers,events,storage,fire,open,recover,env,tick};
}

test('admin renders hostile names as text and offers only status-appropriate interventions',()=>{
  const html=inspectionHTML(inspection);
  assert.doesNotMatch(html,/<script>|<img/);assert.match(html,/&lt;script&gt;/);assert.match(html,/Replace recovery code/);
  assert.doesNotMatch(html,/Abandon game|Delete archive permanently/);
  const ended={...inspection,status:'ABANDONED',record:{...record,status:'ABANDONED',ended_at:new Date().toISOString()},archive:{status:'pending'}};
  assert.match(inspectionHTML(ended),/Delete archive permanently/);assert.match(inspectionHTML(ended),/Retry archive job/);
  assert.match(inspectionHTML(ended),/Access remains read-only/);
  assert.doesNotMatch(inspectionHTML(ended,Date.now()+31*86400000),/Replace recovery code/);
  assert.doesNotMatch(inspectionHTML({...inspection,status:'DELETED',record:null}),/data-action=/);
  assert.match(collectionHTML([{code,name:record.name,status:'ACTIVE'}],'all'),/&lt;img/);
  assert.equal(collectionHTML([{code,status:'ACTIVE'}],'archive'),'<p>No games in this view.</p>');
});

test('admin retries an unknown recovery outcome with identical credentials across a page reload',async()=>{
  let lost=true;const storage=new Map(),requests=[];
  const mutation=(url,body)=>{requests.push(body);if(lost){lost=false;throw new Error('connection lost');}return {ok:true};};
  const first=harness({storage,mutation});await first.app.start();await first.open();await first.recover();
  assert.equal(first.elements.get('pending-panel').hidden,false);assert.equal(first.elements.get('recovery-panel').hidden,true);
  assert.equal(requests.length,1);assert.equal(requests[0].expectedRevision,0);assert.equal(requests[0].seat,'WHITE');
  assert.equal(requests[0].token.length,64);assert.notEqual(requests[0].token,requests[0].recoveryCode);
  await first.recover();assert.equal(requests.length,1,'another operation cannot overwrite the uncertain request');
  const restarted=harness({storage,mutation});await restarted.app.start();await restarted.fire('retry','click');
  assert.equal(requests.length,2);assert.deepEqual(requests[1],requests[0]);assert.equal(storage.size,0);
  assert.equal(restarted.elements.get('recovery-code').value,requests[0].recoveryCode);
  assert.equal(restarted.elements.get('recovery-panel').hidden,false);
  const sent=restarted.calls.find(call=>call.url.endsWith('/recover'));
  assert.equal(sent.headers['X-Admin-CSRF'],'session-csrf');assert.equal(sent.credentials,'same-origin');
});

test('admin does not send an action without exact confirmation or durable browser retry data',async()=>{
  const h=harness();await h.app.start();await h.open();
  await h.fire('inspection','submit',{dataset:{action:'recover'},fields:{seat:'WHITE',confirmCode:'WRONG2'}});
  assert.equal(h.calls.filter(call=>call.url.endsWith('/recover')).length,0);
  h.env.sessionStorage.setItem=()=>{throw new Error('Storage unavailable');};await h.recover();
  assert.equal(h.calls.filter(call=>call.url.endsWith('/recover')).length,0);
  assert.match(h.elements.get('message').textContent,/Storage unavailable/);
});

test('admin sign-out and session expiry clear private state and displayed credentials',async()=>{
  const h=harness();await h.app.start();await h.open();await h.recover();
  assert.ok(h.elements.get('recovery-code').value);await h.fire('logout','click');
  assert.equal(h.elements.get('recovery-code').value,'');assert.equal(h.elements.get('inspection').innerHTML,'');
  assert.equal(h.elements.get('workspace').hidden,true);assert.equal(h.elements.get('login-panel').hidden,false);
  const expired=harness();await expired.app.start();await expired.open();expired.timers[0]();
  assert.equal(expired.elements.get('inspection').innerHTML,'');assert.equal(expired.elements.get('workspace').hidden,true);
});

test('an in-flight inspection cannot restore private content after session expiry',async()=>{
  const h=harness();await h.app.start();const original=h.env.fetch;let release;
  h.env.fetch=async(...args)=>{if(args[0].endsWith('/rooms/'+code))await new Promise(resolve=>{release=resolve;});return original(...args);};
  await h.open();h.timers[0]();release();await h.tick();
  assert.equal(h.elements.get('inspection').innerHTML,'');assert.equal(h.elements.get('workspace').hidden,true);
});
