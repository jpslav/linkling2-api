// The HTTP service. Later items register their routes on the instance buildApp returns,
// always under `/-/` (ADR-0001): everything else at the root is a short name.
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { isExpired, type Link, type LinkLookup } from "./links.js";
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

function plainPage(reply: FastifyReply, status: number, text: string): FastifyReply {
  return reply
    .code(status)
    .headers(UNCACHED)
    .type("text/plain; charset=utf-8")
    .send(`${text}\n`);
}

export function buildApp({ links, now = () => new Date() }: AppDeps): FastifyInstance {
  const app = Fastify({
    // No request log: the default line carries the clicker's address (ADR-0006).
    logger: false,
    routerOptions: {
      ignoreTrailingSlash: true,
      // Fastify answers a longer segment with its own JSON 414; let every one reach
      // /:name, which refuses anything over 64 characters with the plain 404.
      maxParamLength: 16_384,
    },
    // A malformed percent-escape is not a name either: the same plain 404, not a JSON 400.
    frameworkErrors: (_error, _request, reply) => {
      void plainPage(reply, 404, "No such link.");
    },
  });

  // The shape is enforced where routes are made. The root holds exactly the routes
  // registered below; once they are in, any later route outside `/-/`, whatever its
  // method or constraints, fails at start-up instead of taking a name from the team.
  let rootSealed = false;
  app.addHook("onRoute", (route) => {
    if (route.url?.startsWith("/-/")) return;
    if (rootSealed || (route.url !== "/" && route.url !== "/:name")) {
      throw new Error(`route ${String(route.method)} ${route.url} is outside /-/; the root holds only short names`);
    }
  });

  app.get("/", async (_request, reply) => plainPage(reply, 200, "Linkling"));

  app.get<{ Params: { name: string } }>("/:name", async (request, reply) => {
    const name = normalizeName(request.params.name);
    let link: Link | null;
    try {
      link = name === null ? null : await links.lookup(name);
    } catch {
      // Whatever the store says went wrong is not the clicker's to read.
      return plainPage(reply, 500, "Something went wrong.");
    }
    if (link === null) return plainPage(reply, 404, "No such link.");
    if (isExpired(link, now())) return plainPage(reply, 410, "This link has expired.");
    // The request's query string is deliberately not passed on (ADR-0001).
    return reply.code(302).headers(UNCACHED).header("location", link.target).send();
  });

  rootSealed = true;

  app.setNotFoundHandler(async (_request, reply) => plainPage(reply, 404, "No such link."));

  return app;
}
