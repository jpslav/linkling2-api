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
  `flushCounts` five seconds after each UTC midnight, and once more at shutdown.
  - The midnight write covers only the days that are over. Follows in the new day's first
    seconds wait for the next write, so nothing on disk shows a click just after midnight.
  - Each write is one transaction, with rows inserted in (link, day) order rather than
    the order anyone clicked. It is followed by `wal_checkpoint(TRUNCATE)`, which throws
    when another connection keeps it from emptying the WAL, as in ADR-0012.
  - The files' modification times then say "a daily write, or a shutdown", never when
    anyone clicked.
- **`daily_counts` keeps no rowid.** Migration `0002_daily_counts_without_rowid.sql`
  rebuilds it `WITHOUT ROWID`, keeping its rows. A rowid is handed out in insertion order.
  It would last in the file and record which link was first counted before which, and,
  across writes, which links were first clicked after a restart. Without one, a row is
  stored by its key (link, day) alone. The columns are unchanged, so
  `privacy-manifest.json` is unchanged.
- **A stop cannot be held up by a request.** At shutdown the tallies are written first.
  The service then waits at most three seconds for requests in flight (Docker kills a
  container ten seconds after SIGTERM) and writes again. Then it closes the database and
  exits, even if a connection is still open. A half-sent request, which anyone can make,
  therefore cannot cost the day's counts.
- **What the team sees includes the tallies.** A link's counts (`/-/api/links/:name/counts`,
  and the stats page through the same store) add the unwritten tallies to what is on disk,
  so today's count is current all day.
- **A write that fails** logs one fixed line, `linkling: writing the daily counts failed`,
  with nothing from the error. A write that did not commit keeps its tallies for the next
  write. One that committed but could not truncate the WAL is not written again. That
  line comes from the timer or the shutdown, never from a request, so the manifest's "handling a
  request writes nothing about it to any log" stays true.

`tests/counts-on-disk.test.ts` pins this:

- Following links (GET, HEAD, 404 and 410) leaves every database file's bytes and
  modification time unchanged. The watch does see the day's write, which is its blind arm.
- That write lands in one go and leaves the WAL empty.
- It survives a failure, and says so when the WAL stays.
- The midnight write leaves the new day alone.
- A stop writes the counts even with a stalled request open.

Switching back to one write per click turns three of its tests red. `tests/db.test.ts`
pins the missing rowid and the migration.

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
