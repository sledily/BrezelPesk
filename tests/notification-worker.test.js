import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {notificationSupport,notificationConfiguration,enableGameNotifications,disableGameNotifications} from '../src/browser-notifications.js';

function worker(windows=[]) {
 const handlers={},shown=[],messages=[],opened=[],seen=new Map();
 const indexedDB={open(){const req={};queueMicrotask(()=>{
   req.result={close(){},transaction(){const tx={};tx.objectStore=()=>({
     get(id){const op={};queueMicrotask(()=>{op.result=seen.get(id);op.onsuccess?.();});return op;},
     put(time,id){seen.set(id,time);const op={};queueMicrotask(()=>op.onsuccess?.());return op;},
     openCursor(){const op={result:null};queueMicrotask(()=>op.onsuccess?.());return op;},
   });setTimeout(()=>tx.oncomplete?.(),0);return tx;}};req.onsuccess();
 });return req;}};
 const self={location:{origin:'https://game.example'},addEventListener:(type,fn)=>handlers[type]=fn,
 registration:{showNotification:async(title,options)=>shown.push({title,options})},
 clients:{matchAll:async()=>windows.map(w=>({...w,postMessage:m=>messages.push(m),focus:async()=>opened.push(w.url)})),openWindow:async url=>opened.push(url)}};
 runInNewContext(readFileSync(new URL('../notification-worker.js',import.meta.url),'utf8'),{self,indexedDB,URL,Date,Promise,console});
 return {shown,messages,opened,async push(message){let pending;handlers.push({data:{json:()=>message},waitUntil:p=>pending=p});await pending;},
 async click(url){let pending;handlers.notificationclick({notification:{data:{url},close(){}},waitUntil:p=>pending=p});await pending;}};
}
const message={id:'a'.repeat(64),code:'ABC234',title:'Amber Harbour',body:'It is your turn.',tag:'dendarv-ABC234-player',url:'https://malicious.example/'};
test('service worker deduplicates event IDs and only opens the same-origin game',async()=>{
 const w=worker();await Promise.all([w.push(message),w.push(message)]);assert.equal(w.shown.length,1);
 assert.equal(w.shown[0].options.data.url,'https://game.example/?room=ABC234');
 await w.click('https://malicious.example/');assert.equal(w.opened.length,0);
 await w.click(w.shown[0].options.data.url);assert.deepEqual(w.opened,['https://game.example/?room=ABC234']);
});
test('focused game receives a refresh instead of a system alert; another game does not suppress it',async()=>{
 const w=worker([{url:'https://game.example/?room=ABC234',focused:true,visibilityState:'visible'}]);await w.push(message);
 assert.equal(w.shown.length,0);assert.equal(w.messages[0].code,'ABC234');
 const other=worker([{url:'https://game.example/?room=DEF567',focused:true,visibilityState:'visible'}]);await other.push(message);assert.equal(other.shown.length,1);
});
test('browser opt-in is explicit, denial does not subscribe, and disabling affects only one game',async t=>{
 const saved=Object.fromEntries(['Notification','navigator','PushManager','isSecureContext','location','fetch'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 t.after(()=>{for(const [k,d] of Object.entries(saved)){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}});
 const calls=[];
 for(const [key,value] of Object.entries({Notification:{requestPermission:async()=>{calls.push('permission');return 'denied';}},navigator:{serviceWorker:{register:async()=>calls.push('register')}},PushManager:{},isSecureContext:true,location:{origin:'https://game.example'},fetch:async()=>new Response(JSON.stringify({enabled:true,origin:'https://game.example',publicKey:'key'}))}))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 assert.equal(notificationSupport(),true);assert.equal((await notificationConfiguration()).enabled,true);assert.deepEqual(calls,[]);
 const client={mutate:async(action,body)=>calls.push({action,body})};
 await assert.rejects(()=>enableGameNotifications(client,{enabled:true,publicKey:'key'}),/not enabled/);assert.deepEqual(calls,['permission']);
 await disableGameNotifications(client);assert.deepEqual(calls[1],{action:'notifications',body:{subscription:null}});
});
