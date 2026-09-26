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

  constructor(readonly db: Database) {
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
   * Writes every tallied follow in one transaction, then truncates the WAL so the file
   * keeps no copy of the counts as they were (ADR-0014). Returns how many follows it wrote;
   * on a failure nothing is written, the tallies are kept for the next flush, and it throws.
   */
  flushCounts(): number {
    if (this.pending.size === 0) return 0;
    const add = this.db.prepare(
      `INSERT INTO daily_counts (link_id, day, count) VALUES (?, ?, ?)
       ON CONFLICT (link_id, day) DO UPDATE SET count = count + excluded.count`,
    );
    let written = 0;
    this.db.transaction(() => {
      for (const [id, days] of this.pending) {
        for (const [day, count] of days) {
          add.run(id, day, count);
          written += count;
        }
      }
    })();
    this.pending.clear();
    this.db.pragma("wal_checkpoint(TRUNCATE)");
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
    const link = setTarget(this.db, name, target) ?? null;
    if (link !== null) this.byName.set(link.name, asLink(link));
    return link;
  }

  delete(name: string): boolean {
    // Gone from the redirect first: if the database then fails, the link has still stopped.
    this.byName.delete(name);
    return deleteLink(this.db, name);
  }

  dailyCounts(id: number): DailyCount[] {
    const days = new Map(listDailyCounts(this.db, id).map(({ day, count }) => [day, count]));
    for (const [day, count] of this.pending.get(id) ?? []) days.set(day, (days.get(day) ?? 0) + count);
    return [...days].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([day, count]) => ({ day, count }));
  }
}
