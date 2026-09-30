# Storage sizing and database recovery

This is an operator/review guide, not authorization to change the live service. All measured games are synthetic. No production database or game was accessed.

## Measured storage

Run `npm run measure:storage` to reproduce four seeded workloads through the room service. Each completes 20 engine Years. The quiet workload Harvests and Passes; the busier workload also Builds, Upgrades, Recruits and Vassalizes. It is a sizing driver, not an AI opponent or a strategic playtest. Combat and future V2 ballot/notification/Stockpile states are outside this measurement.

| Workload | Commands | Units | Peak live bytes before | Peak live bytes now | Ready terminal bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Two-player, quiet | 165 | 2 | 772,882 | 772,882 | 1,203,047 |
| Two-player, busier | 364 | 12 | 2,034,473 | 1,175,491 | 1,570,486 |
| Four-player, quiet | 278 | 4 | 1,347,795 | 1,347,795 | 2,095,042 |
| Four-player, busier | 750 | 28 | 3,820,349 | 2,225,602 | 3,000,840 |

Bytes include persisted room state, receipts, drafts and Undo snapshots; terminal figures also include the archive's complete JSON record and formatted text. They are logical UTF-8 JSON sizes, **not** PostgreSQL physical allocation or network traffic. The earlier 2-MiB reserve did not cover the busy four-player peak or its terminal archive.

Undo now stores exact event/command prefix lengths instead of copying the entire history into every reversible snapshot. Other state, including physical cards, pools and RNG, remains in each snapshot. A command that changes an older history entry gets a full snapshot. Older full snapshots remain readable. Multi-step Undo after restart is tested against the complete expected state and both logs; malformed prefix lengths fail without accepting a mutation. This reduces the measured busy four-player peak by approximately 42% without deleting game history.

The revised **provisional defaults** are five stored rooms, a 64-MiB logical budget, and 8 MiB reserved per unfinished or pending-archive room. Five initial reservations consume 40 MiB, leaving 24 MiB of logical headroom. An archive releases its reserve only after its text is durably ready. New-room rejection does not flag existing games as paused. Retained terminal games continue to count toward the room limit.

These are initial engineering limits, not five guaranteed games of arbitrary length and not certification against an unselected free plan. Histories can grow indefinitely. Capacity errors preserve the previous accepted state and never cause automatic deletion or paid upgrade. The physical database guard remains 256 MiB with the default logical budget; database/index/bloat/backup overhead and provider-specific quota accounting need live-provider validation. Do not silently change stored capacity settings: the database and environment must agree after deliberate operator review.

## What a service backup must include

Back up the dedicated application database, not just participant exports. Required tables currently include `dendarv_rooms` (published state, exact private draft/RNG, compact/full Undo, control/recovery verifiers, receipts, archive work and separate audit) and `dendarv_capacity` (the enforced budget). Future application tables must be included too.

A database dump does not contain the deployed source, hosting configuration, database roles/global settings or the externally configured administrator password. Preserve those through their respective configuration/secret-management systems. Administrator login sessions are intentionally ephemeral and require a fresh login after restart; player control/recovery verifiers are durable.

The backup contains sensitive private game and operational data. Keep it outside the public asset tree and Git, restrict file access, and encrypt it before off-host storage. Never attach a real service backup to the public PR. The app's asset allowlist must continue to deny dump/config/private paths.

## Operator recovery procedure

Use PostgreSQL client tools compatible with the source server (the test uses version 17). Configure trusted libpq service profiles named `dendarv_source` and `dendarv_restore` through protected configuration, with certificate-verified TLS for hosted connections. Keep passwords out of command arguments and shell history. The restore target must be a **new empty database**, separately provisioned and explicitly verified by the operator.

1. Create a private backup directory and use an exclusive new filename. From a protected operator environment, use `PGSERVICE=dendarv_source pg_dump --format=custom --no-acl --file=NEW_BACKUP_PATH`. Inspect exit status and stderr; do not treat a partially written file as a completed backup. Record source database, timestamp, app commit, client/server version and a checksum separately from public logs.
2. Verify the destination profile's hostname and database, then query `current_database()` and list non-system user tables with `psql "service=dendarv_restore"`. Stop if the destination is not the intended empty database. Never test restoration over the live database.
3. Restore only a trusted backup: `pg_restore --dbname="service=dendarv_restore" --no-owner --no-acl --single-transaction --exit-on-error NEW_BACKUP_PATH`. Do not add `--clean`. An error must abort the restore instead of leaving a partially usable service.
4. Start an isolated application instance against the restored database with matching capacity configuration. Reconfigure external secrets; do not issue replacement seat codes as a substitute for restoring the stored verifiers.
5. Verify the full row/capacity inventory; the same pending Harvest/Quarter/Ransom state and RNG; exact Undo; duplicate-request reconciliation; stable recovery/takeover; participant/spectator privacy; retained audit; ready archives and resumable pending archive work. Check any later-added deadline/job state before accepting play.
6. Cutover requires separate production authorization. Stop old writers, perform a final consistent copy/cutover procedure, and restart every application instance so no old cache or administrator session remains. Keep the previous database recoverable until the restored service is verified; do not delete it as part of a routine test.

A dump recovers the snapshot it captured, not actions accepted afterward. The acceptable recovery point, backup frequency, provider durability/PITR terms and any lost-interval reconciliation remain release decisions. A successful restore test does not establish a provider's retention guarantee or zero data loss after a disaster.

## Automated restore evidence

`tests/backup.test.js` creates synthetic rooms with a private Harvest offer, reversible draft, ready archive, pending Abandonment archive and administrator audit. It backs up the database, closes the source, restores a separate database and compares every room row, database version, allocation and capacity row. It then retries the accepted request, performs Undo and recovery, checks privacy and resumes pending archives.

Local tests use a PGlite data-directory backup. GitHub's PostgreSQL 17 job uses native `pg_dump`/`pg_restore`, drops **only its generated source test database** after dumping, and restores into its generated empty destination. Source and destination names are random, test-owned and cleaned up afterward. This validates restoration independently of the original database; it does not exercise a chosen production provider's backup service.

Official utility references: [pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html) and [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html).
