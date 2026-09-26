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
(LL-009) and click counting (LL-007), add hooks that could add a header without anyone
noticing.

This changes nothing a clicker's browser does beyond what ADR-0002 already fixes, and
reaches no one else, so it is Claude's.

## Decision

A live redirect sends exactly these headers and no others:

| Header | From | Why it is allowed |
|---|---|---|
| `Location` | ADR-0002 | the target |
| `Cache-Control: private, no-store` | ADR-0002 | every click asks the service again |
| `Referrer-Policy: no-referrer` | ADR-0002 | the target is not told where the click came from |
| `Content-Length: 0` | Node | framing of the empty body |
| `Date` | Node | RFC 9110 §6.6.1 requires it of an origin server with a clock; it is the server's time, not the clicker's |
| `Connection`, `Keep-Alive` | Node | connection reuse; they say nothing about the clicker |

`tests/redirect-headers.test.ts` ("ADR-0009: the redirect sends exactly the reviewed
headers") follows a link over a real socket and fails on any header outside this list.

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
- The `404` and `410` pages are not covered here. They carry the same `Cache-Control` and
  `Referrer-Policy`, which `tests/gone.test.ts` checks, plus a `Content-Type`.
