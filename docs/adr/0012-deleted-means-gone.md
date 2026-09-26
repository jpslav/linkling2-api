# ADR-0012 — Deleted link data is overwritten, not just unlisted: secure_delete is on and the WAL is truncated after a delete

- Status: Accepted
- Approver: claude
- Date: 2026-09-26

## Context

The privacy page (R-022) says a link's name, target, maker, creation time and expiry are
kept "until the link is deleted". It also says a deleted link's daily counts are "tied to
no name". Principle `promises-literal` makes both claims about every byte the service
stores, not only about what the API returns.

SQLite does not work that way by default. A `DELETE` marks the row's space free and leaves
its bytes where they were. In WAL mode (ADR-0006, `src/db/open.ts`), the page as it was
before the delete also stays in the `-wal` file until that file is overwritten or
truncated. LL-005's independent review of the privacy text found this. The new test
`tests/deleted-leaves-nothing.test.ts` makes a link, deletes it, and scans the database
files for its name, target and maker. On `main` it found all three, both while the
database was open and after it was closed.

This changes what is on disk. It changes nothing a team member, a clicker or a visitor
sees, so it is Claude's. It keeps an existing promise rather than making a new one.

## Decision

- `openDatabase` sets `PRAGMA secure_delete = ON` on every connection, so SQLite
  overwrites deleted content with zeros.
- `deleteLink` runs `PRAGMA wal_checkpoint(TRUNCATE)` after it deletes a row. That copies
  the zeroed pages into the main file and empties the `-wal` file, so the WAL keeps no
  copy of the page from before the delete.
- The same rule applies to the next code that removes or overwrites link data. LL-007's
  target edit (ADR-0001, ADR-0003) is the known case. The old value must leave no copy, and
  that code runs the same checkpoint after it writes.
- `tests/deleted-leaves-nothing.test.ts` pins this with a byte scan of the main, `-wal`,
  `-shm` and `-journal` files. The scan runs while the database is open and again after it
  closes. It fails blind if it cannot see the link before the delete.

## Consequences

- Every write zeroes the space it frees, which costs some extra I/O. A delete also costs
  a checkpoint. Deletes are rare, and the whole database is a few tables for one team.
- A truncating checkpoint cannot finish while another connection is reading an older
  snapshot. It then reports busy instead of failing, and the WAL copy stays until a later
  checkpoint. The service is one process on one connection (ADR-0006), and
  better-sqlite3 is synchronous, so no other reader is open when `deleteLink` runs. A
  second connection added later would reopen this gap. The byte-scan test uses one
  connection, so it would not notice.
- This does not cover copies outside the service's own files: backups a team takes, or the
  file system's own handling of freed blocks on the disk. The privacy page's scope is the
  service, as ADR-0004 says.
- Alternatives considered:
  - **Rewording the page** to say leftovers may remain until overwritten. It is honest but
    weakens the promise, and "tied to no name" would stay false for an unknowable time.
  - **Running `VACUUM` after each delete.** It also removes the leftovers, but it rewrites
    the whole file each time and still needs the checkpoint for the WAL.
  - **Leaving WAL mode.** ADR-0006 chose WAL mode, and leaving it would not remove the
    freed-page leftovers on its own.
