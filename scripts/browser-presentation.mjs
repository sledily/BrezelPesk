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
import {pieceIcon} from '../src/presentation.js';
import {forcePhase,giveResource} from '../tests/helpers.js';

const require=createRequire(import.meta.url);
let playwright;
try {playwright=require('playwright');}
catch {playwright=require(`${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/playwright`);}
const artifacts=join(process.cwd(),'browser-artifacts');await mkdir(artifacts,{recursive:true});
const temporary=await mkdtemp(join(tmpdir(),'dendarv-browser-'));
const port=4187,origin=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),DENDARV_DATA_DIR:temporary},stdio:'pipe'});
let browser,activePage;
const errors=[];
try {
  for(let i=0;i<100;i++){try{const response=await fetch(`${origin}/api/health`);if(response.ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  browser=await playwright.chromium.launch({headless:true,args:['--no-sandbox']});
  const desktop=await browser.newContext({viewport:{width:1440,height:1050},reducedMotion:'no-preference'});
  const page=await desktop.newPage();activePage=page;page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await page.getByRole('button',{name:'Ready',exact:true}).click();
  assert.equal(await page.locator('#board .square').count(),64);
  assert.equal(await page.locator('.realm-hand').count(),4);
  assert.equal(await page.locator('#review-turns').isVisible(),true);
  await page.locator('.suit-heading .suit-icon').first().waitFor({state:'visible'});
  const suitFills=await page.locator('.realm-hand').first().locator('.suit-heading .suit-fill').evaluateAll(paths=>paths.map(p=>getComputedStyle(p).fill));
  assert.equal(suitFills.length,4);
  assert.equal(suitFills[0],suitFills[2],'Clubs and Spades use the same black');
  assert.equal(suitFills[1],suitFills[3],'Diamonds and Hearts use the same red');
  assert.notEqual(suitFills[0],suitFills[1]);
  assert.ok(Math.max(...suitFills[0].match(/\d+/g).map(Number))<60,'the black suits stay black');
  const red=suitFills[1].match(/\d+/g).map(Number);assert.ok(red[0]>red[1]*2&&red[0]>red[2]*2,'the red suits stay red');
  await page.screenshot({path:join(artifacts,'four-player-table.png'),fullPage:true});
  // Inspect all six approved miniatures with the app's actual SVG and colour rules.
  const pieceTypes=['PAWN','ROOK','KNIGHT','BISHOP','QUEEN','KING'];
  const piecePlayers=['WHITE','BLACK','GREEN','RED'];
  const pieceStudy=piecePlayers.map(player=>`<div style="display:grid;grid-template-columns:60px repeat(6,70px);align-items:center;gap:8px"><strong>${player}</strong>${pieceTypes.map(unit_type=>`<div style="background:${unit_type==='ROOK'||unit_type==='BISHOP'||unit_type==='KING'?'#49647a':'#ead8ae'};padding:8px;display:grid;place-items:center">${pieceIcon({owner:player,unit_type})}</div>`).join('')}</div>`).join('');
  await page.evaluate(markup=>{const el=document.createElement('section');el.id='miniature-art-qa';el.setAttribute('aria-label','Painted miniatures in all four player colours');el.style.cssText='position:absolute;left:20px;top:20px;z-index:10000;padding:18px;background:#f5e9cc;display:grid;gap:8px;color:#24251b';el.innerHTML=markup;document.body.append(el);},pieceStudy);
  assert.equal(await page.locator('#miniature-art-qa .painted-miniature').count(),24);
  const paints=await page.locator('#miniature-art-qa .realm-piece').evaluateAll(els=>els.map(el=>({colour:getComputedStyle(el.querySelector('.miniature-body')).fill,gold:getComputedStyle(el.querySelector('.miniature-gold')??el.querySelector('.miniature-body')).fill,viewBox:el.querySelector('svg').getAttribute('viewBox')})));
  assert.equal(new Set(paints.map(p=>p.colour)).size,4);
  assert.ok(paints.every(p=>p.viewBox==='0 0 64 80'&&p.colour!=='none'&&p.gold!=='none'));
  await page.locator('#miniature-art-qa').screenshot({path:join(artifacts,'painted-miniatures.png')});
  await page.locator('#miniature-art-qa').evaluate(el=>el.remove());
  await page.evaluate(()=>{
    const study=document.createElement('section');study.id='symbol-art-qa';
    study.style.cssText='position:absolute;left:20px;top:20px;z-index:10000;padding:18px;background:#f5e9cc;color:#24251b;font:36px Georgia,serif';
    const label=document.createElement('p');label.textContent='Rx♧  Dx◇  Vz♤  Rx♡';study.append(label);
    const select=document.createElement('select'),option=document.createElement('option');option.textContent='Rx♧ · BOUDICA';select.append(option);study.append(select);
    const record=document.createElement('pre');record.textContent='Saved notation: Rx♧';study.append(record);
    const literal=document.createElement('p');literal.textContent='<img src=x onerror=alert(1)> Dx◇';study.append(literal);
    document.body.append(study);
  });
  await page.locator('#symbol-art-qa .noble-rank sub').last().waitFor({state:'visible'});
  assert.equal(await page.locator('#symbol-art-qa .noble-rank sub').count(),5);
  const subs=await page.locator('#symbol-art-qa .noble-rank sub').evaluateAll(nodes=>nodes.map(el=>({size:parseFloat(getComputedStyle(el).fontSize),parent:parseFloat(getComputedStyle(el.parentElement).fontSize),align:getComputedStyle(el).verticalAlign})));
  assert.ok(subs.every(sub=>sub.size<sub.parent*.8&&sub.align==='sub'));
  assert.equal(await page.locator('#symbol-art-qa option').textContent(),'Rex of Clubs · BOUDICA');
  assert.equal(await page.locator('#symbol-art-qa pre').textContent(),'Saved notation: Rx♧');
  assert.equal(await page.locator('#symbol-art-qa img').count(),0,'literal text never becomes HTML');
  assert.match(await page.locator('#symbol-art-qa').textContent(),/<img src=x onerror=alert\(1\)>/);
  await page.locator('#symbol-art-qa').screenshot({path:join(artifacts,'suits-and-noble-ranks.png')});
  await page.locator('#symbol-art-qa').evaluate(el=>el.remove());
  await page.getByRole('button',{name:'New',exact:true}).click();await page.locator('#new-game-form').getByLabel('Players',{exact:true}).selectOption('2');
  await page.locator('#new-game-form button[value="start"]').click();await page.getByRole('button',{name:'Ready',exact:true}).click();
  await page.locator('.sovereign-choice[data-noble-id="NC-K-C"]').click();assert.match(await page.locator('#inspection-dialog img.noble-art').getAttribute('alt'),/BOUDICA/i);
  await page.getByRole('button',{name:'Return to table',exact:true}).click();await page.getByRole('button',{name:'Ready',exact:true}).click();
  await page.locator('.sovereign-choice[data-noble-id="NC-K-S"]').click();assert.match(await page.locator('#inspection-dialog img.noble-art').getAttribute('alt'),/DAVID/i);
  await page.getByRole('button',{name:'Return to table',exact:true}).click();
  if(await page.locator('#handoff').isVisible())await page.getByRole('button',{name:'Ready',exact:true}).click();
  await page.locator('#phase-transition').waitFor({state:'visible',timeout:5000});
  assert.match(await page.locator('#phase-transition').innerText(),/Year 1|Harvest/);
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#phase-transition h2')).opacity==='1');
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
  const payload={game:projectForPlayer(state,'WHITE'),room:{code:'ABC234',name:'BrezelPesk',status:'ACTIVE',revision:1,player_count:4,spectator_count:0,seats:{}},viewer:{role:'PLAYER',seat:'WHITE',private_revision:1,can_undo:false,is_your_turn:false}};
  const bundle=await readFile('Dendarv_Play.html','utf8');
  const testBundle=bundle.replace(/\}\)\(\);\s*<\/script>/,'globalThis.__dendarv = { recapPresenter, getState:()=>state };\n})();\n</script>');
  assert.notEqual(testBundle,bundle);
  await page.route('**/Dendarv_Play.html*',route=>route.fulfill({contentType:'text/html',body:testBundle}));
  await page.route('**/api/rooms/ABC234',route=>route.fulfill({json:payload}));
  await page.goto(`${origin}/Dendarv_Play.html?room=ABC234`);
  await page.locator('#recap-dialog').waitFor({state:'visible'});
  const firstIllustration=await page.locator('#recap-step .story-visual').elementHandle();
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  assert.equal(await firstIllustration.evaluate(el=>el.isConnected),true,'pause preserves the existing animation');
  const original=await page.evaluate(()=>JSON.stringify(__dendarv.getState()));
  assert.equal(await page.evaluate(()=>__dendarv.recapPresenter.steps.filter(s=>s.kind==='move').length),2);
  assert.equal(await page.evaluate(()=>__dendarv.recapPresenter.steps.filter(s=>s.kind==='combat').length),1);
  const queue=await page.evaluate(()=>JSON.stringify(__dendarv.recapPresenter.steps));assert.doesNotMatch(queue,/NC-Q-H-A|INNOCENT/);
  await page.screenshot({path:join(artifacts,'returning-player.png'),fullPage:true});
  await page.getByRole('button',{name:'Next action',exact:true}).click();
  assert.match(await page.locator('#recap-step').innerText(),/h8.*f6/s);
  await page.screenshot({path:join(artifacts,'movement-recap.png')});
  await page.getByRole('button',{name:'Next action',exact:true}).click();await page.getByRole('button',{name:'Next action',exact:true}).click();
  assert.match(await page.locator('.recap-combat.combat-complete').innerText(),/Highest 6.*7/s);
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

  const mobile=await browser.newContext({viewport:{width:812,height:375},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  const phone=await mobile.newPage();activePage=phone;phone.on('pageerror',e=>errors.push(e.message));
  await phone.route('**/Dendarv_Play.html*',route=>route.fulfill({contentType:'text/html',body:testBundle}));await phone.route('**/api/rooms/ABC234',route=>route.fulfill({json:payload}));
  await phone.goto(`${origin}/Dendarv_Play.html?room=ABC234`);await phone.locator('#recap-dialog').waitFor({state:'visible'});
  assert.equal(await phone.evaluate(()=>__dendarv.recapPresenter.paused),true);
  assert.equal(await phone.locator('#recap-step').evaluate(el=>el.getAnimations({subtree:true}).length),0);
  const geometry=await phone.locator('#recap-dialog').evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};});
  assert.ok(geometry.x>=0&&geometry.y>=0&&geometry.right<=geometry.width&&geometry.bottom<=geometry.height);
  const readable=await phone.evaluate(()=>{const text=document.querySelector('.story-explanation').getBoundingClientRect(),controls=document.querySelector('.recap-controls').getBoundingClientRect(),dialog=document.querySelector('#recap-dialog').getBoundingClientRect();return text.top>=dialog.top&&text.bottom<=controls.top;});
  assert.equal(readable,true,'landscape explanation is visible above the controls without scrolling');
  await phone.screenshot({path:join(artifacts,'phone-landscape-recap.png')});
  await phone.getByRole('button',{name:'Skip to current board',exact:true}).click();
  assert.ok(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'landscape table has no horizontal overflow');
  await phone.screenshot({path:join(artifacts,'phone-landscape-table.png'),fullPage:true});

  // The complete action area must remain usable beside the table after scrolling,
  // including when the available height is a phone's landscape viewport.
  const actionPayload=structuredClone(payload);
  actionPayload.game.current_actor='WHITE';
  actionPayload.game.players.WHITE.seasonal_pools.SPADES=99;
  actionPayload.room.code='XYZ345';
  actionPayload.room.summary={year:1,phase:PHASE.MOBILIZE,actor:'WHITE'};
  actionPayload.viewer.is_your_turn=true;
  const portrait=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  const portraitPage=await portrait.newPage();portraitPage.on('pageerror',e=>errors.push(e.message));
  for(const [target,name] of [[page,'desktop'],[phone,'phone-landscape'],[portraitPage,'phone-portrait']]) {
    activePage=target;
    await target.route('**/Dendarv_Play.html*',route=>route.fulfill({contentType:'text/html',body:testBundle}));
    await target.route('**/api/rooms/XYZ345',route=>route.fulfill({json:actionPayload}));
    await target.goto(`${origin}/Dendarv_Play.html?room=XYZ345`);
    await target.locator('#recap-dialog').waitFor({state:'visible'});
    await target.getByRole('button',{name:'Skip to current board',exact:true}).click();
    await target.locator('.vassal-badge .noble-rank sub').first().waitFor({state:'visible'});
    const badgePositions=await target.locator('.vassal-badge').evaluateAll(badges=>badges.map(badge=>{
      const piece=badge.parentElement.querySelector('.square .piece').getBoundingClientRect(),card=badge.getBoundingClientRect();
      return {upperRight:card.x+card.width/2>piece.x+piece.width/2&&card.y+card.height/2<piece.y+piece.height/2,smallSub:parseFloat(getComputedStyle(badge.querySelector('sub')).fontSize)<parseFloat(getComputedStyle(badge).fontSize)};
    }));
    assert.ok(badgePositions.length>0&&badgePositions.every(p=>p.upperRight&&p.smallSub),`${name}: every Levy badge is above and right of its piece, with a smaller subscript`);
    const recordBeforeInspection=await target.locator('#history').textContent();
    await target.locator('.vassal-badge').first().click();
    await target.locator('#inspection-dialog img.noble-art').waitFor({state:'visible'});
    await target.getByRole('button',{name:'Return to table',exact:true}).click();
    assert.equal(await target.locator('#history').textContent(),recordBeforeInspection,'badge inspection does not play a move');
    await target.evaluate(()=>scrollTo(0,0));
    assert.equal(await target.locator('.current-action #action-controls').count(),1);
    const start=await target.locator('.current-action').evaluate(el=>el.getBoundingClientRect().top+scrollY);
    await target.evaluate(top=>scrollTo(0,top+400),start);
    const card=target.locator('.card-choice:has([data-resource-id]:enabled)').first();
    await card.click();
    assert.equal(await target.locator('[data-resource-id]:checked').count(),1,'a table card remains selectable while actions are pinned');
    const finish=target.getByRole('button',{name:'Finish Mobilize and publish',exact:true});
    await finish.scrollIntoViewIfNeeded();
    const bounds=await target.locator('.current-action').evaluate(el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight,scrollY};});
    assert.ok(bounds.scrollY>start+10,`${name}: the document actually scrolled`);
    assert.ok(Math.abs(bounds.top)<1,`${name}: the full action area stays at the top`);
    assert.ok(bounds.bottom<=bounds.height/2+1,`${name}: at least half the viewport remains available for the table`);
    const button=await finish.boundingBox();
    assert.ok(button&&button.y>=0&&button.y+button.height<=bounds.bottom,`${name}: Finish remains reachable inside the pinned panel`);
    assert.ok(await target.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${name}: no horizontal overflow`);
    await target.screenshot({path:join(artifacts,`${name}-pinned-actions.png`)});
  }
  // Exercise the real local Harvest flow with every choice inside Current Action.
  for(const [target,name,deck] of [[page,'desktop','BLACK'],[phone,'phone-landscape','RED'],[portraitPage,'phone-portrait','BLACK']]) {
    activePage=target;
    await target.goto(origin);
    if(await target.locator('#handoff').isVisible())await target.getByRole('button',{name:'Ready',exact:true}).click();
    await target.getByRole('button',{name:'New',exact:true}).click();
    await target.locator('#new-game-form').getByLabel('Players',{exact:true}).selectOption('2');
    await target.locator('#new-game-form button[value="start"]').click();
    await target.getByRole('button',{name:'Ready',exact:true}).click();
    for(const noble of ['NC-K-C','NC-K-S']) {
      await target.locator(`.sovereign-choice[data-noble-id="${noble}"]`).click();
      await target.getByRole('button',{name:'Return to table',exact:true}).click();
      if(await target.locator('#handoff').isVisible())await target.getByRole('button',{name:'Ready',exact:true}).click();
    }
    const choices=target.locator('.current-action #harvest-table');
    assert.equal(await choices.locator('.harvest-draw').count(),2,'a corner offers both decks in Current Action');
    assert.equal(await target.locator('.board-frame #harvest-table').count(),0,'the board is clear of Harvest choices');
    const start=await target.locator('.current-action').evaluate(el=>el.getBoundingClientRect().top+scrollY);
    await target.evaluate(top=>scrollTo(0,top+200),start);
    await choices.locator(`[data-deck="${deck}"]`).click();
    assert.equal(await choices.locator('[data-harvest-card]').count(),3);
    const offer=await choices.locator('[data-harvest-card]').evaluateAll(cards=>cards.map(card=>card.dataset.harvestCard));
    await choices.locator('[data-harvest-card]').first().click();
    assert.equal(await choices.locator('#keep-harvest-selection').isEnabled(),true);
    await choices.locator('#cancel-harvest-selection').click();
    assert.deepEqual(await choices.locator('[data-harvest-card]').evaluateAll(cards=>cards.map(card=>card.dataset.harvestCard)),offer,'Cancel preserves the drawn offer');
    assert.equal(await choices.locator('#keep-harvest-selection').isEnabled(),false);
    await choices.locator('[data-harvest-card]').nth(1).click();
    const selected=await choices.locator('[data-harvest-card][aria-pressed="true"]').getAttribute('data-harvest-card');
    assert.equal(selected,offer[1]);
    // Native click targeting can scroll the document back toward the controls.
    // Check pinning after an explicit page scroll, independently of that targeting.
    await target.evaluate(top=>scrollTo(0,top+200),start);
    assert.ok(Math.abs(await target.locator('.current-action').evaluate(el=>el.getBoundingClientRect().top))<1,`${name}: Harvest choices remain pinned`);
    assert.ok(await target.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${name}: Harvest choices fit the viewport`);
    await target.screenshot({path:join(artifacts,`${name}-harvest-panel.png`)});
    await choices.locator('#keep-harvest-selection').click();
    await target.locator(`[data-resource-id="${selected}"]`).waitFor({state:'attached'});
    assert.equal(await target.locator(`[data-resource-id="${selected}"]`).count(),1,'Keep retains the selected physical card');
    for(const rejected of offer.filter(id=>id!==selected))assert.equal(await target.locator(`[data-resource-id="${rejected}"]`).count(),0,'rejected cards do not enter the hand');
    assert.equal(await choices.locator('[data-harvest-card]').count(),0,'the completed offer closes, including when an empty Poker window is skipped');
  }
  assert.deepEqual(errors,[]);
  await writeFile(join(artifacts,'checks.json'),JSON.stringify({result:'passed',checks:['modular and offline-bundle startup','native local setup and Court reveal handover','red/black SVG suits and smaller Noble subscripts','safe text decoration and native option labels','upper-right Levy badges and read-only inspection at all three viewport sizes','Year/phase arrival','complete reconnect queue','saved combat dice and arithmetic','CSS dice motion','pause/next/skip without state changes','refresh and manual replay','private Court redaction','native reduced-motion preference','touch landscape bounds','pinned action controls and table-card selection on desktop and portrait/landscape phones','Harvest deck choice, card selection, Cancel and Keep in the pinned panel on desktop and portrait/landscape phones'],battleEvent:battle.event_id},null,2));
  console.log('Browser presentation checks passed; screenshots in browser-artifacts.');
} catch(error) {
  if(activePage){
    await activePage.screenshot({path:join(artifacts,'failure.png'),fullPage:true}).catch(()=>{});
    const visible=await activePage.evaluate(()=>[...document.querySelectorAll('button')].filter(el=>el.getClientRects().length).map(el=>({id:el.id,text:el.textContent.trim()}))).catch(()=>[]);
    console.error('Browser failure:',activePage.url(),JSON.stringify({pageErrors:errors,visibleButtons:visible}));
  }
  throw error;
} finally {await browser?.close();server.kill();await rm(temporary,{recursive:true,force:true});}
