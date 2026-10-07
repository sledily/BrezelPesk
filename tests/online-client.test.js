import test from 'node:test';
import assert from 'node:assert/strict';
import { OnlineClient } from '../src/online.js';

function browser(t) {
  const prior = {storage:globalThis.localStorage, fetch:globalThis.fetch};
  const data = new Map();
  globalThis.localStorage = {getItem:k=>data.get(k)??null, setItem:(k,v)=>data.set(k,String(v)), removeItem:k=>data.delete(k), key:i=>[...data.keys()][i]??null, get length(){return data.size;}};
  t.after(()=>{globalThis.localStorage=prior.storage;globalThis.fetch=prior.fetch;});
  return data;
}
function view(code='ABC234', extras={}) {
  return {room:{code,name:'Amber Harbour',status:'ACTIVE',seats:{WHITE:{name:'Sammy'},BLACK:{name:'Franny'}},summary:{year:3,phase:'BUILD',actor:'WHITE'}},
    viewer:{role:'PLAYER',seat:'WHITE',is_your_turn:true,private_revision:2}, game:{private:'not for the index'},...extras};
}
const response = payload => new Response(JSON.stringify(payload), {status:200,headers:{'Content-Type':'application/json'}});

test('the remembered list stores only summary fields, retains several games and excludes spectators', t=>{
  const data=browser(t);
  const a=new OnlineClient('ABC234');
  a.accept({token:'a'.repeat(64),recoveryCode:'b'.repeat(64),view:view()});
  const b=new OnlineClient('DEF567');
  b.accept({token:'c'.repeat(64),recoveryCode:'d'.repeat(64),view:view('DEF567')});
  const spectator=new OnlineClient('GHJ789',{spectate:true});
  spectator.accept(view('GHJ789'));
  assert.equal(OnlineClient.rememberedGames().length,2);
  const index=data.get('dendarv.online.games');
  assert.doesNotMatch(index,/not for the index|recoveryCode|private_revision|token/);
  assert.doesNotMatch(index,/a{64}|b{64}|c{64}|d{64}/);
  assert.match(index,/Amber Harbour/);
});

test('refresh uses summary GETs and never retries a queued gameplay command', async t=>{
  const data=browser(t), token='a'.repeat(64);
  data.set('dendarv.online.room.ABC234',token);
  data.set('dendarv.online.pending.ABC234',JSON.stringify({path:'/api/rooms/ABC234/command',options:{method:'POST'}}));
  const calls=[];
  globalThis.fetch=async(path,options)=>{calls.push({path,options}); return response({code:'ABC234',name:'Quiet Tower',status:'ACTIVE',year:4,phase:'SIEGE',players:[],seat:'WHITE',is_your_turn:true,needs_recovery:false});};
  const games=await OnlineClient.refreshRememberedGames();
  assert.equal(games[0].name,'Quiet Tower');
  assert.equal(calls.length,1);
  assert.equal(calls[0].path,'/api/rooms/ABC234/summary');
  assert.equal(calls[0].options.method,'GET');
  assert.equal(calls[0].options.headers.Authorization,`Bearer ${token}`);
  assert.ok(data.has('dendarv.online.pending.ABC234'));
});

test('network failure and expired access retain remembered details rather than deleting games', async t=>{
  const data=browser(t);
  data.set('dendarv.online.room.ABC234','a'.repeat(64));
  globalThis.fetch=async()=>{throw new Error('offline');};
  let games=await OnlineClient.refreshRememberedGames();
  assert.match(games[0].error,/Could not refresh/);
  assert.equal(games[0].is_your_turn,false);
  globalThis.fetch=async()=>new Response(JSON.stringify({error:{code:'ROOM_ACCESS_EXPIRED',message:'Expired'}}),{status:410});
  games=await OnlineClient.refreshRememberedGames();
  assert.match(games[0].error,/30-day/);
  assert.ok(data.has('dendarv.online.room.ABC234'));
});

test('seat recovery adds a game on a fresh browser and takeover marks an old browser for recovery', async t=>{
  const data=browser(t), client=new OnlineClient('ABC234');
  globalThis.fetch=async()=>response({token:'a'.repeat(64),recoveryCode:'b'.repeat(64),view:view()});
  await client.recover('b'.repeat(64));
  assert.equal(OnlineClient.rememberedGames()[0].needs_recovery,false);
  assert.equal(data.get('dendarv.online.recovery.ABC234'),'b'.repeat(64));
  globalThis.fetch=async()=>response({code:'ABC234',name:'Amber Harbour',status:'ACTIVE',players:[],seat:null,is_your_turn:false,needs_recovery:true});
  const games=await OnlineClient.refreshRememberedGames();
  assert.equal(games[0].needs_recovery,true);
  assert.equal(data.get('dendarv.online.room.ABC234'),'a'.repeat(64),'listing must not claim or revoke a seat');
});

test('corrupt convenience data does not hide remembered credentials; blocked storage prevents a mutation before sending', async t=>{
  const data=browser(t);
  data.set('dendarv.online.games','not json');
  data.set('dendarv.online.room.ABC234','a'.repeat(64));
  assert.equal(OnlineClient.rememberedGames()[0].code,'ABC234');
  let sent=false;
  globalThis.localStorage={getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}};
  globalThis.fetch=async()=>{sent=true;throw new Error('unexpected');};
  await assert.rejects(()=>OnlineClient.create({playerCount:2,playerName:'Sammy',seat:'WHITE'}),error=>error.code==='SITE_STORAGE_UNAVAILABLE');
  assert.equal(sent,false);
});
