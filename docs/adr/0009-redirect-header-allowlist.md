# ADR-0009 — The redirect's response headers are an allowlist, pinned by a test

- Status: Accepted
- Approver: claude
- Date: 2026-09-26

## Context

ADR-0002 lets a live short link's `302` carry `Location`, `Cache-Control: private,
no-store` and `Referrer-Policy: no-referrer`, and "no other header a framework adds by
default without that header being reviewed here". It names none. Every response the
service sends over a socket also carries headers that Node's HTTP server writes itself.
Fastify 5 adds nothing of its own to an empty `302`: no `X-Powered-By` and no
`Content-Type`. This was found with a probe of `fastify@5.12.5` on Node 24.19.0, recorded
in the LL-010 plan on jpslav/linkling2-api#4. The next items to touch the service, auth
(LL-009) and click counting (LL-007), may add hooks, and a hook can add a header without
anyone noticing.

This changes nothing a clicker's browser does beyond what ADR-0002 already fixes, and
reaches no one else, so it is Claude's.

## Decision

A live redirect sends no header outside this list:

| Header | From | Why it is allowed |
|---|---|---|
| `Location` | ADR-0002 | the target |
| `Cache-Control: private, no-store` | ADR-0002 | every click asks the service again |
| `Referrer-Policy: no-referrer` | ADR-0002 | the target is not told where the click came from |
| `Content-Length: 0` | Node | framing of the empty body |
| `Date` | Node | RFC 9110 §6.6.1 requires it of an origin server with a clock; it is the server's time, not the clicker's |
| `Connection` | Node | whether the connection stays open; it says nothing about the clicker |
| `Keep-Alive` | Node | sent only when the client keeps the connection open; it says nothing about the clicker |

`tests/redirect-headers.test.ts` ("ADR-0009: the redirect sends exactly the reviewed
headers") follows a link over a real socket with Node's own client, which asks for
keep-alive, and fails unless the headers are exactly this list.

Rejected:

- Strip `Date` and `Keep-Alive` as well. It is more minimal, but `Date` is required of
  the server, and neither header carries anything about the clicker.
- Assert only ADR-0002's three headers and the absence of `Set-Cookie`. A new default
  header could then ship unreviewed, which ADR-0002 rules out.

## Consequences

- A change that adds a header to the redirect updates this table and the test in the same
  PR, and the table is where it is reviewed.
- An upgrade of Fastify or Node that starts sending a new header by default turns the test
  red before it ships.
- The plain `404`, `410` and `500` pages are outside this allowlist. `tests/gone.test.ts`
  checks that they carry the same `Cache-Control` and `Referrer-Policy` and a plain-text
  `Content-Type`, but not their full header set.
