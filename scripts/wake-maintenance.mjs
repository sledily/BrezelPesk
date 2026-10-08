// Run from an external scheduler after deployment; never prints its secret.
const {DENDARV_MAINTENANCE_URL,DENDARV_MAINTENANCE_TOKEN}=process.env;
let url;
try {url=new URL(DENDARV_MAINTENANCE_URL);}catch{throw Error('Set DENDARV_MAINTENANCE_URL');}
if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.pathname!=='/api/maintenance') throw Error('Maintenance URL must be HTTPS with path /api/maintenance');
if(!DENDARV_MAINTENANCE_TOKEN || DENDARV_MAINTENANCE_TOKEN.length<32) throw Error('Set a maintenance token of at least 32 characters');
const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${DENDARV_MAINTENANCE_TOKEN}`},redirect:'error',signal:AbortSignal.timeout(180000)});
if(!response.ok) throw Error(`Maintenance request failed (${response.status})`);
console.log('Maintenance request accepted.');
