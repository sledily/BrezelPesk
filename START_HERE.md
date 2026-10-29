# BrezelPesk V2 foundation review

For local hot-seat play, open `Dendarv_Play.html`. It includes the Tabletop presentation and local rules integration.

For the online development server, use Node.js 24 and run `npm ci`, then `npm start`, from this repository root. Open http://127.0.0.1:4173 and choose BrezelPesk. There is no nested source folder.

The separate administrator screen is at `/admin`; configuration and archive-management instructions are in `ADMINISTRATION.md`.

Read `README.md` for PostgreSQL, private recovery codes, provisional capacity limits and tests. Read `V2_FOUNDATION.md` for implemented behavior and remaining release gates.

This is an isolated review branch. Do not merge it into the auto-deploying main branch until durable database configuration and the remaining release requirements have been reviewed. No old-game migration is required; preservation of new V2 games is required.
