import type { Database } from "better-sqlite3";

// Every time is UTC ISO 8601 and every day a UTC calendar date (ADR-0003). Functions
// that need the clock take `now`, so callers and tests decide what time it is.

export interface Link {
  id: number;
  name: string;
  target: string;
  madeBy: string;
  createdAt: string;
  /** null means the link never expires. */
  expiresAt: string | null;
}

export interface NewLink {
  name: string;
  target: string;
  madeBy: string;
  /** null means the link never expires; a date-only expiry is converted by the caller. */
  expiresAt: Date | null;
}

export interface DailyCount {
  day: string;
  count: number;
}

interface LinkRow {
  id: number;
  name: string;
  target: string;
  made_by: string;
  created_at: string;
  expires_at: string | null;
}

function toLink(row: LinkRow): Link {
  return {
    id: row.id,
    name: row.name,
    target: row.target,
    madeBy: row.made_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** The UTC calendar date of `now`, as `YYYY-MM-DD`. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Throws if the name is taken; name rules are checked by the caller. */
export function createLink(db: Database, link: NewLink, now: Date): Link {
  const row = db
    .prepare<[string, string, string, string, string | null], LinkRow>(
      `INSERT INTO links (name, target, made_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id, name, target, made_by, created_at, expires_at`,
    )
    .get(link.name, link.target, link.madeBy, now.toISOString(), link.expiresAt?.toISOString() ?? null);
  if (row === undefined) throw new Error("INSERT … RETURNING returned no row");
  return toLink(row);
}

export function getLinkByName(db: Database, name: string): Link | undefined {
  const row = db
    .prepare<[string], LinkRow>(
      "SELECT id, name, target, made_by, created_at, expires_at FROM links WHERE name = ?",
    )
    .get(name);
  return row === undefined ? undefined : toLink(row);
}

/** Every link, newest first. */
export function listLinks(db: Database): Link[] {
  return db
    .prepare<[], LinkRow>("SELECT id, name, target, made_by, created_at, expires_at FROM links ORDER BY id DESC")
    .all()
    .map(toLink);
}

/**
 * Points the link at a new target and changes nothing else: its name, maker, expiry and
 * counts stay (ADR-0001). Returns the link as it now is, or undefined when there is none.
 *
 * The old target is overwritten data, so ADR-0012's rule holds here as for a delete: it
 * must not run inside a transaction, and it throws after the edit when the checkpoint that
 * removes the old target's copy from the WAL could not finish.
 */
export function setTarget(db: Database, name: string, target: string): Link | undefined {
  if (db.inTransaction) throw new Error("setTarget cannot run inside a transaction (ADR-0012)");
  const row = db
    .prepare<[string, string], LinkRow>(
      `UPDATE links SET target = ? WHERE name = ?
       RETURNING id, name, target, made_by, created_at, expires_at`,
    )
    .get(target, name);
  if (row === undefined) return undefined;
  truncateWal(db, "the link's target was changed, but another connection kept the WAL from being truncated, so the old target remains there (ADR-0012)");
  return toLink(row);
}

/**
 * Copies the WAL into the main file (where secure_delete has zeroed what was freed) and
 * empties it, so the WAL keeps no copy of pages as they were before the last write
 * (ADR-0012). Throws `busyMessage` when another connection kept it from finishing.
 */
function truncateWal(db: Database, busyMessage: string): void {
  const [result] = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
  if (result?.busy !== 0) throw new Error(busyMessage);
}

/**
 * Deletes the link's row and nothing else: its daily counts stay under its id, which
 * AUTOINCREMENT never hands to another link (ADR-0003, ADR-0004). Returns whether a
 * link by that name existed.
 *
 * It must not run inside a transaction: SQLite refuses the checkpoint that follows the
 * delete there (SQLITE_LOCKED), and db.transaction() would then roll the delete back. It
 * throws after deleting when the checkpoint could not finish, because the link's old
 * bytes are then still in the WAL.
 */
export function deleteLink(db: Database, name: string): boolean {
  if (db.inTransaction) throw new Error("deleteLink cannot run inside a transaction (ADR-0012)");
  const deleted = db.prepare("DELETE FROM links WHERE name = ?").run(name).changes > 0;
  if (!deleted) return false;
  // The WAL still holds the page as it was before the delete.
  truncateWal(db, "the link was deleted, but another connection kept the WAL from being truncated, so its old bytes remain there (ADR-0012)");
  return true;
}

/** One use of a link: that UTC day's count for it goes up by one, in a single upsert. */
export function incrementCount(db: Database, linkId: number, now: Date): void {
  db.prepare(
    `INSERT INTO daily_counts (link_id, day, count) VALUES (?, ?, 1)
     ON CONFLICT (link_id, day) DO UPDATE SET count = count + 1`,
  ).run(linkId, utcDay(now));
}

/** The count for one link on one UTC day (`YYYY-MM-DD`); 0 when nothing was counted. */
export function getDailyCount(db: Database, linkId: number, day: string): number {
  const row = db
    .prepare<[number, string], { count: number }>(
      "SELECT count FROM daily_counts WHERE link_id = ? AND day = ?",
    )
    .get(linkId, day);
  return row?.count ?? 0;
}

/** Every counted day for one link, oldest first. */
export function listDailyCounts(db: Database, linkId: number): DailyCount[] {
  return db
    .prepare<[number], DailyCount>(
      "SELECT day, count FROM daily_counts WHERE link_id = ? ORDER BY day",
    )
    .all(linkId);
}
