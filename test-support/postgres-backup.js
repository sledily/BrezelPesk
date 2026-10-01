import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PostgresRoomStorage, defaultLimits } from '../src/room-storage.js';

function embeddedPool(pg) {
  let tail = Promise.resolve();
  const query = (sql, params) => sql.includes('CREATE TABLE') ? pg.exec(sql).then(r=>r.at(-1)) : pg.query(sql,params);
  return { query, end:()=>pg.close(), connect:async()=>{
    const previous=tail;let release;tail=new Promise(r=>{release=r;});await previous;
    return {query,release};
  }};
}

function runTool(command, args, env, input) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{env,stdio:['pipe','pipe','pipe']});
    const chunks=[],errors=[];
    child.stdout.on('data',chunk=>chunks.push(chunk));
    child.stderr.on('data',chunk=>errors.push(chunk));
    child.on('error',reject);
    child.on('close',code=>code===0?resolve(Buffer.concat(chunks)):reject(new Error(`Backup test utility exited ${code}: ${Buffer.concat(errors).toString()}`)));
    child.stdin.on('error',error=>{if(error.code!=='EPIPE')reject(error);});
    child.stdin.end(input);
  });
}

export async function backupDatabase(t) {
  if (!process.env.DENDARV_TEST_DATABASE_URL) {
    const {PGlite}=await import('@electric-sql/pglite');
    const pg=await PGlite.create();let sourceClosed=false,restored;
    const source=new PostgresRoomStorage(embeddedPool(pg),defaultLimits);await source.init();
    t.after(async()=>{if(!sourceClosed)await source.close();if(restored)await restored.close();});
    return {source,kind:'embedded data-directory backup',restore:async()=>{
      const backup=await pg.dumpDataDir();
      await source.close();sourceClosed=true;
      restored=new PostgresRoomStorage(embeddedPool(await PGlite.create({loadDataDir:backup})),defaultLimits);
      await restored.init();return restored;
    }};
  }
  const {Pool}=await import('pg');
  const url=new URL(process.env.DENDARV_TEST_DATABASE_URL);
  const bootstrap=new Pool({connectionString:url.toString()});
  const suffix=randomBytes(10).toString('hex');
  const names=[`dendarv_backup_${suffix}`,`dendarv_restore_${suffix}`];
  const created=[];let source,restored,sourceClosed=false;
  t.after(async()=>{
    if(source&&!sourceClosed)await source.close();
    if(restored)await restored.close();
    // Only databases generated and successfully created by this test are removed.
    for(const name of created)await bootstrap.query(`DROP DATABASE IF EXISTS ${name}`);
    await bootstrap.end();
  });
  for(const name of names){await bootstrap.query(`CREATE DATABASE ${name}`);created.push(name);}
  const poolFor=name=>{const target=new URL(url);target.pathname=`/${name}`;return new Pool({connectionString:target.toString()});};
  source=new PostgresRoomStorage(poolFor(names[0]),defaultLimits);await source.init();
  const container=process.env.DENDARV_TEST_POSTGRES_CONTAINER;
  const tool=(program,database,args,input)=>{
    const env={...process.env,PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGDATABASE:database,
      PGHOST:container?'127.0.0.1':url.hostname,PGPORT:container?'5432':url.port||'5432'};
    const dockerArgs=['exec','-i',...['PGUSER','PGPASSWORD','PGDATABASE','PGHOST','PGPORT'].flatMap(key=>['-e',key]),container,program,...args];
    return runTool(container?'docker':program,container?dockerArgs:args,env,input);
  };
  return {source,kind:'native pg_dump / pg_restore',restore:async()=>{
    const backup=await tool('pg_dump',names[0],['--format=custom','--no-acl','--no-password']);
    await source.close();sourceClosed=true;
    await bootstrap.query(`DROP DATABASE ${names[0]}`);
    await tool('pg_restore',names[1],['--dbname',names[1],'--no-owner','--no-acl','--no-password','--single-transaction','--exit-on-error'],backup);
    restored=new PostgresRoomStorage(poolFor(names[1]),defaultLimits);await restored.init();return restored;
  }};
}
