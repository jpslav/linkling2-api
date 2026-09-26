// The link store the service runs on: SQLite through src/db/, behind the interfaces the
// HTTP layer is written against. One Database, opened once at start-up (src/server.ts),
// and this process the only one that writes it (ADR-0006).
//
// A click touches no file (ADR-0014). The redirect reads links from a copy held here,
// and a follow is tallied here too; the tallies reach the database only in
// flushCounts, which src/server.ts calls just after each UTC midnight and at shutdown.
// One commit per click would leave the order of clicks in the WAL and the time of the
// last one in the files' modification times, which is more than ADR-0004 keeps.
import type { Database } from "better-sqlite3";
import {
  createLink,
  deleteLink,
  getLinkByName,
  listDailyCounts,
  listLinks,
  setTarget,
  truncateWal,
  utcDay,
  type DailyCount,
  type Link as StoredLink,
  type NewLink,
} from "./db/links.js";
import type { Link, LinkLookup } from "./links.js";

export type { DailyCount, NewLink, StoredLink };

/** Everything the team API does to links; names are already lower-cased by the caller. */
export interface LinkStore extends LinkLookup {
  /** Stores the link, or answers null when its name is taken. */
  tryCreate(link: NewLink, now: Date): StoredLink | null;
  list(): StoredLink[];
  get(name: string): StoredLink | null;
  /** The link as it is after the edit, or null when there is none by that name. */
  setTarget(name: string, target: string): StoredLink | null;
  /** Whether a link by that name existed. Its counts stay (ADR-0004). */
  delete(name: string): boolean;
  /** Every counted day for one link, oldest first, including follows not yet written. */
  dailyCounts(id: number): DailyCount[];
}

/** The stored expiry, as the Date the redirect's rule compares. */
export function expiryOf(link: StoredLink): Date | null {
  return link.expiresAt === null ? null : new Date(link.expiresAt);
}

const asLink = (link: StoredLink): Link => ({ id: link.id, target: link.target, expiresAt: expiryOf(link) });

export class SqliteLinks implements LinkStore {
  /** Every link by name, as the redirect needs it; kept in step by every write below. */
  private readonly byName = new Map<string, Link>();
  /** Follows not yet written: link id, then UTC day, then how many. */
  private readonly pending = new Map<number, Map<string, number>>();

  // A plain field rather than a parameter property, which Node's type stripping refuses
  // when tests/support/follow-a-link.mjs loads this file straight from source.
  readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    for (const link of listLinks(db)) this.byName.set(link.name, asLink(link));
  }

  async lookup(name: string): Promise<Link | null> {
    return this.byName.get(name) ?? null;
  }

  countFollow(id: number, now: Date): void {
    const days = this.pending.get(id) ?? new Map<string, number>();
    const day = utcDay(now);
    days.set(day, (days.get(day) ?? 0) + 1);
    this.pending.set(id, days);
  }

  /**
   * Writes the tallied follows in one transaction, in (link, day) order rather than the
   * order anyone clicked, then truncates the WAL so the file keeps no copy of the counts as
   * they were (ADR-0014). With `before` (a `YYYY-MM-DD` day), only earlier days are written:
   * the midnight write leaves the new day's first seconds in memory, so nothing on disk
   * shows who clicked just after midnight. Returns how many follows it wrote.
   *
   * If the transaction fails, nothing is written, the tallies are kept, and it throws. If
   * the write commits but the WAL cannot be truncated, it throws after the write.
   */
  flushCounts(before?: string): number {
    const rows: [number, string, number][] = [];
    for (const [id, days] of this.pending) {
      for (const [day, count] of days) if (before === undefined || day < before) rows.push([id, day, count]);
    }
    if (rows.length === 0) return 0;
    rows.sort(([a, x], [b, y]) => a - b || (x < y ? -1 : x > y ? 1 : 0));
    const add = this.db.prepare(
      `INSERT INTO daily_counts (link_id, day, count) VALUES (?, ?, ?)
       ON CONFLICT (link_id, day) DO UPDATE SET count = count + excluded.count`,
    );
    this.db.transaction(() => {
      for (const row of rows) add.run(...row);
    })();
    let written = 0;
    for (const [id, day, count] of rows) {
      written += count;
      const days = this.pending.get(id)!;
      days.delete(day);
      if (days.size === 0) this.pending.delete(id);
    }
    truncateWal(this.db, "the day's counts were written, but another connection kept the WAL from being truncated (ADR-0014)");
    return written;
  }

  tryCreate(link: NewLink, now: Date): StoredLink | null {
    try {
      const made = createLink(this.db, link, now);
      this.byName.set(made.name, asLink(made));
      return made;
    } catch (err) {
      // The UNIQUE index on name is what refuses a taken name, so two makers cannot both win.
      if ((err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE") return null;
      throw err;
    }
  }

  list(): StoredLink[] {
    return listLinks(this.db);
  }

  get(name: string): StoredLink | null {
    return getLinkByName(this.db, name) ?? null;
  }

  setTarget(name: string, target: string): StoredLink | null {
    try {
      return setTarget(this.db, name, target) ?? null;
    } finally {
      // Read back rather than trusted: setTarget throws after the edit when the WAL could
      // not be truncated, and the redirect must follow the edit either way.
      const now = getLinkByName(this.db, name);
      if (now !== undefined) this.byName.set(name, asLink(now));
    }
  }

  delete(name: string): boolean {
    // Gone from the redirect first, so a delete that throws after the row is gone (a busy
    // checkpoint) has still stopped the link. One that throws before puts it back: the
    // redirect follows whatever the database holds.
    this.byName.delete(name);
    try {
      return deleteLink(this.db, name);
    } catch (err) {
      const still = getLinkByName(this.db, name);
      if (still !== undefined) this.byName.set(name, asLink(still));
      throw err;
    }
  }

  dailyCounts(id: number): DailyCount[] {
    const days = new Map(listDailyCounts(this.db, id).map(({ day, count }) => [day, count]));
    for (const [day, count] of this.pending.get(id) ?? []) days.set(day, (days.get(day) ?? 0) + count);
    return [...days].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([day, count]) => ({ day, count }));
  }
}
