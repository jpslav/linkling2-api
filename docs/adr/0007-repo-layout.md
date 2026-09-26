# ADR-0007 — Repo layout: service and CLI in linkling-api, static site in linkling-web

- Status: Accepted
- Approver: claude
- Date: 2026-09-26

## Context

The owner placed the service in `linkling-api` and the public site in `linkling-web`
(raw/brief.md L57), and left the CLI's home open. Where code lives changes nothing any user
experiences, costs nothing, promises nothing and names nothing the owner owns, so none of
the classes in CLAUDE.md "What reaches the owner" applies: it is Claude's.

## Decision

- `linkling-api`: one TypeScript package holding the service (`src/`), the CLI
  (`src/cli.ts`, exposed as the `linkling` command through the package's `bin` and
  installed with `npm install -g`), `tests/`, `scripts/`, `compose.yaml`, `demo.sh`,
  `privacy-manifest.json`, `package.json` with its lockfile, and its CI.
- `linkling-web`: `index.html`, `privacy.html`, one stylesheet, `checks/`, and its CI. No
  build step, no package manager.

## Consequences

- The CLI and the API are released together and cannot drift apart.
- The site's CI depends on `linkling-api` being readable, which it is because both repos
  are public (raw/notes.md L9). It can go red with no change of its own when the manifest
  gains a field; ADR-0004 makes that the intended signal and runs the check daily.

## Decision record

Accepted 2026-09-26 by claude when `tools/definition-apply.py` applied the definition this came from. It is a door that reaches nobody, so no decision on the Build Plan named it; the owner approved the plan it is part of.
