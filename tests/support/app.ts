// The app over a real SQLite file, as the service runs it, for tests of the HTTP layer.
import type { LightMyRequestResponse } from "fastify";
import { buildApp, type AppDeps } from "../../src/app.js";
import type { NewLink } from "../../src/db/links.js";
import { SqliteLinks, type StoredLink } from "../../src/store.js";
import { openTempDatabase } from "../temp-db.js";
import { bearer, TEST_KEY } from "./team-key.js";

export const MADE = new Date("2026-09-26T12:00:00Z");

/** A store over a fresh database file, closed and removed after the test. */
export function tempLinks(): SqliteLinks {
  return new SqliteLinks(openTempDatabase());
}

/** Stores a link straight into the store, made by `sam` at MADE unless told otherwise. */
export function seed(
  links: SqliteLinks,
  name: string,
  target: string,
  expiresAt: Date | null = null,
  extra: Partial<NewLink> & { at?: Date } = {},
): StoredLink {
  const link = links.tryCreate({ name, target, madeBy: "sam", expiresAt, ...extra }, extra.at ?? MADE);
  if (link === null) throw new Error(`seed: ${name} is taken`);
  return link;
}

/** A fresh store holding one link that never expires. */
export function linkTo(name: string, target: string): SqliteLinks {
  const links = tempLinks();
  seed(links, name, target);
  return links;
}

/** The app over `links`, logging into `logged` rather than to stderr. */
export function appWith(links: SqliteLinks = tempLinks(), deps: Partial<AppDeps> = {}) {
  const logged: string[] = [];
  const app = buildApp({ links, key: TEST_KEY, log: (line) => logged.push(line), ...deps });
  return Object.assign(app, { logged, links });
}

/** A team-key call to the API, with a JSON body when one is given. */
export function apiCall(
  app: ReturnType<typeof buildApp>,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: body === undefined ? bearer(TEST_KEY) : { ...bearer(TEST_KEY), "content-type": "application/json" },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

export interface CountRow {
  link_id: number;
  day: string;
  count: number;
}

/** Every daily_counts row, in a fixed order, once the tallied follows are written. */
export function countRows(links: SqliteLinks): CountRow[] {
  links.flushCounts();
  return links.db.prepare("SELECT link_id, day, count FROM daily_counts ORDER BY link_id, day").all() as CountRow[];
}
