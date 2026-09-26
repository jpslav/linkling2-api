// The link store the service runs on: SQLite through src/db/, behind the interfaces the
// HTTP layer is written against. One Database, opened once at start-up (src/server.ts).
import type { Database } from "better-sqlite3";
import {
  createLink,
  deleteLink,
  getLinkByName,
  incrementCount,
  listDailyCounts,
  listLinks,
  setTarget,
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
  /** Every counted day for one link, oldest first. */
  dailyCounts(id: number): DailyCount[];
}

/** The stored expiry, as the Date the redirect's rule compares. */
export function expiryOf(link: StoredLink): Date | null {
  return link.expiresAt === null ? null : new Date(link.expiresAt);
}

export class SqliteLinks implements LinkStore {
  constructor(readonly db: Database) {}

  async lookup(name: string): Promise<Link | null> {
    const link = getLinkByName(this.db, name);
    return link === undefined ? null : { id: link.id, target: link.target, expiresAt: expiryOf(link) };
  }

  countFollow(id: number, now: Date): void {
    incrementCount(this.db, id, now);
  }

  tryCreate(link: NewLink, now: Date): StoredLink | null {
    try {
      return createLink(this.db, link, now);
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
    return setTarget(this.db, name, target) ?? null;
  }

  delete(name: string): boolean {
    return deleteLink(this.db, name);
  }

  dailyCounts(id: number): DailyCount[] {
    return listDailyCounts(this.db, id);
  }
}
