# V2 foundation — review checkpoint, 30 September 2026

The user authorized first-stage implementation after the section 15.8 handoff. This branch starts at `47097e689eb83c8e2b27185671addb11961788b4`, the verified repository-root source. Main and the existing Render service are unchanged.

## Implemented

- One canonical root application and explicit public asset allowlist.
- PostgreSQL per-room transactions and a durable single-process development file adapter. Request receipts and state commit together; response loss is reconciled using the same request identity.
- Preserved private drafts, RNG, pending Harvest/Quarter decisions, reversible Undo and explicit ordinary-action Pass. Defender Quarter handoff and final responses publish automatically. Stale revisions remain invalid after Undo.
- Browser-persisted pending requests, stable private recovery codes, one controlling session and exceptional administrator credential rotation.
- Participant-only private terminal views/exports, public spectators, 30-day ordinary terminal access, terminal Abandonment, separate administrator audit, durable pending archives and independent retries.
- Configurable stored-room count, logical-byte budget, unfinished-game reservations and physical database size guard. Completed/Abandoned rooms count toward capacity. No eviction or paid upgrade.
- Conditional browser responses, hidden-tab pause and 3–20 second idle polling backoff (up to 30 seconds on failures). PostgreSQL checks a lightweight internal row version before reusing cached data, including after another process revokes a session. Private database versions never become public room revisions.
- Protected administrator API and a PostgreSQL 17 CI job. No administrator GUI yet.

The room record contains committed/draft state, receipts, archive and audit in one transactional JSON document. Archive and audit have separate access rules, though they are not separate SQL tables. Only the changed room is written. The small initial workload uses one database capacity-row lock to serialize writes and admission.

## Verification evidence

Local validation: **95 tests pass**, including SQL execution and full database restoration with embedded PostgreSQL/PGlite. The focused suite injects pre-commit failure and loss of a successful commit acknowledgement, retries after restart, checks capacity races, verifies takeover with cached views, preserves both Quarter branches, and rejects stale requests after Undo. Multi-step compact Undo restores exact states/logs after restart; older full snapshots remain readable. HTTP tests cover private-path exclusion and administrator cookie/CSRF enforcement. The generated standalone passes the existing lightweight DOM startup checks.

The initial 84-test increment passed PostgreSQL 17 CI. The extended GitHub workflow also adds native `pg_dump`/`pg_restore` into an empty test database after removing its test-owned source database; review the latest CI result for this increment. The first Tabletop pass has browser evidence below; a production-provider connection, provider-managed recovery and production deployment remain unverified.

Four 20-year storage workloads now document concrete raw record sizes. Compact Undo lowers the busy four-player live peak from 3,820,349 to 2,225,602 bytes (about 42%); its ready archive is 3,000,840 bytes. D91 approves five stored games as the initial count cap. The 64 MiB logical budget and 8 MiB reserved per unfinished/pending-archive room remain provisional byte limits. Reservations are released only when the archive is ready. See [STORAGE_AND_RECOVERY.md](STORAGE_AND_RECOVERY.md).

## Remaining release gates

1. Select and configure a free database. Verify its current quota and retention/recovery terms; extend the current measurements to combat/future V2 states and physical database overhead against the accepted five-game cap. The byte-budget/reservation settings remain provisional and can pause writes if games outgrow their reserved space.
2. Repeat the automated full-database restore exercise with the chosen provider and define backup frequency/recovery-point expectations. The local/CI tests include credentials/verifiers, receipts, private Undo, pending records, audit and capacity metadata; participant game exports are not service backups.
3. Reconcile the actual Render dashboard build/start/health configuration with the repository configuration. Production requires `DATABASE_URL`; no configuration or provider account was changed. Main auto-deploys, so review is required before merge.
4. Implement and verify the remaining V2 mechanics and lifecycle states: resignation ballots/deadline reconciliation, notifications and any required independent wake-up mechanism. This foundation preserves stored state but does not claim tests for those not-yet-implemented state machines.
5. Complete Tabletop interaction parity (Harvest/Poker/Stockpile choreography, comprehensive contextual pedagogy, routine motion), dramatic dice/King treatment, full touch/reduced-motion accessibility and the direct terminal full-record screen. Finish administrator GUI, archive ZIP/download/delete and operational failure visibility.

This is the first reviewable foundation increment, not a declaration that every section 15.8 acceptance case or V2 as a whole is complete. No legacy game migration, main merge, production publication or paid provisioning is part of this change.

## First working Tabletop pass — D91

On 30 September the user accepted five stored games and asked to resume; this continues the approved interface work on the draft review branch. No database provider or deployment is selected by that decision.

The working interface now places the fixed board among two opposing or four corner regions, suit-grouped public Resource hands, face-down Courts, permanent Dungeon slots and actual reserve-piece illustrations. Current Action has a pinned concise rubric with phase controls below it; constants sit below the board. Code-native chess illustrations, blue centre squares, miniature checkerboard corners and captured-piece controller banners share the manuscript/paper treatment. The D32 Noble-name mapping is corrected throughout new state and displayed cards.

Private Court inspection requires the entitled seat and closes/clears on handover or view replacement. Public Units, Vassals and Hostages can be inspected separately. Build, movement and Siege have select/preview/commit, including action-first funding and Siege confirmation. Resource double-click taps one physical card exactly once; a button remains available for keyboard/touch use. New local games use explicit ordinary-action Pass. No new randomness is introduced by presentation.

Verification: 95 automated tests pass. Chromium checks exercised a synthetic four-player table with 12 Resources per player at 1440×1100, 1024×900, 844×480, 640×360 and 390×844, with no horizontal page or hand overflow. Browser interactions verified owner-only Court inspection and Escape clearing, one double-click tap, Build preview/funding/commit/Undo, and two-player touch Siege selection/cancellation with defender constants. No browser JavaScript errors occurred. These checks cover this increment, not comprehensive accessibility or every lifecycle state.

The original approved HTML studies were not returned by reference retrieval. This increment follows the current recorded specification; exact visual parity with those studies is not asserted. Cinematic combat, Harvest offers beside Units, full Poker/Stockpile presentation, remaining lifecycle UI and provider release gates remain open. The existing rule controls are still used for those unfinished flows.


## Harvest, Poker and Stockpile checkpoint — 6 October 2026

Resumed the unfinished local increment on the existing review branch. New local and online V2 games now use each player's Harvest followed immediately by their own Poker window. Earlier rejected cards wait outside the deck until personal Harvest completion; emergency recycling exhausts the original deck first. Short offers contain only real cards, single cards are kept automatically, and empty offers are recorded explicitly.

Poker distinguishes proposals from legality: all-countered hands are not suggested but remain manually declarable in an open window. Physical cards cannot overlap between retained declarations in a Year. After a declaration, explicit Pass preserves Undo; drawing and keeping do not become reversible. The Chronicle records personal Harvest/Poker chronology.

Stockpile defaults to Manual, accepts exact private queued selections including none, and validates them again at normal Year-end timing. Explicit Auto opt-in uses suit priorities, effective/printed-value tie handling and physical-card overrides. A one-Year Manual override preserves the standing Auto policy. Waiting players can save instructions without publishing the active player's draft; latest instructions survive gameplay Undo, durable restart and seat takeover. Returns and shuffles occur only at the normal Stockpile boundary.

The Tabletop interface adds offers beside the harvesting Unit, progress markers, Counter explanations, exact Poker candidates, and a Stockpile panel in the owner's Resource area. Harvest selection has explicit Cancel and Escape cancellation; handover clears it. Supply-shortage messages report the actual shortage. Original HTML studies are now available and their source has been consulted, superseding the earlier retrieval limitation; full visual parity remains unverified.

Validation at this checkpoint: **108 automated tests pass locally**, including PGlite database tests and the generated standalone UI host. New checks cover deck shortages/physical-card invariants, personal publication boundaries, non-overlapping Poker, exact replay, private Stockpile planning, lost-save rollback, restart, takeover, multiple Undo and handover/cancellation. These UI checks use a simulated DOM. A fresh Chromium layout/touch run could not be performed: no browser executable was available and the installation download was invalid. Earlier Tabletop browser evidence does not validate these newly added screens.

Remaining: actual browser/touch/reduced-motion verification of the resource screens, routine animation polish, cinematic combat/King treatment, other lifecycle/admin screens and the existing provider/release gates. This checkpoint does not merge main, deploy, provision a provider or select a paid service.

## Returning to online games — 6 October 2026

Added browser-specific Your Active Games, with public game name/code, nicknames and colors, published Year/phase, turn status and Resume. Successful creation, joining and recovery remember the match on that browser. Existing remembered seat credentials can rebuild a missing/corrupt convenience index. The page explains that clearing site data or changing browser does not delete the server game, and distinguishes the room code from the private recovery code. Terminal matches are separated as read-only entries; stale credentials offer public viewing or seat recovery, and network/expiry failures retain the remembered entry with an explanation.

List refresh uses a small public-summary endpoint rather than sending full private views or replaying pending commands. It does not claim a seat or announce browser presence. Cached convenience records exclude credentials, Courts, private revisions and game state. Browser storage denial prevents sending a new mutation whose retry identity cannot be saved.

Every new room receives a generated two-word name. The host can rename a lobby or active match; room/invitation/recovery identifiers remain fixed. Renaming publishes only metadata and preserves private drafts, Undo, RNG and gameplay histories. It uses durable request receipts and survives a lost acknowledgement and restart. Non-hosts and terminal matches cannot rename.

Validation: **115 tests pass locally**, including real HTTP checks for name updates/public summaries, browser-client tests for multiple games, recovery/takeover, offline/expired access, corrupt or blocked browser storage, and a simulated-DOM escaping/read-only-list check. A durable test verifies metadata-only publication and retry/restart during an unpublished action. Generated standalone updated. Actual browser layout/touch checks remain blocked by the previously recorded missing Chromium executable/download failure.

Next online increment: three seating modes, host seating controls and confirmed lobby cancellation/leave behavior. Notifications, remaining terminal/admin screens and the earlier release gates remain open. No merge, deployment or provider change is included.


## Pregame seating and lobby lifecycle — 7 October 2026

Implemented Free choice, Host chooses and Random for two- and four-player rooms. Free choice uses open colour selection and explicit host Start. Host chooses provisionally assigns joiners to available colours and lets the host assign or swap participants before explicit Start. Random shows names without colour selection or a Start control, assigns all participants (including the host) when the final person joins, and starts atomically without the host being online. Sovereign selection follows Start. Participant identities and recovery credentials follow assignments; host identity never transfers. Older room records default to Free choice and receive stable participant identities.

Hosts can remove other participants before Start. Other participants can leave; hosts instead have a confirmed cancellation action. Removed/left credentials lose their seat, and stale participant controls cannot remove a replacement. Started games reject seating changes. Cancellation closes public views, summaries and invitation joins, cannot be resurrected by a retried creation, and creates no game archive. A retained cancellation record acknowledges exact retries and prevents code reuse; it releases the game-count slot and growth reservation while its actual bytes still count against storage. These records currently retain lobby metadata and retry receipts rather than being compacted.

Validation: **129 tests pass locally**, with no failures or skips. New coverage includes both player counts, host swaps and recovery, automatic Random Start, competing final joins, lost acknowledgements and restart, cancellation capacity release on file storage and PostgreSQL/PGlite, old-record compatibility, HTTP cancellation/hidden colours, browser credential cleanup, and role-appropriate simulated-DOM lobby controls. Generated standalone rebuilt. Native PostgreSQL CI is checked on the draft PR. Fresh browser layout/touch/reduced-motion verification remains pending because Chromium is unavailable in this workspace.

Ready transitions are recorded for future notification work; this increment does not deliver notifications. Remaining work includes notifications and their wake-up mechanism, resignation/terminal/admin flows, animation and cinematic combat, actual browser QA and provider/release checks. No merge, deployment or provider change is included.
