import { RoomStore, cloneForStorage } from '../src/rooms.js';
import { PHASE, SUIT } from '../src/constants.js';
import { actionCost } from '../src/rules.js';

// Reach a real, replayable mid-game position without editing pieces, pools or logs.
export function publishedUndoFixture(playerCount = 2, { publish = true, phase = PHASE.MOBILIZE, code = 'ABC234' } = {}) {
  const core = new RoomStore({ codeFactory: () => code });
  const host = core.create({ playerCount, playerName: 'White', seat: 'WHITE', seed: 'published-undo-existing-save' });
  const players = { WHITE: host };
  for (const seat of playerCount === 4 ? ['GREEN', 'BLACK', 'RED'] : ['BLACK']) {
    players[seat] = core.join(host.code, { playerName: seat, seat });
  }
  core.start(host.code, host.token);
  const room = () => core.get(host.code);
  const state = () => room().draft_state ?? room().committed_state;
  const command = (actor, value) => core.command(host.code, players[actor].token, value);
  while (state().status === 'SETUP') {
    const actor = state().current_actor;
    const noble = state().sovereign_pool_ids.map(id => state().nobles_by_id[id])
      .find(card => actor === 'WHITE' ? card.suit === SUIT.SPADES : card.suit !== SUIT.SPADES);
    command(actor, { type: 'CHOOSE_SOVEREIGN', noble_id: noble.noble_id });
  }
  for (let step = 0; step < 1000; step += 1) {
    const current = state(), actor = current.current_actor;
    const suit = phase === PHASE.RECRUIT ? SUIT.DIAMONDS : SUIT.SPADES;
    if (current.phase === phase && actor === 'WHITE' && !current.phase_notice) {
      const cards = current.players.WHITE.resource_hand_ids.map(id => current.resources_by_id[id])
        .filter(card => card.suit === suit && !card.tapped);
      const cost = phase === PHASE.RECRUIT ? actionCost(current, 'RECRUIT', { actor }) : 4;
      if (cards.reduce((sum, card) => sum + card.face_value + Number(card.has_counter), 0) >= cost) {
        const beforeTap = structuredClone(room().committed_state);
        command(actor, { type: 'TAP_RESOURCES', card_ids: cards.map(card => card.card_id) });
        const beforeMove = structuredClone(state());
        command(actor, phase === PHASE.RECRUIT ? { type: 'RECRUIT_NOBLE' }
          : { type: 'MOBILIZE_UNIT', unit_id: 'U-W-001', destination: 'c3' });
        const beforePass = structuredClone(state());
        const unpublished = cloneForStorage(room());
        if (publish) core.pass(host.code, host.token);
        return { core, host, players, beforeTap, beforeMove, beforePass, unpublished };
      }
    }
    if (current.phase === PHASE.HARVEST && !current.phase_notice) {
      const h = current.harvest;
      if (h.stage === 'POKER') command(actor, { type: 'FINISH_POKER' });
      else if (h.offer_ids.length) {
        const best = h.offer_ids.map(id => current.resources_by_id[id])
          .sort((a, b) => Number(b.suit === suit) - Number(a.suit === suit) || b.face_value - a.face_value)[0];
        command(actor, { type: 'KEEP_HARVEST_CARD', card_id: best.card_id, auto_harvest: true });
      } else command(actor, { type: 'DRAW_HARVEST', unit_id: h.remaining_unit_ids[0], deck: actor === 'WHITE' && phase === PHASE.RECRUIT ? 'RED' : 'BLACK', auto_harvest: true });
    } else if (current.phase === PHASE.STOCKPILE && !current.phase_notice) {
      command(actor, { type: 'CHOOSE_STOCKPILE', card_ids: [] });
    } else core.pass(host.code, players[actor].token);
  }
  throw new Error('The deterministic fixture did not reach Mobilization');
}
