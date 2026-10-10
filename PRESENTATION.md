# State-driven presentation

This increment implements the timing and mechanics of D81–D84 from the decision log, while preserving the Tabletop composition. It adds a local combat presentation and short visual cues to saved changes. Exact visual parity with the approved studies is not claimed without an actual browser review.

## Combat

The two player-coloured dice groups use the **already saved** CombatResolved rolls, highest dice, General bonuses and totals. Presentation never consumes RNG, rerolls a battle, changes a casualty, advances a turn or creates a gameplay acknowledgement. Public combatant snapshots now accompany the event so their original pieces, positions and assigned Nobles remain available after casualty cleanup or reconnect. These snapshots contain no unrevealed Court or recovery data.

The approved sequence is:

| Start | Beat |
| ---: | --- |
| 0.0 s | Combatants and Siege cost |
| 1.0 s | Simultaneous visible tumbling |
| 3.8 s | Settled raw dice |
| 5.4 s | Highest-die emphasis |
| 6.8 s | General rank and retained-die total reveal |
| 8.2 s | Result impact and winner/King-fall announcement |
| 8.7 s | Result hold |
| 11.1 s | Ordinary combat comparison retained beside the next decision |
| 11.9 s | King-defeat comparison after the longer fall/result interval |

The presentation board retains the recorded combatants before impact and returns to the current authoritative position at impact. The underlying game has already resolved; file exports and the service always use that authoritative state. Quarter, Conquest and final victory use their existing engine transitions. Final victory has no fabricated spoils or Conquest choice. A compact comparison stays available during the required consequence and can be dismissed with Return to board.

Show result now bypasses only the local sequence. During it, local gameplay controls are inert and command handlers reject additional local submissions. It never delays another device's server-side play. On a shared device, a required actor handover follows the local presentation and still clears private inspections through the existing handover screen. A background tab finishes its presentation immediately.

`prefers-reduced-motion: reduce` displays the final comparison immediately, with no tumbling, pulsing, shaking, falling motion or artificial eleven-second wait. Changing that preference during a sequence finishes it. Skipping from the keyboard returns focus to the action area. Sound is not added; its production defaults remain undecided.

## Publication and catch-up

Each tracker reads only the currently supplied state projection. A player's private Siege appears for that player when saved; opponents/spectators receive it only at the agreed publication boundary. Repeated polls and retries do not replay the same outcome. Undo event-sequence reuse cannot suppress a new battle. Room/seat/role changes clear the previous presentation context.

Fresh local setup does not replay an old game history. The reconnect recap below supersedes the earlier baseline-suppression policy for returning participants. If Quarter, Conquest or a King-defeat ending is already current, its latest saved comparison is restored statically. Legacy combat events without combatant snapshots use the available Unit/public Noble data; an original position or already removed General may be unavailable. A batch publication containing several battles presents the latest battle and labels that batch; all outcomes remain in the Chronicle. It does not make an absent viewer sit through a historical queue of eleven-second sequences.

## Routine cues and Current Action

Saved changes to visible Units and hand cards travel from their previous visible positions over 650 ms. Newly offered Harvest cards are dealt with a staggered 420 ms reveal. A newly earned Counter is placed after the card arrives; tapping rotates the physical card and the teaching caption explains the recorded pool value. Selection, unmodified polls and ordinary rerenders do not replay reveal/Counter effects. Reduced motion suppresses these effects and smooth Stockpile scrolling.

Pass becomes prominent after an ordinary action when no legal affordable continuation remains; eligible Undo is retained until Pass. The Current Action line states Quarter, Conquest, resignation negotiation and terminal review directly. This introduces no new confirmations or rules.

## Verification and remaining visual work

The automated checks include authoritative arithmetic, recorded combatants after casualty cleanup, pending/terminal reconnect without replay, exact approved timer boundaries, skip/cancellation/reduced-motion paths, publication of private Siege only at Pass, duplicate polling, Undo sequence reuse, routine deltas, pre-impact board rendering, immutable saved outcomes and prominent Pass with Undo.

The complete standalone and server regression suite is also run. These are logic and simulated-DOM checks. Chromium installation was attempted again but the downloaded archive was truncated/invalid, so no fresh rendered animation, mobile/touch, contrast, focus traversal or real OS reduced-motion proof is available for this increment. Those remain release gates, along with visual comparison to the approved studies and fuller casualty/Conquest choreography. No live deployment is performed here.
## Court illustrations

The twelve user-supplied illustrations are mapped by Noble rank and suit in
`src/court-art.js`. The assets use the original uploaded JPEG bytes (the upload filenames ended
in `.png`), with no recompression, cropping, or pixel changes at 1024 × 1536. Ordinary Noble labels remain Rank and Suit icons, without
thumbnails. A freshly drawn private Noble, a freshly played public Noble, or
an explicit inspection shows the complete double-ended card without cropping
or added lettering. Reconnects do not replay old draws/plays. Court cards remain face-down,
including the owner's own Court,
until privately inspected. The standalone build embeds all twelve assets for
offline use, increasing the file to about 13 MiB. The hosted build loads the
separate images only where rendered. These artwork files do not enter game
saves, storage reservations, or archives.

In shared-device play, a played Sovereign's artwork remains open until dismissed;
the next player's Ready handover then covers the private view as usual.


## Returning to the table

A returning online participant automatically receives a chronological animated recap of the published actions since their last completed personal opportunity. The anchor is derived from the authenticated projection's saved event log, so refresh, seat recovery and another device do not require a browser-local read cursor. Manual Pass, completed personal Harvest/Poker, setup choice, manual Stockpile and Ransom decisions are recognised; automatically skipped opportunities and queued Stockpile resolution do not erase missed history. New event metadata distinguishes automatic and deliberate completion, with conservative handling for older records.

The recap includes every recorded intervening movement and battle, with separate explanations of funding, Harvest choices, Counters, declarations, assignment, casualties, Quarter, Conquest, passes, cleanup and phase changes. Battle playback uses the saved combatant snapshots, dice and arithmetic. A later unrelated terminal result cannot make an earlier battle appear to end the game. Additional published events append once during playback. The board behind the recap stays at the current authoritative position; individual action cards illustrate the historical changes and name their coordinates.

The player can pause, go back, advance, or skip to the current board. Playback never dispatches a command, consumes RNG, writes a game save or acknowledges a gameplay opportunity. Current gameplay is locally guarded while the recap is open; other devices are unaffected. Reduced motion presents every explanation statically without an automatic wait. Backgrounding pauses rather than discarding the queue. Reconnecting with an unchanged revision still offers the recap. Spectators have no private participant recap. Hidden recruitment is described using only the public Chronicle wording; private planning and unrevealed Court identities stay excluded.

The same **Since my last turn** control is available during local and online play. An autosave resumed on a shared device starts its recap only after Ready establishes the incoming player's private view.

## Court-inspired visual language

Warm paper, dark printed outlines, olive foliage, crimson geometry, blue thorns and gold stems extend the supplied Court artwork onto the existing Tabletop composition. Resource cards remain legible; ordinary Noble markers remain rank and suit, with the complete original illustrations confined to draw, play, inspection and those explicit recap events. The artwork bytes are unchanged. No additional raster assets or external fonts are required.

Phase, season, Year and personal Harvest-to-Poker arrivals receive a framed suit cue naming the destination, the acting player and its rules. Year arrival includes the recorded Button and action order. Cues wait behind Court reveals, shared-device handover, combat and required automatic explanations; they add no confirmation. A completed recap also orients the player to the current decision.

`tests/recap.test.js` and the standalone interaction checks cover queue completeness, personal anchors, automatic skips, hidden recruitment and Court spoils, all recorded battles, later terminal events, pause/back/skip, static reduced motion and append deduplication. `scripts/browser-presentation.mjs` checks the actual modular and generated interfaces, native setup/reveal/handover, refresh recap, rendered dice motion/arithmetic, local playback controls, native reduced motion and touch landscape bounds. It runs in the separate browser CI job and retains screenshots. Visual tuning remains subject to playtest feedback; this is not a claim of final artistic parity.
