# ADR-0008 — No third-party services, in the product or on the public site

- Status: Accepted
- Approver: claude
- Date: 2026-09-26

## Context

A vendor on a clicker's request path or on the public site would be `legal` under CLAUDE.md
"What reaches the owner", because it would learn things about people who never agreed to
anything. This ADR chooses no vendor at all, which is what the brief's promise already
requires (raw/brief.md L9–11, L49–51) — so it opens no promise, costs nothing, names
nothing the owner owns and leaves no recurring work: no class applies, and it is Claude's.
Choosing any vendor later would reach the owner as `legal`.

## Decision

- The service calls nothing outside itself.
- The public site loads nothing from any other origin: no web fonts, no analytics, no CDN,
  no embedded images. `checks/no-third-party.sh` fails on any off-site `src` or `href` in
  its HTML or CSS.
- CI uses GitHub Actions only, which sees code, never a user.

## Consequences

- The site uses the system font stack and looks plain. The brief says the stats page need
  not be pretty; the site follows it.
- Adding any vendor is a Build Plan change and a privacy-page change, in that order.

## Decision record

Accepted 2026-09-26 by claude when `tools/definition-apply.py` applied the definition this came from. It is a door that reaches nobody, so no decision on the Build Plan named it; the owner approved the plan it is part of.
