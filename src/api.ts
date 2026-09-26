// The team API (ADR-0012): make, list, read, edit and delete links, and read a link's daily
// counts. Every route is under /-/api/, so the team-key guard in app.ts covers it.
import type { FastifyInstance, FastifyReply } from "fastify";
import { parseEdit, parseMake } from "./api-input.js";
import { isExpired } from "./links.js";
import { claimMadeUpName, normalizeName, type RandomIndex } from "./names.js";
import { expiryOf, type LinkStore, type StoredLink } from "./store.js";

export interface ApiDeps {
  links: LinkStore;
  now: () => Date;
  randomIndex?: RandomIndex;
}

/** A link as the API shows it. The internal id is shown nowhere (ADR-0004). */
export interface LinkJson {
  name: string;
  url: string;
  made_by: string;
  created_at: string;
  /** null: never. */
  expires_at: string | null;
  expired: boolean;
}

function linkJson(link: StoredLink, now: Date): LinkJson {
  return {
    name: link.name,
    url: link.target,
    made_by: link.madeBy,
    created_at: link.createdAt,
    expires_at: link.expiresAt,
    expired: isExpired({ expiresAt: expiryOf(link) }, now),
  };
}

/** A JSON answer the browser and any proxy between are told not to keep. */
export function sendJson(reply: FastifyReply, status: number, body: unknown): FastifyReply {
  return reply.code(status).header("cache-control", "no-store").send(body);
}

const sendError = (reply: FastifyReply, status: number, error: string) => sendJson(reply, status, { error });

type Named = { Params: { name: string } };

export function registerApi(app: FastifyInstance, { links, now, randomIndex }: ApiDeps): void {
  /** The stored link a path names, in any case; null when there is none. */
  const named = (raw: string): StoredLink | null => {
    const name = normalizeName(raw);
    return name === null ? null : links.get(name);
  };
  const noSuchLink = (reply: FastifyReply, raw: string) => sendError(reply, 404, `no link is named "${raw}"`);

  app.post("/-/api/links", async (request, reply) => {
    const at = now();
    const parsed = parseMake(request.body, at);
    if (!parsed.ok) return sendError(reply, 400, parsed.error);
    const { name, ...rest } = parsed.value;

    if (name !== null) {
      const made = links.tryCreate({ name, ...rest }, at);
      if (made === null) return sendError(reply, 409, `the name "${name}" is already taken`);
      return sendJson(reply, 201, linkJson(made, at));
    }
    // The insert itself is the claim, so a made-up name another maker took is retried.
    const made = new Map<string, StoredLink>();
    const claimed = await claimMadeUpName((candidate) => {
      const link = links.tryCreate({ name: candidate, ...rest }, at);
      if (link !== null) made.set(candidate, link);
      return link !== null;
    }, randomIndex);
    return sendJson(reply, 201, linkJson(made.get(claimed)!, at));
  });

  app.get("/-/api/links", async (_request, reply) => {
    const at = now();
    return sendJson(reply, 200, { links: links.list().map((link) => linkJson(link, at)) });
  });

  app.get<Named>("/-/api/links/:name", async (request, reply) => {
    const link = named(request.params.name);
    if (link === null) return noSuchLink(reply, request.params.name);
    return sendJson(reply, 200, linkJson(link, now()));
  });

  app.patch<Named>("/-/api/links/:name", async (request, reply) => {
    const parsed = parseEdit(request.body);
    if (!parsed.ok) return sendError(reply, 400, parsed.error);
    const name = normalizeName(request.params.name);
    const link = name === null ? null : links.setTarget(name, parsed.value);
    if (link === null) return noSuchLink(reply, request.params.name);
    return sendJson(reply, 200, linkJson(link, now()));
  });

  app.delete<Named>("/-/api/links/:name", async (request, reply) => {
    const name = normalizeName(request.params.name);
    if (name === null || !links.delete(name)) return noSuchLink(reply, request.params.name);
    return reply.code(204).header("cache-control", "no-store").send();
  });

  app.get<Named>("/-/api/links/:name/counts", async (request, reply) => {
    const link = named(request.params.name);
    if (link === null) return noSuchLink(reply, request.params.name);
    const days = links.dailyCounts(link.id);
    const total = days.reduce((sum, day) => sum + day.count, 0);
    return sendJson(reply, 200, { name: link.name, total, days });
  });
}
