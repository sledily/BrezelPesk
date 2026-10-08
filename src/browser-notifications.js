export function notificationSupport(scope=globalThis) {
  return Boolean(scope.isSecureContext && scope.Notification && scope.navigator?.serviceWorker && scope.PushManager);
}
function applicationKey(value) {
  const base64=value.replace(/-/g,'+').replace(/_/g,'/');
  return Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
}
export async function notificationConfiguration() {
  if(!notificationSupport()) return {enabled:false,reason:'This browser does not support push notifications here. Use a supported browser over HTTPS.'};
  try {
    const response=await fetch('/api/notifications/config',{cache:'no-store'});
    if(!response.ok) throw Error('configuration');
    const config=await response.json();
    if(!config.enabled) return {enabled:false,reason:'Notifications are not yet configured on this server.'};
    if(config.origin!==location.origin) return {enabled:false,reason:'Open the configured game address to enable notifications.'};
    return config;
  } catch {return {enabled:false,reason:'Notification settings could not be loaded. Reload the page to retry.'};}
}
export async function enableGameNotifications(client,config) {
  if(!config?.enabled || !notificationSupport()) throw Error(config?.reason??'Push notifications are unavailable here.');
  // Must run directly from the user's click, before registration/network awaits.
  const permission=await Notification.requestPermission();
  if(permission!=='granted') throw Error('Notifications were not enabled. You can change this in your browser’s site permissions.');
  await navigator.serviceWorker.register('/notification-worker.js',{scope:'/'});
  const registration=await navigator.serviceWorker.ready;
  let subscription=await registration.pushManager.getSubscription();
  if(!subscription) subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:applicationKey(config.publicKey)});
  return client.mutate('notifications',{subscription:subscription.toJSON()});
}
export function disableGameNotifications(client) {
  // One browser subscription may serve several games; disable only this game.
  return client.mutate('notifications',{subscription:null});
}
