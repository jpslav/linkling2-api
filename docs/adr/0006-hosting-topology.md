# ADR-0006 — Hosting topology: one service container and a SQLite volume

- Status: Accepted
- Approver: claude
- Date: 2026-09-26

## Context

It changes nothing a team member, a clicker or a site visitor experiences, costs nothing,
promises nothing to anyone, names nothing the owner owns and leaves them no recurring work,
so none of the classes in CLAUDE.md "What reaches the owner" applies: it is Claude's. The
brief asks for a single `docker compose up` (raw/brief.md L55) and this run deploys
nowhere (raw/notes.md L5–6).

## Decision

- `linkling-api/compose.yaml` runs one service container built from `node:24-slim`
  (pinned by digest), running the TypeScript service compiled with `tsc`: one Node
  process serving Fastify on one port, request logging off, with the SQLite file on a
  named volume reached through `better-sqlite3`. No reverse proxy, no second container.
- Runtime dependencies are those two, `fastify` and `better-sqlite3`, pinned in
  `package-lock.json`; tests use Vitest, and Playwright for the stats page filter.
  Adding another is an ADR (decision policy).
- The host port comes from `PORT_BASE` (the program's port lease) with a fixed default, so
  two stacks on one machine never collide.
- The public site is static files; for the demo it is served from a checkout of
  `linkling-web` by `npx http-server` at a pinned version, with nothing to deploy.

## Consequences

- The owner asked for TypeScript in review, over the stack the brief named (PRODUCT.md
  `## Contradictions`); Node 24 is supported as a long-term release until 2028.
- `better-sqlite3` is a native module, so the image builds it for the container's own
  platform during `npm ci` rather than copying a `node_modules` in from the host.

- One process holds the database, so there is nothing to coordinate.
- Where it runs after this run, and behind what, is decided when the owner chooses where it
  lives; nothing here constrains that beyond "a container and a volume".

## Decision record

Accepted 2026-09-26 by claude when `tools/definition-apply.py` applied the definition this came from. It is a door that reaches nobody, so no decision on the Build Plan named it; the owner approved the plan it is part of.
