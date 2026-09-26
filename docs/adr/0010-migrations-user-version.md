# ADR-0010 — Migrations are numbered SQL files tracked by PRAGMA user_version, with no migrations table

- Status: Accepted
- Approver: claude
- Date: 2026-09-26

## Context

ADR-0003 says schema changes go through numbered migrations run at start-up, but not how
the service knows which have run. Whatever records that lives in the same SQLite file as
the data. ADR-0004 makes every table in that file something `privacy-manifest.json` has
to account for. R-009 pins the counts table to link, day and count. Everyone who adds a
migration after LL-003 inherits the mechanism, so it is recorded here rather than left in
the code.

Alternatives considered:

- **A `schema_migrations` table**, one row per applied migration. It gives a per-migration
  history, but it is a third table the manifest and the schema tests would have to list
  or exempt.
- **A migration library** (umzug, knex, and others). It adds a dependency and a runtime
  table for a service with one SQLite file and forward-only changes (principle
  `small-over-clever`).
- **`PRAGMA user_version`**, SQLite's own integer in the file header, holding the number of
  the last migration applied. It adds no table and no dependency.

## Decision

- Migrations are SQL files in `migrations/`, named `NNNN_<what>.sql` and numbered from
  `0001` with no gap or repeat. They are forward-only; there are no down files.
- `src/db/migrate.ts` applies, in number order, every file above the database's
  `user_version`. Each file runs in one `BEGIN IMMEDIATE` transaction together with
  setting `user_version` to its number, so a failed migration leaves the database at the
  version before it. The version is re-read inside that transaction, so two processes
  starting at once do not both apply the same file.
- A `.sql` file in `migrations/` whose name starts with a digit but does not match
  `NNNN_<what>.sql` is refused rather than skipped.
- Opening the database (`src/db/open.ts`) runs this every time. Running it on an
  up-to-date database applies nothing.
- A database whose `user_version` is higher than the highest file present is refused, not
  touched: it was written by newer code. A negative `user_version` is refused too.

## Consequences

- The file holds exactly the tables the migrations create, plus SQLite's own
  `sqlite_sequence`, which `AUTOINCREMENT` requires.
- There is no record of when each migration ran, only how far the file has come.
  Forward-only numbered files never need more.
- A shipped migration file is never edited. A fix is a new, higher-numbered file, because
  a database already past a number never re-reads it.
- `migrations/` is read at run time from next to `dist/`, so the container image has to
  ship it.
