# Rules decisions and implementation defaults

This register prevents provisional software behavior from quietly becoming a tabletop rule.

## Post-document rulings included

- Resource Cards are public; Court hands and undrawn decks remain hidden.
- Harvest resolves one Unit's full draw/keep decision before the next Unit draws.
- If a player has no Units on black squares at Harvest, that player may sacrifice the entire normal Harvest to draw one Black Resource Card, which must be kept.
- In v1.5, a legal whole hand is automatically retained at Stockpile. The loss of voluntary discards is an explicitly accepted digital rules exception.
- The button passes only after Stockpile/Discard at the end of the Year.
- Resource Cards cannot be tapped merely to cycle them when no substantive action is available.
- Unavailable phases advance automatically; their explanations are presented one at a time at the affected player’s next legal decision. Automatic completion publishes the turn and ends Undo.

## Current configurable or isolated defaults

| Question | Current build behavior |
| --- | --- |
| Physical chess-piece supply binding? | Yes; standard reserve profile. |
| Starting corners? | White `a1`, Black `h8`. Both are dark squares. |
| Scheduling within each phase? | Every surviving player completes any number of actions and passes in the current Year's Button-derived order. |
| Harvest order? | Holdings, then Levies; ascending Level; W: h→a then 8→1; G: 8→1 then a→h; B: 1→8 then a→h; R: h→a then 1→8. Every piece requires its own click. |
| Rejected Harvest cards? | Return and shuffle immediately after that Unit's choice. |
| Poker overlap? | One card may participate in multiple declarations; Counter still caps at one. |
| Purposeless card cycling? | Rejected; unavailable phases are announced and automatically passed. |
| Levy Upgrade? | The Unit keeps its assigned Vassal. |
| Resource hands? | Public. |
| Online identities? | Device-persistent guest name and secret reconnect token for the alpha; permanent accounts remain a later deployment layer. |
| Online publication? | The active player works privately while choices remain. Explicit or automatic Pass publishes the turn and locks Undo. |
| Spectators? | Enabled by the normal room link, read-only, and limited to committed public information. |

Each of these behaviors is isolated in rules settings or a dedicated rules function so a ruling need not rewrite the interface.

## Still unresolved

1. What happens if a Resource Deck cannot supply a Unit's full Harvest draw count? The engine currently rejects the draw as `DECK_EXHAUSTED` rather than inventing a remedy.
2. The 5 September 2026 notation reference resolves two-player Poker declarations, Turn 0 / Year headers and Stockpile. Four-player Harvest ordering is now settled in V1.5_SPECIFICATION.md; a definitive conquest notation remains unspecified, so four-player extensions remain labeled.
3. Event-only replay policy and migration rules remain to be completed; the current exact replay uses seed plus commands.
4. The Ring bonus remains outside this ruleset. The adopted four-player rules are implemented in V1.3.
5. Permanent account provider, public hosting platform, domain, retention policy, backups, and operational moderation remain deployment decisions.
