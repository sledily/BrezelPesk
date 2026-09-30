# BrezelPesk — Dendarv

BrezelPesk is the online service for Dendarv: Age of Crusader Kings. This branch builds the first V2 persistence and privacy foundation on the existing two-/four-player rules engine. The current screen and standalone local game retain the V1.5 presentation; the approved Tabletop interface is a later implementation stage.

The repository root is the canonical application. The former duplicate `dendarv/` tree has been removed.

## Development

Use Node.js 24 (the tested version):

```bash
npm ci
npm start
```

Open <http://127.0.0.1:4173>. Use **BrezelPesk** to create or join a room. Every occupied seat has a private recovery code; save it using **Copy recovery code**. Recovering a seat replaces its controlling browser session while retaining that code.

Without `DATABASE_URL`, development saves one atomic file per room in `.dendarv-data/v2`. Set `DENDARV_DATA_DIR` to change that location. The file adapter supports one server process only. Hosted/production startup refuses this fallback because ephemeral files cannot provide durable online saves.

For PostgreSQL, supply `DATABASE_URL` through the environment. The application creates `dendarv_capacity` and `dendarv_rooms` in the database's current schema. Use a dedicated database/schema. Hosted remote connections require certificate-verified TLS. Credentials belong in the deployment secret store, never source files.

## Storage and recovery

Each accepted request commits its room state, RNG state, draft, Undo history and idempotency receipt before sending the result. The browser retains an uncertain request across reloads and retries its original identity. An outcome already committed is not redrawn or charged again. Revisions reject stale commands, including stale requests after an action/Undo pair.

Ordinary online actions retain explicit Pass, even after the last affordable action. Undo cannot cross newly revealed information. A defender's Quarter handoff publishes the attack automatically; the final Quarter response publishes and resumes the attacker's opportunity.

Public routes use an explicit asset allowlist. Spectators retain public views after Completion or Abandonment. Authenticated participants can export full private records, including during an active game under the approved policy. Ordinary terminal access expires after 30 days; administrator records remain until explicit deletion is implemented and invoked.

Terminal transitions save a pending archive atomically. The in-process archive worker retries records independently and resumes on startup. It is idle when no work remains. A sleeping host delays retry work until the process wakes.

## Capacity

These are conservative **development defaults, not a certified free-plan capacity**:

| Environment variable | Default |
| --- | ---: |
| `DENDARV_MAX_GAMES` | 5 stored rooms, including terminal records |
| `DENDARV_STORAGE_BUDGET_BYTES` | 67,108,864 bytes (64 MiB logical budget) |
| `DENDARV_GAME_RESERVE_BYTES` | 8,388,608 bytes reserved per unfinished/pending-archive room |

Admission and writes are serialized transactionally across PostgreSQL clients. Stored JSON, receipts, Undo snapshots, archive copies and audit entries count toward allocation. A physical database guard stops writes before estimated size reaches four times the logical budget (256 MiB with defaults). This is an additional early stop, not a provider quota guarantee. Existing state is retained on capacity errors; the service never automatically deletes games or purchases an upgrade.

PostgreSQL persists these limits. A conflicting environment configuration fails startup instead of silently changing the budget. Four 20-year workloads are now measured; the larger reserve accounts for the observed peaks and additional growth. Final limits still require database/provider overhead and broader game coverage. Changing a limit requires deliberate review of the capacity row and corresponding environment values. No provider account or paid resource is created by this code. See [STORAGE_AND_RECOVERY.md](STORAGE_AND_RECOVERY.md) for exact measurements and the database restore procedure.

## Administration

Set `DENDARV_ADMIN_PASSWORD` (at least 20 characters) to enable administrator login. Without it, admin login is disabled. The foundation exposes an API; the administrator screen and batch ZIP/download/delete flow remain future work.

- `POST /api/admin/login`: password; returns a one-hour HttpOnly session cookie and CSRF token.
- `GET /api/admin`: stored-room allocations and configured limits.
- `GET /api/admin/rooms/:code`: full record, archive and separate administrator audit.
- `POST /api/admin/rooms/:code/recover`: confirmed exceptional recovery, rotating token and recovery code.
- `POST /api/admin/rooms/:code/abandon`: confirmed terminal Abandonment.

Admin writes require the cookie, `X-Admin-CSRF`, a unique `requestId`, and `confirmed: true`. Admin sessions expire on restart. Participant verifiers and recovery state are stored durably. Audit and authentication data never enter participant exports.

## Verification and local build

```bash
npm test
npm run build:local
npm run measure:storage
```

`Dendarv_Play.html` is the generated, self-contained local game. Open it directly for hot-seat play. Rebuild it whenever browser modules change. Do not open the modular `index.html` using `file://`.

The suite covers game rules, local UI startup, HTTP asset/privacy/admin boundaries, transactional failures, ambiguous commit reconciliation, concurrent capacity, recovery, pending Harvest and Quarter restart, publication, compact Undo and independent archives. SQL tests use embedded PostgreSQL through PGlite locally. Set `DENDARV_TEST_DATABASE_URL` to run against a disposable PostgreSQL server; use a test role with permission to create databases, and matching `pg_dump`/`pg_restore` clients. Tests create/remove only their own temporary schemas and randomly named test databases. The GitHub workflow supplies PostgreSQL 17 and runs the clients in its service container. Never point these tests at production.

See [V2_FOUNDATION.md](V2_FOUNDATION.md) for the review scope and release gates. Historical rules/design documents remain references, not claims that all V2 behavior is implemented.
