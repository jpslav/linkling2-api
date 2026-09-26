# ADR-0001 — Short links: the name straight after the host, six-character made-up names, editable targets, deleted names reusable

- Status: Accepted
- Approver: @jpslav
- Date: 2026-09-26

## Context

Short links are printed on slides and posters and pasted into documents the team does not
control (raw/brief.md L42–45), so the shape of a link and of a made-up name cannot change
after the first one is printed. Made-up names are read aloud and typed from slides
(L16–17). The owner's sketch shows the stats page at `/-/stats` and a made-up name
`hjkm4t`. Fixing a link that points at the wrong place is anticipated (L46–47).

Settled by the Build Plan decisions `2026-09-26-short-links/url-shape`,
`/made-up-names`, `/name-reuse` and `/fix-a-link`.

## Decision

- A short link is `<host>/<name>`. Every route the service itself serves — the API, the
  stats page, health — lives under `/-/`. A name may not start with `-`, so no name can
  ever collide with a service route, now or later.
- Chosen names: 1–64 characters of lower-case letters, digits and hyphens, not starting
  with a hyphen. Names are stored lower-case and matched without regard to case.
- Made-up names: six characters drawn uniformly from the 31-character alphabet
  `abcdefghjkmnpqrstuvwxyz23456789` (no `0 o 1 l i`), from a cryptographic random source,
  retried on collision. 31⁶ ≈ 887 million names.
- A link's target can be edited in place; its name, counts and maker stay.
- A deleted link's name is free at once and can be made again, pointing anywhere. An
  expired link keeps its name until it is deleted, because it stays listed with its counts.
- Fixed with the shape, because each is as permanent once printed: a trailing slash
  opens the same link; extra path segments answer 404; a query string on a short link is
  **not** passed on to the target, so nobody can change where a printed link lands by
  appending one; `/` answers a plain page naming the product; the API sits under
  `/-/api/`, unversioned, because the CLI ships in the same release.

## Consequences

- No service page can ever live at the root; `/privacy` on the service is impossible by
  construction, which is why the privacy page lives on the public site.
- Reusing a deleted name means an old poster can lead somewhere new; that is the cost of
  letting a team take a good name back. Fixing a link is an edit, which keeps its history;
  ADR-0002's uncached redirect is what makes either reach people who clicked before.
- Changing any of the above after release breaks printed links; `tests/url-shape.test.ts`
  pins it.

## Decision record

Accepted 2026-09-26 by @jpslav, from line comments on [the definition PR](https://github.com/jpslav/tinyworks2-program/pull/1). Written by `tools/decision-record.py`; each answer is also in its question file.

A sub-decision the body proposes that no line below names was not put to the owner: it stands as the body recommends, and a worker building on it names that choice in its plan.

- **What comes after the host in a short link?** — **A.** The name straight after the host (`/q3-plan`); the service's own pages live under `/-/` — @jpslav, 2026-09-26: "Yes" ([comment](https://github.com/jpslav/tinyworks2-program/pull/1#discussion_r4112264649)) <!-- decided: 2026-09-26-short-links/url-shape: A -->
- **What does a name Linkling makes up look like?** — **A.** Six lower-case letters and digits, without 0 o 1 l i — like `hjkm4t`, as on your sketch — @jpslav, 2026-09-26: "Yes" ([comment](https://github.com/jpslav/tinyworks2-program/pull/1#discussion_r4112266147)) <!-- decided: 2026-09-26-short-links/made-up-names: A -->
- **When a link is deleted, can its name be used again?** — **A.** Yes — a deleted name is free at once; the old link's counts are gone with it — @jpslav, 2026-09-26: "Yes" ([comment](https://github.com/jpslav/tinyworks2-program/pull/1#discussion_r4112267412)) <!-- decided: 2026-09-26-short-links/name-reuse: A -->
- **How does a team member fix a link that points at the wrong place?** — **A.** `linkling edit q3-plan <new URL>` changes the target in place; name, counts and maker stay — @jpslav, 2026-09-26: "Yes" ([comment](https://github.com/jpslav/tinyworks2-program/pull/1#discussion_r4112268858)) <!-- decided: 2026-09-26-short-links/fix-a-link: A -->
