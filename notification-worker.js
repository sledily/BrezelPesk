/* Browser-only push receiver. Never caches game pages, credentials or private views. */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
let queue=Promise.resolve();
function receipts(id,write=false) {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('dendarv-notification-receipts',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('seen');
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{
      const db=request.result,tx=db.transaction('seen',write?'readwrite':'readonly'),store=tx.objectStore('seen');
      const item=write?store.put(Date.now(),id):store.get(id);
      let value;item.onsuccess=()=>{value=item.result;};
      if(write) {
        const cursor=store.openCursor();cursor.onsuccess=()=>{const c=cursor.result;if(!c)return;if(c.value<Date.now()-30*86400000)c.delete();c.continue();};
      }
      tx.oncomplete=()=>{db.close();resolve(value);};tx.onerror=()=>{db.close();reject(tx.error);};
    };
  });
}
async function receive(event) {
  let message;try{message=event.data.json();}catch{return;}
  if(!/^[A-Z2-9]{6}$/.test(message.code) || !/^[a-f0-9]{64}$/.test(message.id)) return;
  const url=new URL(`/?room=${message.code}`,self.location.origin).href;
  try {if(await receipts(message.id)) return;}catch{/* Stable tag still coalesces duplicates when storage is unavailable. */}
  const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  const visible=windows.find(w=>w.focused && w.visibilityState==='visible' && new URL(w.url).searchParams.get('room')===message.code);
  if(visible) visible.postMessage({type:'DENDARV_REFRESH',code:message.code});
  else await self.registration.showNotification(String(message.title??'Dendarv').slice(0,80),{
    body:String(message.body??'Open your game.').slice(0,160),tag:String(message.tag??message.id).slice(0,100),renotify:false,data:{url},
  });
  try {await receipts(message.id,true);}catch{/* The same tag also prevents a duplicate visible notification. */}
}
self.addEventListener('push',event=>{
  queue=queue.catch(()=>{}).then(()=>receive(event));event.waitUntil(queue);
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const url=new URL(event.notification.data?.url??'/',self.location.origin);
    if(url.origin!==self.location.origin) return;
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing=windows.find(w=>new URL(w.url).searchParams.get('room')===url.searchParams.get('room'));
    if(existing) return existing.focus();
    return self.clients.openWindow(url.href);
  })());
});
