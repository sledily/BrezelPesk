# Administrator and archive management

Open `/admin` on the online server. This is a separate login; player credentials do not grant administrator access. Set `DENDARV_ADMIN_PASSWORD` to a strong secret of at least 20 characters through server configuration. The password is never included in static files or responses. An unset password disables login. This increment does not configure a hosted password or publish the server.

## Session and private inspection

Sessions last one hour, use an HttpOnly, SameSite=Strict cookie restricted to the administrator API, and require CSRF protection for changes. Hosted cookies require HTTPS. Sessions are in process memory: a restart signs administrators out; multi-process session sharing is not configured. Sign out revokes the server session. Expiry, sign-out and page departure clear rendered private records and displayed replacement codes. Administrator pages deny framing, use a restrictive content security policy and escape player-supplied names.

The collection lists lobbies, active games, complete/abandoned archives and closed records, with game-slot and logical-storage accounting. Active-game reservations are included in the storage total. Open a game to inspect its full saved current state, separately published state, full Chronicle/machine-facing history, archive status, notification retry status and operational audit. Hidden Courts, private draws and incomplete pending decisions are visible here. The interface refreshes on request, not continuously; recovery and abandonment reject an outdated inspection. Notification destinations, credentials and authentication hashes are not exposed by inspection.

There are no general state-editing, dice, piece, turn-advance or outcome controls. A stuck game needing an exceptional repair still requires a concrete diagnosis and separately agreed repair.

## Recover a lost seat

Choose the occupied seat, type the room code and confirm replacement. This changes both private recovery and controlling credentials, invalidates the former credentials, revokes the former notification subscription, and records an administrator intervention. Saved game state and incomplete decisions remain exact. Give the replacement recovery code privately to the player; they use the ordinary Recover seat form. The administrator screen does not send it to anyone.

Keep the displayed code before leaving or signing out. To handle a lost response, the pending action and its fresh credentials are saved in this tab's session storage **before** sending. The Retry same action button reuses them, including after a reload or renewed administrator login. Another action is blocked while its outcome is uncertain. Explicit sign-out clears that pending information. If the browser storage is unavailable, no action is sent. A later replacement code makes an earlier recovery retry fail instead of falsely reporting that the old code is still valid.

Recovery of an ended game grants only read-only participant access within the original 30-day window. It never reopens a terminal game or extends that window. Expired/cancelled/deleted games cannot receive new recovery credentials.

## Abandon an unfinished game

Type the room code and confirm Abandon game. Only a started active game is eligible. This is terminal, declares no winner, preserves the full safely stored state (including incomplete decisions), creates a durable archive job and writes a separate audit entry. An unstarted lobby is cancelled through the existing host controls instead.

## Download the collection

Download all archives produces one ZIP containing:

- `manifest.json`: the included game codes, terminal statuses, end times and download time.
- `<CODE>/record.json`: each complete structured record, including previously hidden information and the unpublished state saved at abandonment.
- `<CODE>/chronicle.txt`: each full text Chronicle, explicitly marking unfinished/abandoned records.

Completed and abandoned online games are included; lobbies, active games, local/hotseat games, cancelled rooms and deleted records are excluded. Pending archive jobs can still be downloaded from their already durable terminal snapshots. If a record cannot be formatted, the whole download reports an error instead of silently producing an incomplete collection. Downloads are bounded at 128 MiB of uncompressed content. Codes, rather than player-supplied game names, determine ZIP paths. Text is UTF-8 and ZIP integrity uses CRC32.

Downloading changes no stored record, receipt, retention date or deletion schedule. The collection remains administrator-only, while existing individual participant exports remain available according to their access rules. Credentials, push destinations, receipts and the operational audit are excluded from game-record downloads. Downloads already in progress may retain a record that is subsequently deleted; deletion cannot revoke a downloaded copy.

## Retry or delete an archive

A pending archive exposes Retry archive job. It resets only that job's backoff and wakes the existing worker. The retry itself is audited; failures and attempt counts remain visible. It never edits the game or fabricates an event.

Delete archive permanently is a separate typed-code confirmation available only for completed/abandoned records, including pending archives. It removes their saved game history, archive, player credentials, push data and ordinary access in one storage transaction. It releases the game slot and storage reservation. The remaining small record contains only the code, deletion time, operational audit and deletion receipt; its bytes still count toward capacity. This prevents a lost-response retry or old room-creation request from resurrecting the game. The tombstone and audit survive backups/restoration. Deletion can free an archive even when the database's physical-size guard is exceeded; PostgreSQL may reclaim/reuse the physical space later, not immediately.

Deletion does not erase older backups or copies someone previously downloaded. Backup retention must be managed separately. No expiry, batch download or background worker automatically deletes an archive.

## Validation and release gates

Automated coverage includes file and PostgreSQL persistence, deletion/backup/restore and admission accounting, credential replacement with pending state, stale inspection, exact request replay after unknown commit outcome, terminal expiry, archive retry, ZIP extraction by Python's independent reader, real HTTP authentication/CSRF/origin/route/download/deletion checks, and simulated-DOM recovery/reload/sign-out/expiry interactions.

A real browser layout/touch/accessibility pass is still required, including keyboard focus, mobile overflow, actual downloaded files and session transitions. The simulated DOM tests do not provide that visual evidence. Provider deployment, live administrator configuration and real browser QA are not activated by this change.
