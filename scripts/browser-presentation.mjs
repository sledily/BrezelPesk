import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {newMatch,dispatch} from '../src/engine.js';
import {recordEvent} from '../src/model.js';
import {projectForPlayer} from '../src/projection.js';
import {V2_RULES,PHASE,SUIT} from '../src/constants.js';
import {forcePhase,giveResource} from '../tests/helpers.js';

const require=createRequire(import.meta.url);
let playwright;
try {playwright=require('playwright');}
catch {playwright=require(`${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/playwright`);}
const artifacts=join(process.cwd(),'browser-artifacts');await mkdir(artifacts,{recursive:true});
const temporary=await mkdtemp(join(tmpdir(),'dendarv-browser-'));
const port=4187,origin=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),DENDARV_DATA_DIR:temporary},stdio:'pipe'});
let browser;
const errors=[];
try {
  for(let i=0;i<100;i++){try{const response=await fetch(`${origin}/api/health`);if(response.ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  browser=await playwright.chromium.launch({headless:true,args:['--no-sandbox']});
  const desktop=await browser.newContext({viewport:{width:1440,height:1050},reducedMotion:'no-preference'});
  const page=await desktop.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await page.getByRole('button',{name:'Ready',exact:true}).click();
  assert.equal(await page.locator('#board .square').count(),64);
  assert.equal(await page.locator('.realm-hand').count(),4);
  assert.equal(await page.locator('#review-turns').isVisible(),true);
  await page.screenshot({path:join(artifacts,'four-player-table.png'),fullPage:true});
  await page.getByRole('button',{name:'New',exact:true}).click();await page.getByLabel('Players',{exact:true}).selectOption('2');
  await page.locator('#new-game-form button[value="start"]').click();await page.getByRole('button',{name:'Ready',exact:true}).click();
  await page.getByRole('button',{name:/BOUDICA/}).click();await page.getByRole('button',{name:'Return to table',exact:true}).click();await page.getByRole('button',{name:'Ready',exact:true}).click();
  await page.getByRole('button',{name:/DAVID/}).click();await page.getByRole('button',{name:'Return to table',exact:true}).click();
  if(await page.locator('#handoff').isVisible())await page.getByRole('button',{name:'Ready',exact:true}).click();
  await page.locator('#phase-transition').waitFor({state:'visible',timeout:5000});
  assert.match(await page.locator('#phase-transition').innerText(),/Year 1|Harvest/);
  await page.screenshot({path:join(artifacts,'phase-arrival.png'),fullPage:true});

  let state=newMatch({seed:'browser-recap',playerCount:4,rules:V2_RULES});
  while(state.status==='SETUP'){const result=dispatch(state,{type:'CHOOSE_SOVEREIGN',player:state.current_actor,noble_id:state.sovereign_pool_ids[0]});assert.equal(result.ok,true);state=result.state;}
  forcePhase(state,PHASE.MOBILIZE);state.event_log=[];state.event_sequence=0;
  for(const [index,player] of Object.keys(state.players).entries())for(const suit of Object.values(SUIT))for(const value of (index<2?[4,7,9]:[3,6,8]))giveResource(state,player,suit,value);
  recordEvent(state,'ActorPassed',{player:'WHITE',phase:PHASE.MOBILIZE,automatic:false});state.current_actor='BLACK';
  const spades=state.players.BLACK.resource_hand_ids.filter(id=>state.resources_by_id[id].suit===SUIT.SPADES);
  recordEvent(state,'ResourceCardsTapped',{player:'BLACK',suit:SUIT.SPADES,card_ids:spades,value:spades.reduce((n,id)=>n+state.resources_by_id[id].face_value,0)});
  const moving=state.players.BLACK.unit_ids.find(id=>state.units_by_id[id].unit_type==='KING');
  recordEvent(state,'UnitMobilized',{player:'BLACK',unit_id:moving,origin:'h8',destination:'f6',cost:4});
  recordEvent(state,'UnitMobilized',{player:'BLACK',unit_id:moving,origin:'f6',destination:'e5',cost:4});
  const battle=recordEvent(state,'CombatResolved',{attacker_id:'sample-A',defender_id:'sample-D',cost:4,
    attacker_snapshot:{unit:{unit_id:'sample-A',owner:'BLACK',unit_type:'QUEEN',square:'d4'},noble:{noble_id:'NC-J-D',face:'JACK',suit:'DIAMONDS',rank:1}},
    defender_snapshot:{unit:{unit_id:'sample-D',owner:'WHITE',unit_type:'BISHOP',square:'e5'},noble:{noble_id:'NC-K-S',face:'KING',suit:'SPADES',rank:3}},
    attacker_rolls:[6,3,2],defender_rolls:[5,1],attacker_high:6,defender_high:5,attacker_bonus:1,defender_bonus:3,attacker_total:7,defender_total:8,outcome:'DEFENDER_WIN'});
  recordEvent(state,'NobleRecruited',{player:'BLACK',noble_id:'NC-Q-H-A',cost:8},'BLACK');
  recordEvent(state,'ActorPassed',{player:'BLACK',phase:PHASE.MOBILIZE,automatic:false});
  const payload={game:projectForPlayer(state,'WHITE'),room:{code:'ABC234',status:'ACTIVE',revision:1,player_count:4,seats:{}},viewer:{role:'PLAYER',seat:'WHITE',private_revision:1,can_undo:false,is_your_turn:false}};
  const bundle=await readFile('Dendarv_Play.html','utf8');
  const testBundle=bundle.replace(/\}\)\(\);\s*<\/script>/,'globalThis.__dendarv = { recapPresenter, getState:()=>state };\n})();\n</script>');
  assert.notEqual(testBundle,bundle);
  await page.route('**/Dendarv_Play.html*',route=>route.fulfill({contentType:'text/html',body:testBundle}));
  await page.route('**/api/rooms/ABC234',route=>route.fulfill({json:payload}));
  await page.goto(`${origin}/Dendarv_Play.html?room=ABC234`);
  await page.locator('#recap-dialog').waitFor({state:'visible'});
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  const original=await page.evaluate(()=>JSON.stringify(__dendarv.getState()));
  assert.equal(await page.evaluate(()=>__dendarv.recapPresenter.steps.filter(s=>s.kind==='move').length),2);
  assert.equal(await page.evaluate(()=>__dendarv.recapPresenter.steps.filter(s=>s.kind==='combat').length),1);
  const queue=await page.evaluate(()=>JSON.stringify(__dendarv.recapPresenter.steps));assert.doesNotMatch(queue,/NC-Q-H-A|INNOCENT/);
  await page.screenshot({path:join(artifacts,'returning-player.png'),fullPage:true});
  await page.getByRole('button',{name:'Next action',exact:true}).click();
  assert.match(await page.locator('#recap-step').innerText(),/h8.*f6/s);
  await page.screenshot({path:join(artifacts,'movement-recap.png')});
  await page.getByRole('button',{name:'Next action',exact:true}).click();await page.getByRole('button',{name:'Next action',exact:true}).click();
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await page.locator('.recap-combat.combat-rolling').waitFor({state:'visible'});
  const animations=await page.locator('#recap-step').evaluate(el=>el.getAnimations({subtree:true}).map(a=>a.animationName));
  assert.ok(animations.includes('printed-die-tumble'));
  await page.screenshot({path:join(artifacts,'combat-rolling.png')});
  await page.locator('.recap-combat.combat-bonus').waitFor({state:'visible',timeout:10000});
  assert.match(await page.locator('#recap-step').innerText(),/Highest 6.*7/s);assert.match(await page.locator('#recap-step').innerText(),/Highest 5.*8/s);
  await page.screenshot({path:join(artifacts,'combat-arithmetic.png')});
  await page.getByRole('button',{name:'Skip to current board',exact:true}).click();
  assert.equal(await page.evaluate(()=>JSON.stringify(__dendarv.getState())),original);
  await page.reload();await page.locator('#recap-dialog').waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>__dendarv.recapPresenter.index),0);
  await page.getByRole('button',{name:'Skip to current board',exact:true}).click();
  await page.getByRole('button',{name:'Since my last turn',exact:true}).click();await page.locator('#recap-dialog').waitFor({state:'visible'});

  const mobile=await browser.newContext({viewport:{width:960,height:540},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  const phone=await mobile.newPage();phone.on('pageerror',e=>errors.push(e.message));
  await phone.route('**/Dendarv_Play.html*',route=>route.fulfill({contentType:'text/html',body:testBundle}));await phone.route('**/api/rooms/ABC234',route=>route.fulfill({json:payload}));
  await phone.goto(`${origin}/Dendarv_Play.html?room=ABC234`);await phone.locator('#recap-dialog').waitFor({state:'visible'});
  assert.equal(await phone.evaluate(()=>__dendarv.recapPresenter.paused),true);
  assert.equal(await phone.locator('#recap-step').evaluate(el=>el.getAnimations({subtree:true}).length),0);
  const geometry=await phone.locator('#recap-dialog').evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};});
  assert.ok(geometry.x>=0&&geometry.y>=0&&geometry.right<=geometry.width&&geometry.bottom<=geometry.height);
  await phone.screenshot({path:join(artifacts,'phone-landscape-recap.png')});
  await phone.getByRole('button',{name:'Skip to current board',exact:true}).click();
  assert.ok(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'landscape table has no horizontal overflow');
  await phone.screenshot({path:join(artifacts,'phone-landscape-table.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  await writeFile(join(artifacts,'checks.json'),JSON.stringify({result:'passed',checks:['modular and offline-bundle startup','native local setup and Court reveal handover','Year/phase arrival','complete reconnect queue','saved combat dice and arithmetic','CSS dice motion','pause/next/skip without state changes','refresh and manual replay','private Court redaction','native reduced-motion preference','touch landscape bounds'],battleEvent:battle.event_id},null,2));
  console.log('Browser presentation checks passed; screenshots in browser-artifacts.');
} finally {await browser?.close();server.kill();await rm(temporary,{recursive:true,force:true});}
