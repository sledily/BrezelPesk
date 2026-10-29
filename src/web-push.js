import webpush from 'web-push';
import {validateSubscription} from './notifications.js';

export function pushConfiguration(env=process.env) {
  const {DENDARV_PUBLIC_ORIGIN:origin,DENDARV_VAPID_PUBLIC_KEY:publicKey,DENDARV_VAPID_PRIVATE_KEY:privateKey,DENDARV_VAPID_SUBJECT:subject}=env;
  if(!origin || !publicKey || !privateKey || !subject) return {enabled:false};
  const url=new URL(origin);
  if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw Error('DENDARV_PUBLIC_ORIGIN must be an HTTPS origin');
  webpush.setVapidDetails(subject,publicKey,privateKey);
  return {enabled:true,publicKey,publicOrigin:url.origin,send:async(subscription,payload,id)=>{
    const clean=validateSubscription(subscription);
    await webpush.sendNotification(clean,payload,{TTL:300,timeout:10000,urgency:'normal',topic:id.slice(0,32),vapidDetails:{subject,publicKey,privateKey}});
  }};
}
