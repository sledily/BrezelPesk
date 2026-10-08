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

The first load does not replay an old game history. If Quarter, Conquest or a King-defeat ending is already current, its latest saved comparison is restored statically. Legacy combat events without combatant snapshots use the available Unit/public Noble data; an original position or already removed General may be unavailable. A batch publication containing several battles presents the latest battle and labels that batch; all outcomes remain in the Chronicle. It does not make an absent viewer sit through a historical queue of eleven-second sequences.

## Routine cues and Current Action

Saved changes to visible Units and hand cards receive a brief 240 ms cue. Newly offered Harvest cards receive a 180 ms reveal. Selection, unmodified polls and ordinary rerenders do not replay reveal/Counter effects. Reduced motion suppresses these effects and smooth Stockpile scrolling.

Pass becomes prominent after an ordinary action when no legal affordable continuation remains; eligible Undo is retained until Pass. The Current Action line states Quarter, Conquest, resignation negotiation and terminal review directly. This introduces no new confirmations or rules.

## Verification and remaining visual work

The automated checks include authoritative arithmetic, recorded combatants after casualty cleanup, pending/terminal reconnect without replay, exact approved timer boundaries, skip/cancellation/reduced-motion paths, publication of private Siege only at Pass, duplicate polling, Undo sequence reuse, routine deltas, pre-impact board rendering, immutable saved outcomes and prominent Pass with Undo.

The complete standalone and server regression suite is also run. These are logic and simulated-DOM checks. Chromium installation was attempted again but the downloaded archive was truncated/invalid, so no fresh rendered animation, mobile/touch, contrast, focus traversal or real OS reduced-motion proof is available for this increment. Those remain release gates, along with visual comparison to the approved studies and fuller casualty/Conquest choreography. No live deployment is performed here.
