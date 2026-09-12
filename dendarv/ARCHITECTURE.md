# Architecture notes

## The authority boundary

The browser board is a view, never the game state. A UI action creates a command. `dispatch(state, command)` deep-clones the canonical state, validates and applies the command, checks invariants, and returns either a complete new state or a structured error with the original state untouched.

This keeps Human, AI, Replay, and later Network controllers on the same rules path.

## Unit identity

A Unit is not destroyed and recreated when it changes from Holding to Levy. The Unit keeps one stable ID while `vassal_noble_id` changes. Holding/Levy status is derived from that reference.

Upgrade also preserves Unit ID and Vassal assignment while changing `unit_type`. Combat defeat ends that Unit's history and returns its current physical piece type to reserve. A later Build creates a new Unit ID.

This avoids broken references, preserves a readable history, and makes replay and statistics substantially safer than replacing the Unit object whenever a card is attached.

## Randomness and replay

All shuffles and dice use one match-scoped xorshift32 state. The state is serialized. Semantic events record deck decisions, draws, rolls, totals, and outcomes.

The current replay path reconstructs the exact match from:

1. ruleset settings;
2. original seed;
3. ordered command log.

An event-only reducer is intentionally left as a separate persistence milestone. It should consume the already recorded random outcomes rather than call the random source.

## Hidden information

Canonical state contains every identity. `projectForPlayer` removes opponent Court identities, future deck order, and RNG state. Complete Harvest offers are public. Resource hands default to public under the current ruleset configuration.

Hot-seat privacy is a presentation measure rather than a security boundary. Online secrecy is enforced by keeping canonical state, RNG state, future deck order, seeds, and command logs on the server. Every player receives a seat-specific projection; spectators receive the most restrictive projection. Decks are represented only by counts, and concealed deck/Card records are not transmitted.

## Online rooms and publication boundaries

`RoomStore` owns the online authority boundary. A room contains a last committed canonical state and, while a player is acting, a private draft state plus an Undo history. A normal game command mutates only that draft. Its response is projected back to the acting seat; opponents and spectators continue polling the last committed state.

An explicit Pass or automatic turn completion is the publication transaction. After each command, the engine settles unavailable phases and compulsory bookkeeping. When that crosses a turn boundary, RoomStore immediately commits the result and clears the draft history. Otherwise the draft stays private and undoable. No later player may act until publication completes.

Undo restores the preceding unpublished canonical snapshot, including RNG state. Repeating a draw, shuffle, or die roll therefore reproduces the same result instead of allowing random-outcome fishing. Published turns cannot be undone.

Rooms use bearer-style device tokens stored in the player's browser. Only their hashes are written to the room store. This supplies same-browser reconnection for the alpha without coupling the game protocol to a future account system.

## Transaction and invariant model

No illegal command partially mutates the caller's state. After every accepted command, tests/debug execution checks at least:

- one live Unit per square;
- valid coordinates and Unit types;
- bidirectional Unit/Vassal references;
- valid Dungeon references and cap of one;
- nonnegative seasonal pools;
- exactly one location for every Resource Card.

New rules should add their invariant and a failing test before their handler is broadened.

## Unavailable phases and Undo

Phase availability includes structural legality and all eligible untapped Resources, not merely the current pool. `settleAutomaticPhases` advances every unavailable actor in phase order, performs seasonal cleanup, bypasses unavailable Poker declarations and retains an already-valid Stockpile. Affordable choices, unresolved Combat consequences and manual Harvest draws stop progression.

Automatic passes generate ordered canonical notices. The UI shows only the acting viewer's pending explanations at their next legal decision. Each dismissal is stored locally by match and player; it acknowledges an already-resolved step and does not advance the game. While notices are open, the game surface is inert. Both local and online Undo close at publication boundaries.

## Two- and four-player scheduling

`player_order` stores the seats in counterclockwise order. The phase machine derives each Year's actor order from the Button, the Year parity, and the surviving-player set. Two-player matches preserve the original Button-first order. Four-player matches run clockwise in odd Years and counterclockwise in even Years, while the Button itself always passes clockwise at Year end.

An eliminated Button holder remains the scheduling anchor until the Year ends. The actor-order derivation walks from that empty seat in the applicable direction and omits eliminated players.

## Four-player conquest

King defeat in a four-player match creates `pending_conquest` instead of completing the match. The engine first resolves the defeated Court, Resources, Hostages, Units, and Vassals, then waits for the victor's `CHOOSE_CONQUEST` command. The command either transfers the Sovereign to the victor's Court or establishes an irreplaceable captured Queen Holding.

The attacker does not change squares until this choice is resolved. This is necessary because taking the Card and taking the Holding produce different occupation results. The normal phase machine resumes only after the Conquest transaction is complete.
