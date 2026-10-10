// Temporary transfer of the generated bundle into immutable Git storage.
// No commit, branch update, merge or deployment occurs here.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const bytes=await readFile('Dendarv_Play.html');
const sha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
if(sha!=='2221134011da8eb2b4f07bea8dc53a92b9c87823')throw new Error('Unexpected standalone build');
const response=await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/git/blobs`,{
  method:'POST',headers:{Authorization:`Bearer ${process.env.DENDARV_GIT_TOKEN}`,Accept:'application/vnd.github+json','Content-Type':'application/json'},
  body:JSON.stringify({content:bytes.toString('base64'),encoding:'base64'})
});
const result=await response.json();
if(!response.ok||result.sha!==sha)throw new Error(`Standalone transfer failed: ${response.status} ${result.message??'hash mismatch'}`);
console.log(`Generated standalone verified and stored: ${sha}`);
