// The HTTP service. Later items register their routes on the instance buildApp returns,
// always under `/-/` (ADR-0001): everything else at the root is a short name.
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { registerApi, sendJson } from "./api.js";
import { isExpired, type Link } from "./links.js";
import { normalizeName, type RandomIndex } from "./names.js";
import type { LinkStore } from "./store.js";
import { KEY_CHALLENGE, keyChecker, keyFromAuthorization } from "./team-key.js";

export interface AppDeps {
  links: LinkStore;
  /** The one team key (ADR-0005). Every `/-/` route but those in OPEN asks for it. */
  key: string;
  now?: () => Date;
  /** The source of made-up names; a cryptographic one unless a test scripts it. */
  randomIndex?: RandomIndex;
}

// A URL a client meant for the API, however it spelled the prefix: `/-/API/`, `/%2D/api/`.
const API_PATH = /^\/(-|%2d)\/api\//i;

// What a client error on the API says. Fastify's own messages can quote the request back.
const CLIENT_ERRORS: Record<number, string> = {
  400: "the body is not valid JSON",
  413: "the body is too large",
  415: "send the body as application/json",
};

// The only `/-/` routes that answer without the team key. Adding one here decides that
// anyone who can reach the service may call it.
const OPEN = new Set(["/-/health"]);

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

export function buildApp({
  links,
  key,
  now = () => new Date(),
  randomIndex,
}: AppDeps): FastifyInstance {
  const isTeamKey = keyChecker(key);

  const app = Fastify({
    // No request log: the default line carries the clicker's address (ADR-0006).
    logger: false,
    routerOptions: { ignoreTrailingSlash: true },
    // A malformed percent-escape (Fastify's JSON 400 by default) and a segment over
    // Fastify's 100-character maxParamLength (its JSON 414) are not names either: the
    // same plain 404. Anything else Fastify reports here is its own fault, not the URL's.
    frameworkErrors: (error, request, reply) => {
      const notAName = error.code === "FST_ERR_BAD_URL" || error.code === "FST_ERR_MAX_PARAM_LENGTH";
      void (notAName ? notFound(request.url, reply) : plainPage(reply, 500, "Something went wrong."));
    },
  });

  // A client of the API gets its 404 as JSON like every other API answer, a browser the
  // plain page. Only the answer's format follows the URL's text; nothing is guarded by it.
  function notFound(url: string, reply: FastifyReply): FastifyReply {
    if (API_PATH.test(url)) return sendJson(reply, 404, { error: "no such link or route" });
    return plainPage(reply, 404, "No such link.");
  }

  // JSON bodies as Fastify parses them, except that an empty one is no body at all: a
  // client that sends `Content-Type: application/json` on every call can still DELETE.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    if (body === "") return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error("the body is not valid JSON"), { statusCode: 400 }), undefined);
    }
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

  // The guard decides by the route that matched, never by the text of the URL: Fastify
  // routes `/%2D/api/links` to `/-/api/links`, so a prefix test on request.url would let
  // it through. A hook on the root instance, it covers every route on it and in its plugins,
  // including those added after buildApp returns (tests/team-key.test.ts). A request that
  // matched no route gets the plain 404; there is nothing there to guard.
  app.addHook("onRequest", async (request, reply) => {
    const route = request.routeOptions.url;
    if (route === undefined || !route.startsWith("/-/") || OPEN.has(route)) return;
    if (isTeamKey(keyFromAuthorization(request.headers.authorization))) return;
    // One answer for no key and a wrong key alike.
    reply.header("www-authenticate", KEY_CHALLENGE);
    return plainPage(reply, 401, "The team key is needed.");
  });

  app.get("/", async (_request, reply) => plainPage(reply, 200, "Linkling"));

  app.get<{ Params: { name: string } }>("/:name", async (request, reply) => {
    const name = normalizeName(request.params.name);
    const at = now();
    let link: Link | null;
    try {
      link = name === null ? null : await links.lookup(name);
    } catch {
      // Whatever the store says went wrong is not the clicker's to read. Nor is it logged:
      // handling a request writes nothing about it to any log (privacy-manifest.json), and
      // a log line's own timestamp would say when someone clicked.
      return plainPage(reply, 500, "Something went wrong.");
    }
    if (link === null) return plainPage(reply, 404, "No such link.");
    if (isExpired(link, at)) return plainPage(reply, 410, "This link has expired.");
    // Only a followed GET counts; HEAD runs this same handler and does not (R-029).
    if (request.method === "GET") {
      try {
        await links.countFollow(link.id, at);
      } catch {
        // The clicker still gets their link; a count that could not be taken is the team's
        // loss, and it goes unlogged for the same reason as above.
      }
    }
    // The request's query string is deliberately not passed on (ADR-0001).
    return reply.code(302).headers(UNCACHED).header("location", link.target).send();
  });

  rootSealed = true;

  // Says the process is up and nothing more: no link, count, key or store state.
  app.get("/-/health", async (_request, reply) => plainPage(reply, 200, "ok"));

  registerApi(app, { links, now, randomIndex });

  // Anything a handler throws, and anything Fastify refuses before one runs (a body that is
  // not JSON, say). Nothing is logged, as above; a failing database shows as the 500s the
  // team gets from the API.
  app.setErrorHandler((error: { statusCode?: number }, request, reply) => {
    const code = error.statusCode;
    const status = code !== undefined && code >= 400 && code < 500 ? code : 500;
    const route = request.routeOptions.url;
    if (route?.startsWith("/-/api/")) {
      const error = status === 500 ? "Something went wrong." : (CLIENT_ERRORS[status] ?? "the request could not be read");
      return sendJson(reply, status, { error });
    }
    return plainPage(reply, status, status === 500 ? "Something went wrong." : "Bad request.");
  });

  app.setNotFoundHandler(async (request, reply) => notFound(request.url, reply));

  return app;
}
