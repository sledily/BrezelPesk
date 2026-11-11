// Reproducible storage workloads, not a game-playing feature or strategy model.
import { createHash } from 'node:crypto';
import { PersistentRooms } from '../src/persistent-rooms.js';
import { allocatedBytes, defaultLimits } from '../src/room-storage.js';
import { phaseAvailability } from '../src/engine.js';
import { currentSuit, deckForSquare, isCorner, effectiveCardValue, validateInvariants } from '../src/rules.js';

const bytes = value => Buffer.byteLength(JSON.stringify(value));
const digest = value => createHash('sha256').update(value).digest('hex');
const fixedNow = () => new Date('2026-09-30T12:00:00.000Z');

export class MeasuringStorage {
  constructor() { this.rooms = new Map(); this.peakBytes = 0; this.peakUndo = 0; this.writes = 0; }
  async read(code) { return this.rooms.get(code) ?? null; }
  async transact(code, fn) {
    const change = await fn(await this.read(code));
    if (change.write) {
      this.rooms.set(code, change.write);
      this.peakBytes = Math.max(this.peakBytes, bytes(change.write));
      this.peakUndo = Math.max(this.peakUndo, change.write.room.draft_history.length);
      this.writes++;
    }
    return change.result;
  }
  async pendingArchives() { return [...this.rooms].filter(([,d]) => d.archive?.status === 'pending').map(([code]) => ({code})); }
}

function nextCommand(state, busy) {
  if (state.status === 'SETUP') return {type:'CHOOSE_SOVEREIGN',noble_id:state.sovereign_pool_ids[0]};
  if (state.harvest?.stage === 'DRAW') {
    if (state.harvest.failsafe_pending) return {type:'RESOLVE_HARVEST_FAILSAFE',use:true};
    if (state.harvest.offer_ids.length) {
      const ids = [...state.harvest.offer_ids].sort((a,b) => effectiveCardValue(state.resources_by_id[b])-effectiveCardValue(state.resources_by_id[a]));
      return {type:'KEEP_HARVEST_CARD',card_id:ids[0]};
    }
    const unit = state.units_by_id[state.harvest.remaining_unit_ids[0]];
    const deck = isCorner(unit.square) ? (busy && state.year_number%2===0?'RED':'BLACK') : deckForSquare(unit.square);
    return {type:'DRAW_HARVEST',unit_id:unit.unit_id,deck};
  }
  if (state.harvest?.stage === 'POKER') return {type:'FINISH_POKER'};
  if (state.phase === 'STOCKPILE') return {type:'CHOOSE_STOCKPILE',card_ids:[]};
  if (state.phase === 'RANSOM') return {type:'RESPOND_RANSOM',pay:false};
  if (busy && ['BUILD','UPGRADE','RECRUIT','VASSALIZE'].includes(state.phase)) {
    const candidate = phaseAvailability(state).affordable[0];
    if (candidate) {
      const player = state.players[state.current_actor], suit = currentSuit(state);
      if (player.seasonal_pools[suit] < candidate.cost) {
        return {type:'TAP_RESOURCES',card_ids:player.resource_hand_ids.filter(id => state.resources_by_id[id].suit===suit && !state.resources_by_id[id].tapped)};
      }
      const {action,cost,...selection} = candidate;
      return {type:{BUILD:'BUILD_UNIT',UPGRADE:'UPGRADE_UNIT',RECRUIT:'RECRUIT_NOBLE',VASSALIZE:'VASSALIZE_NOBLE'}[action],...selection};
    }
  }
  return null; // Explicit ordinary Pass. Combat is deliberately absent from this workload.
}

export async function runStorageScenario({playerCount=2,years=20,busy=true}={}) {
  const storage = new MeasuringStorage(), service = new PersistentRooms(storage,{now:fixedNow});
  let sequence = 0;
  const id = () => digest(`request-${sequence++}`);
  const credential = seat => ({token:digest(`seat-${seat}`),recoveryCode:digest(`recovery-${seat}`)});
  const host = await service.mutate('create',null,null,{playerCount,playerName:'Storage White',seat:'WHITE',credentials:credential('WHITE')},id());
  // Deterministic synthetic fixture only; public online create never accepts a player-selected seed.
  (await storage.read(host.code)).room.seed = `storage-${playerCount}-${busy}`;
  const seats = (await storage.read(host.code)).room.seat_order;
  const tokens = {WHITE:host.token};
  for (const seat of seats.filter(s=>s!=='WHITE')) {
    tokens[seat] = (await service.mutate('join',host.code,null,{seat,playerName:`Storage ${seat}`,credentials:credential(seat)},id())).token;
  }
  async function mutate(action,seat,body={}) {
    const view = await service.view(host.code,tokens[seat]);
    return service.mutate(action,host.code,tokens[seat],{...body,expectedRevision:view.viewer.private_revision},id());
  }
  await mutate('start','WHITE');
  let state;
  for (let step=0;step<10000;step++) {
    const room = (await storage.read(host.code)).room;
    state = room.draft_state ?? room.committed_state;
    if (state.year_number > years) break;
    const command = nextCommand(state,busy);
    await mutate(command?'command':'pass',state.current_actor,command?{command}:{});
    if (step===9999) throw new Error('Storage workload failed to advance');
  }
  if (validateInvariants(state).length) throw new Error('Invalid storage workload');
  const active = structuredClone(await storage.read(host.code));
  const result = {
    player_count:playerCount, completed_years:years, workload:busy?'economy-build-recruit-vassalize':'quiet-harvest-pass',
    commands:state.command_log.length,events:state.event_log.length,units:Object.keys(state.units_by_id).length,
    active_bytes:bytes(active),peak_live_bytes:storage.peakBytes,max_undo_snapshots:storage.peakUndo,
    history_bytes:bytes(state.event_log)+bytes(state.command_log),receipts_bytes:bytes(active.receipts),
  };
  await mutate('abandon','WHITE',{confirmed:true});
  result.pending_archive_bytes = bytes(await storage.read(host.code));
  await service.processArchives();
  const terminal = await storage.read(host.code);
  result.ready_archive_bytes = bytes(terminal);
  result.active_allocation_bytes = allocatedBytes(active,defaultLimits);
  result.terminal_allocation_bytes = allocatedBytes(terminal,defaultLimits);
  return {result,active,terminal};
}
