// The HTTP service. Later items register their routes on the instance buildApp returns,
// always under `/-/` (ADR-0001): everything else at the root is a short name.
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { isExpired, type LinkLookup } from "./links.js";
import { normalizeName } from "./names.js";

export interface AppDeps {
  links: LinkLookup;
  now?: () => Date;
}

// ADR-0002: nothing a browser may remember, and nothing that tells the target where the
// click came from. The full header set a redirect may carry is ADR-0009's allowlist.
const UNCACHED = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
} as const;

/** True for the two root routes and anything under `/-/`; nothing else may be registered. */
export function isServiceShaped(url: string | undefined): boolean {
  return url === "/" || url === "/:name" || (url?.startsWith("/-/") ?? false);
}

function plainPage(reply: FastifyReply, status: number, text: string): FastifyReply {
  return reply
    .code(status)
    .headers(UNCACHED)
    .type("text/plain; charset=utf-8")
    .send(`${text}\n`);
}

export function buildApp({ links, now = () => new Date() }: AppDeps): FastifyInstance {
  // No request log: the default line carries the clicker's address (ADR-0006).
  const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true } });

  // The shape is enforced where routes are made, so a later route at the root fails at
  // start-up instead of taking a name away from the team.
  app.addHook("onRoute", (route) => {
    if (!isServiceShaped(route.url)) {
      throw new Error(`route ${route.url} is outside /-/; only / and /:name live at the root`);
    }
  });

  app.get("/", async (_request, reply) => plainPage(reply, 200, "Linkling"));

  app.get<{ Params: { name: string } }>("/:name", async (request, reply) => {
    const name = normalizeName(request.params.name);
    const link = name === null ? null : await links.lookup(name);
    if (link === null) return plainPage(reply, 404, "No such link.");
    if (isExpired(link, now())) return plainPage(reply, 410, "This link has expired.");
    // The request's query string is deliberately not passed on (ADR-0001).
    return reply.code(302).headers(UNCACHED).header("location", link.target).send();
  });

  app.setNotFoundHandler(async (_request, reply) => plainPage(reply, 404, "No such link."));

  return app;
}
