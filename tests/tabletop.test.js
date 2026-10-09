import test from 'node:test';
import assert from 'node:assert/strict';
import { PHASE, PLAYER, SUITS, UNIT_TYPE } from '../src/constants.js';
import { constantsHtml, tabletopRegionsHtml, nobleInspectionHtml } from '../src/tabletop.js';
import { forcePhase, setUpMatch, setUpFourPlayerMatch, giveResource, addUnit } from './helpers.js';

test('two-player and four-player tables use the same fixed corner mapping', () => {
  const two = tabletopRegionsHtml(setUpMatch('corners-two'));
  assert.match(two, /south-west white/);
  assert.match(two, /north-east black/);
  assert.doesNotMatch(two, /north-west red|south-east green/);
  const four = tabletopRegionsHtml(setUpFourPlayerMatch('corners-four'));
  assert.match(four, /south-east green/);
  assert.match(four, /north-west red/);
  assert.equal((four.match(/class="dungeon-slot/g) ?? []).length, 4);
  assert.doesNotMatch(four, /comparison-label|>Holdings<|>Levies</);
});

test('every public hand has all suit groups and only the entitled actor can interact', () => {
  const state = forcePhase(setUpMatch('public-hands'), PHASE.BUILD);
  for (const p of state.player_order) for (const suit of SUITS) giveResource(state, p, suit, p === PLAYER.WHITE ? 6 : 7);
  const modes = [];
  const html = tabletopRegionsHtml(state, {viewer: PLAYER.WHITE, canAct: true, resourceHtml: (card, mode) => { modes.push([card.face_value,mode]); return card.card_id; }});
  assert.equal(modes.length, 8);
  assert.ok(modes.filter(([v]) => v === 6).every(([,mode]) => mode === 'TAP'));
  assert.ok(modes.filter(([v]) => v === 7).every(([,mode]) => mode === 'NONE'));
  for (const suit of SUITS) assert.match(html, new RegExp(`aria-label="${suit.charAt(0)}${suit.slice(1).toLowerCase()} Resources"`));
  assert.equal((html.match(/id="tap-selected"/g) ?? []).length, 1);
  const spectator = tabletopRegionsHtml(state, {viewer:null,canAct:true});
  assert.doesNotMatch(spectator, /id="tap-selected"/);
});

test('Clover stays with the seated viewer while Siege follows the selected defender', () => {
  const state = forcePhase(setUpFourPlayerMatch('constants-four'), PHASE.SIEGE);
  addUnit(state, PLAYER.BLACK, UNIT_TYPE.PAWN, 'f7');
  addUnit(state, PLAYER.GREEN, UNIT_TYPE.PAWN, 'g2');
  addUnit(state, PLAYER.GREEN, UNIT_TYPE.PAWN, 'f2');
  assert.match(constantsHtml(state, PLAYER.GREEN), /♧ 6/);
  assert.match(constantsHtml(state, PLAYER.GREEN), /♤ ⌖/);
  const chosen = constantsHtml(state, PLAYER.GREEN, 'U-B-001');
  assert.match(chosen, /♤ 2/);
  assert.match(chosen, /Black · Defender/);
  assert.match(constantsHtml(state, null), /♧ 2/);
});

test('Hostage inspection identifies original owner and current legal prices', () => {
  const state = setUpMatch('hostage-inspection');
  const noble = state.nobles_by_id['NC-J-C'];
  state.decks.NOBLE = state.decks.NOBLE.filter(id => id !== noble.noble_id);
  state.players.BLACK.dungeon_noble_id = noble.noble_id;
  Object.assign(noble,{owner:PLAYER.WHITE,location:'BLACK_DUNGEON'});
  const html = nobleInspectionHtml(state,noble);
  assert.match(html, /COLBERT/);
  assert.match(html, /original owner White · held by Black/);
  assert.match(html, /Ransom: 3 ◇ · Execution: 4 ♡/);
  assert.equal(nobleInspectionHtml(state,{hidden:true}), '');
});
