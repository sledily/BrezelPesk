# Dendarv: Age of Crusader Kings — digital prototype

This repository is the V1.5 usability revision of the digital implementation of the two-player game described by the official V1.1 rulebook, plus the adopted four-player rules drafted for rulebook V1.2.

The current build is a dependency-free browser game. It supports selectable two- or four-player local hot-seat play and server-authoritative two- or four-player online rooms. The same engine command API drives local play, remote players, spectators, persistence, and replay.

The online service is branded **BrezelPesk**—“Warfish” in Breton—as an homage to the browser strategy site that inspired the project's remote-table ambitions. Dendarv remains the game title.

V1.5 puts the constants in the header and uses this reading order: board with tips and guide, current action, seasonal pool, a shared player comparison panel, then Chronicle. The comparison panel shows Resources, Holding icons, Levy icons with named Vassal cards, private Court cards or public counts, and Dungeons.

Harvest requires a separate click for every piece and uses the confirmed ordering for all four colors. Empty phases, Poker windows with no available hand, and Stockpiles with no required discard resolve automatically. Explanations appear one at a time when the affected player can act again. Automatic turn completion publishes actions and closes Undo. The Chronicle uses Rx/Dx/Vz and shows complete Harvest offers while concealing private Court identities.

**Deliberate digital rules exception:** when every remaining Resource card fits, all are retained automatically. Voluntary discards in that situation are unavailable.

See [V1.5_SPECIFICATION.md](V1.5_SPECIFICATION.md) for the complete adopted specification. Verification focuses on new v1.5 games, as requested.

## Run the game

The packaged release includes `Dendarv_Play.html` beside the source folder. Double-click that file for local hot-seat play: it is a self-contained build and does not require Node.js. Online play requires the Node server because the canonical match must live outside every player's browser.

To run the modular development build instead, use Node.js 20 or later. The project has no packages to install.

```bash
node server.mjs
```

Then open <http://127.0.0.1:4173>.

Use the **BrezelPesk** button to create a room. The host chooses a player count and color, then shares the generated room link. A recipient opens immediately as a spectator and may claim an open color before the match starts. Once every seat is occupied, the host starts the match.

For LAN testing, bind the server to all network interfaces and have other players open the host computer's LAN address:

```bash
DENDARV_HOST=0.0.0.0 node server.mjs
```

On Windows PowerShell, the equivalent is:

```powershell
$env:DENDARV_HOST="0.0.0.0"; node server.mjs
```

Internet play should use an HTTPS deployment or reverse proxy rather than exposing a home computer directly. Set `DENDARV_DATA_PATH` to a persistent disk location in production. By default, active rooms are saved atomically to `.dendarv-data/rooms.json` and survive a server restart.

`render.yaml` describes a free Render web service named `brezelpesk`. If that service name is available when deployed, Render will assign `https://brezelpesk.onrender.com`. The free service is appropriate for continuous live playtests, but its filesystem is ephemeral: paused rooms do not survive a free-instance sleep or redeploy.

Do not open `index.html` directly from the filesystem. Browsers restrict JavaScript module loading on `file://` pages; the small local server avoids that problem.

## Run the tests

```bash
node --test
```

The 72 automated checks cover the domain rules, transactions, exact replay of two- and four-player Years, all four Harvest orders, manual per-piece draws, Poker availability, automatic season passes, mandatory Stockpile interaction, online publication and Undo, Court privacy, and standalone UI startup and notice dismissal. The UI checks use a lightweight DOM host; browser rendering and a live deployment have not been verified in this revision.

## Implemented game systems

- deterministic setup and Black-then-White Sovereign selection;
- selectable four-player setup with Green-Black-Red-White Sovereign selection;
- doubled Resource and Noble card sets with stable copy identities;
- stable Unit identity, with Holding/Levy derived from Vassal assignment;
- fixed two- and four-player Harvest ordering, corner deck choice, Center and Vassal Counters;
- the adopted no-black-square Harvest failsafe;
- Poker Hands and mandatory-spend status;
- seasonal resource pools and multi-action spending;
- Build, Upgrade, Recruit, Mobilize, Siege, Combat, Vassalize, and Execute;
- Hostages, both Ransom buyers, proceeds, Quarter, No Quarter, and full-Dungeon execution;
- Stockpile allocation and end-of-Year button rotation;
- immediate two-player victory when either attacking or defending King is defeated;
- four-player elimination, Court and Resource transfer, Hostage resolution, destroyed Vassals, and the Sovereign-or-Queen Conquest choice;
- alternating annual direction, survivor-aware Button rotation, and last-King-standing victory;
- hot-seat privacy handoffs and redacted player projections;
- server-authoritative online rooms with short invitation codes;
- device-persistent guest names and reconnect tokens;
- atomic turn publication through explicit or automatic Pass: only the acting player sees unpublished actions;
- server-side confirmed Undo of any unpublished action, with deterministic random outcomes;
- midgame read-only spectators using the ordinary room link;
- durable active matches and private draft history across server restarts;
- browser autosave, JSON import/export, semantic event history, and deterministic command replay;
- confirmed, repeatable in-session Undo that restores the complete pre-command state;
- automatic unavailable-phase passes with explanations deferred until the next legal decision;
- pedagogical Resource filtering, ordering, and Stockpile recommendations;
- custom `Rx`/`Dx`/`Vz` titles and named Court cards, with compact suit badges on the board;
- a standard chronicle with historical Counter and position snapshots, private live views, and complete records after a published result.

## Deliberate boundaries of this build

This is an online alpha candidate, not yet a production deployment. It does not yet include:

- permanent user accounts, password recovery, or cross-device seat recovery;
- an AI opponent;
- production monitoring, backups, abuse controls, or a chosen public host/domain;
- a compact-notation importer (the exporter is implemented in V1.4);
- finished art, animation, sound, accessibility polish, or desktop packaging;
- event-only replay without invoking the deterministic command handlers.

The last item is worth distinguishing precisely: a match currently replays exactly from its seed plus command log. Every random result is also recorded in the semantic event log, but an event-only reducer remains a later persistence slice.

## Source layout

```text
src/constants.js     stable stored identifiers and ruleset defaults
src/model.js         canonical MatchState and card/Unit factories
src/rng.js           seeded, serializable random source
src/rules.js         pure derived values, legality helpers, and invariants
src/engine.js        transactional command handlers and phase machine
src/projection.js    redacted player and spectator views
src/persistence.js   save/load codec
src/rooms.js         authoritative online rooms, drafts, seats, and durable storage
src/online.js        browser API client and reconnect identity
src/notation.js      immutable standard chronicle entries, redaction and text export
src/format.js        player-facing card labels, Harvest previews and cost explanations
src/presentation.js  shared realm comparison, named cards, and numbered Harvest list
src/ui.js            local/online controllers and browser presentation
tests/               rules and integration tests
```

See [ARCHITECTURE.md](ARCHITECTURE.md) and [OPEN_DECISIONS.md](OPEN_DECISIONS.md) before changing gameplay behavior.
