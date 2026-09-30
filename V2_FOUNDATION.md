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

Local validation: **84 tests pass**, including SQL execution with embedded PostgreSQL/PGlite. The focused suite injects pre-commit failure and loss of a successful commit acknowledgement, retries after restart, checks capacity races, verifies takeover with cached views, preserves both Quarter branches, and rejects stale requests after Undo. HTTP tests cover private-path exclusion and administrator cookie/CSRF enforcement. The generated standalone passes the existing lightweight DOM startup checks.

The PGlite adapter runs real SQL but does not prove network-driver or multiple-connection behavior. The GitHub workflow runs the same checks with PostgreSQL 17; its result must be reviewed separately. Actual browser layout, a live database/provider connection, provider backup/restore and a production deployment have not been verified here.

## Remaining release gates

1. Select and configure a free database. Verify its current quota and retention/recovery terms; measure representative long two-/four-player records before fixing the numeric game cap. Current 10-room/64-MiB/2-MiB-reserve settings are provisional and can pause writes if games outgrow their reserved space.
2. Exercise a full database backup/restore, including room credentials/verifiers, receipts, pending records, audit and capacity metadata. Participant game exports do not restore the entire service.
3. Reconcile the actual Render dashboard build/start/health configuration with the repository configuration. Production requires `DATABASE_URL`; no configuration or provider account was changed. Main auto-deploys, so review is required before merge.
4. Implement and verify the remaining V2 mechanics and lifecycle states: the three seating modes, exact Stockpile policy/queued preferences, resignation ballots/deadline reconciliation, Active Games, notifications and any required independent wake-up mechanism. This foundation preserves stored state but does not claim tests for those not-yet-implemented state machines.
5. Bind the approved Tabletop interface, dramatic dice/King treatment, touch/responsive/reduced-motion behavior and direct terminal full-record screen. Finish administrator GUI, archive ZIP/download/delete and operational failure visibility.

This is the first reviewable foundation increment, not a declaration that every section 15.8 acceptance case or V2 as a whole is complete. No legacy game migration, main merge, production publication or paid provisioning is part of this change.
