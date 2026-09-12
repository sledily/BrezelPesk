import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DECK, PLAYER } from "../src/constants.js";
import { RoomError, RoomStore } from "../src/rooms.js";

function createTwoPlayerRoom(options = {}) {
  const store = new RoomStore({ codeFactory: () => "ABC123", ...options });
  const host = store.create({ playerCount: 2, playerName: "White Player", seat: PLAYER.WHITE, seed: "online-room" });
  const black = store.join(host.code, { playerName: "Black Player", seat: PLAYER.BLACK });
  store.start(host.code, host.token);
  return { store, host, black };
}

test("rooms support seats, an unlisted spectator view, and host-controlled start", () => {
  const { store, host, black } = createTwoPlayerRoom();
  const lobby = host.view.room;
  assert.equal(lobby.code, "ABC123");
  assert.equal(lobby.player_count, 2);
  assert.equal(black.seat, PLAYER.BLACK);

  const spectator = store.view(host.code, null, "watcher-one");
  assert.equal(spectator.viewer.role, "SPECTATOR");
  assert.equal(spectator.room.spectator_count, 1);
  assert.equal(spectator.game.seed, undefined);
  assert.equal(spectator.game.rng_state, undefined);
  assert.equal(spectator.game.command_log, undefined);
  const created = spectator.game.event_log.find((event) => event.type === "MatchCreated");
  assert.deepEqual(created.payload, { player_count: 2 });
  assert.equal(Array.isArray(spectator.game.decks[DECK.BLACK]), true);
  assert.equal(spectator.game.decks[DECK.BLACK].length, 20);
  assert.equal(spectator.game.decks[DECK.BLACK].every((card) => card === null), true);
  assert.equal(Object.values(spectator.game.nobles_by_id).some((card) => card.location === "NOBLE_DECK"), false);
  assert.equal(Object.values(spectator.game.resources_by_id).some((card) => card.location === "BLACK_DECK" || card.location === "RED_DECK"), false);
});

function finishRoomSetup(store, host, black) {
  store.command(host.code, black.token, { type: "CHOOSE_SOVEREIGN", noble_id: "NC-K-S" });
  store.command(host.code, host.token, { type: "CHOOSE_SOVEREIGN", noble_id: "NC-K-H" });
}

test("a completed Sovereign choice publishes automatically and closes Undo", () => {
  const { store, host, black } = createTwoPlayerRoom();
  const committed = store.command(host.code, black.token, { type: "CHOOSE_SOVEREIGN", noble_id: "NC-K-S" });
  assert.equal(committed.viewer.waiting_for_pass, false);
  assert.equal(committed.viewer.can_undo, false);
  assert.equal(store.view(host.code, host.token).game.current_actor, PLAYER.WHITE);
  assert.equal(store.view(host.code, null, "watcher").game.units_by_id["U-B-001"].vassal_noble_id, "NC-K-S");
  assert.throws(() => store.undo(host.code, black.token), (error) => error.code === "NOTHING_TO_UNDO");
  assert.throws(() => store.command(host.code, black.token, { type: "CHOOSE_SOVEREIGN", noble_id: "NC-K-H" }), (error) => error.code === "NOT_YOUR_TURN");
});

test("final setup publishes when the next phase has the same actor", () => {
  const { store, host, black } = createTwoPlayerRoom();
  finishRoomSetup(store, host, black);
  const view = store.view(host.code, host.token);
  assert.equal(view.game.status, "ACTIVE");
  assert.equal(view.game.current_actor, PLAYER.WHITE);
  assert.equal(view.viewer.waiting_for_pass, false);
  assert.equal(view.viewer.can_undo, false);
  assert.equal(store.view(host.code, null, "watcher").game.status, "ACTIVE");
});

test("Undo restores an unpublished Harvest offer without rerolling", () => {
  const { store, host, black } = createTwoPlayerRoom();
  finishRoomSetup(store, host, black);
  const command = { type: "DRAW_HARVEST", unit_id: "U-W-001", deck: DECK.BLACK };
  const before = store.view(host.code, null, "watcher").game;
  const first = store.command(host.code, host.token, command);
  assert.equal(first.viewer.can_undo, true);
  assert.deepEqual(store.view(host.code, null, "watcher").game, before, "an unresolved offer is still in the unpublished turn");
  store.undo(host.code, host.token);
  const second = store.command(host.code, host.token, command);
  assert.deepEqual(second.game.harvest.offer_ids, first.game.harvest.offer_ids);
  const kept = second.game.harvest.offer_ids[0];
  store.command(host.code, host.token, { type: "KEEP_HARVEST_CARD", card_id: kept });
  const publicView = store.view(host.code, black.token);
  assert.equal(publicView.game.current_actor, PLAYER.BLACK);
  const entry = publicView.game.event_log.find((event) => event.type === "HarvestCardKept").payload.chronicle;
  assert.doesNotMatch(entry.text, /\?\?/);
  assert.equal(store.view(host.code, host.token).viewer.can_undo, false);
});

test("active rooms and unpublished Harvest Undo history survive restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "dendarv-rooms-"));
  const filePath = join(directory, "rooms.json");
  const { store, host, black } = createTwoPlayerRoom({ filePath });
  finishRoomSetup(store, host, black);
  const first = store.command(host.code, host.token, { type: "DRAW_HARVEST", unit_id: "U-W-001", deck: DECK.RED });
  const restored = new RoomStore({ filePath });
  const view = restored.view(host.code, host.token);
  assert.equal(view.viewer.can_undo, true);
  assert.equal(view.viewer.waiting_for_pass, false);
  assert.deepEqual(view.game.harvest.offer_ids, first.game.harvest.offer_ids);
  assert.deepEqual(restored.undo(host.code, host.token).game.harvest.offer_ids, []);
});
