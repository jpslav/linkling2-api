# ADR-0014 — A click touches no file; the day's counts are written once, after the day

- Status: Accepted
- Approver: claude
- Date: 2026-09-26

## Context

ADR-0004 says what is stored about a click: "which link, the UTC day, and that day's count.
Nothing else, anywhere". The privacy page says the same, and principle `promises-literal`
makes it a claim about every byte on disk.

The obvious design is one upsert per click. It stores more than that, and the extra is
not in any table:

- **The order of clicks.** In WAL mode each commit appends the changed page to the `-wal`
  file. Between checkpoints, the WAL holds a sequence of versions of the counts page, and
  the order in which counts went up is readable from it.
- **The time of the last click.** The database files' modification time is when the last
  write happened. With one write per click, that is when someone last clicked, to the
  second.

LL-005's review of the privacy page found this (its report,
`reports/2026-09-26-ll-005-keep-the-privacy-page-true-of.md`, finding D). The program
manager recorded the choice as the run decision "2026-09-26 — When are click counts
written to disk?" in `products/linkling/DECISIONS.md`. This ADR is how the service does it.

## Decision

- **The redirect reads no file.** `SqliteLinks` (`src/store.ts`) loads every link when it
  is built and keeps an in-memory copy by name. Every write the store makes (make, edit,
  delete) updates the copy, and the redirect's lookup reads only that copy. One process
  holds the database (ADR-0006), so nothing else can change it underneath.
- **A follow is tallied in memory,** by link id and UTC day.
- **The tallies are written once a day.** `startService` (`src/server.ts`) calls
  `flushCounts` five seconds after each UTC midnight, and once more at shutdown. The write
  is one transaction for every link and day, followed by `wal_checkpoint(TRUNCATE)`.
  Inside one transaction SQLite writes pages in page order, so the write carries no click
  order. The checkpoint then empties the WAL. The files' modification times then say "a
  daily write, or a shutdown", never when anyone clicked.
- **What the team sees includes the tallies.** A link's counts (`/-/api/links/:name/counts`,
  and the stats page through the same store) add the unwritten tallies to what is on disk,
  so today's count is current all day.
- **A write that fails** keeps the tallies for the next write and logs one fixed line,
  `linkling: daily counts not written; kept for the next write`, with nothing from the
  error (ADR-0004).

`tests/counts-on-disk.test.ts` pins it. Following links (GET, HEAD, 404 and 410) leaves
every database file's bytes and modification time unchanged. The watch does see the
day's write, which is its blind arm. That write lands in one go, leaves the WAL empty,
survives a failure, and happens at shutdown. Switching back to one write per click turns
three of its tests red.

Rejected:

- **One write per click.** It stores the order and time of clicks. See above.
- **Writing every few minutes.** Each write's time still tells, to within the interval,
  when there were clicks. Anything finer than a day is more than ADR-0004 keeps.
- **Rewording the privacy page** to admit the WAL and file times. It keeps the storage and
  weakens the promise, which principle `promises-literal` rules out.
- **Resetting the files' modification times after each write.** It hides one trace and
  leaves the WAL's order, and it relies on a trick rather than on what is written.

## Consequences

- **A crash loses that day's unwritten follows.** That covers a killed process, a lost
  host, or anything that skips the shutdown write. A normal stop (`docker compose down`,
  SIGTERM, SIGINT) writes them. The run decision accepts this: a lost part of one day's
  count is a smaller harm than a privacy page that says more than is true.
- The redirect never waits for the disk, which leaves R-016's 50 ms budget almost
  untouched.
- The in-memory copy of the links grows with the links table. For a team's links that is
  a few kilobytes to a few megabytes.
- Any later code that reads counts must go through the store, not straight to
  `daily_counts`, or it misses today's. Anything that writes links must go through the
  store, or the redirect will not see the write until a restart.
- API writes (make, edit, delete) still change the files when a team member makes them.
  Those times are about the team, not about clickers.
