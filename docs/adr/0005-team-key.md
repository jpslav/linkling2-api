# ADR-0005 — One team key; "Made by" is a name the maker gives

- Status: Accepted
- Approver: @jpslav
- Date: 2026-09-26

## Context

The brief asks for one team API key for making, deleting and listing, and nothing for
following a link (raw/brief.md L29), and faults hosted shorteners for wanting an account
per person (L8). The sketch has a "Made by" column and the brief speaks of deleting "a
link they made" (L23). One shared key cannot tell people apart.

Settled by the Build Plan decision `2026-09-26-team-key/key-model`.

## Decision

- One key, set as `LINKLING_KEY` in the compose environment; the service refuses to start
  without it. API calls send it as `Authorization: Bearer <key>`; the stats page takes it
  through the browser's HTTP Basic prompt as the password, with any user name. Keys are
  compared in constant time.
- `made_by` is a free-text name supplied when a link is made; the CLI sends the local login
  name unless `--by` says otherwise. The service does not check it.
- Any key holder can delete any link. There is one team per deployment; there is no
  tenancy inside one.
- Following a link needs no key and sets no cookie.

## Consequences

- Rotating the key means changing one environment variable and restarting; every team
  member updates their CLI config.
- "Made by" can be wrong if someone types another name. For a team that shares one key
  already, that is accepted.
- Keys per person, if ever wanted, add a table and change who may delete; links already
  made keep their `made_by` text.

## Decision record

Accepted 2026-09-26 by @jpslav, from line comments on [the definition PR](https://github.com/jpslav/tinyworks2-program/pull/1). Written by `tools/decision-record.py`; each answer is also in its question file.

A sub-decision the body proposes that no line below names was not put to the owner: it stands as the body recommends, and a worker building on it names that choice in its plan.

- **Who can delete a link, and what does "Made by" show?** — **A.** One team key; "Made by" is a name the maker gives (the CLI uses their login); anyone with the key can delete any link — @jpslav, 2026-09-26: "Yes" ([comment](https://github.com/jpslav/tinyworks2-program/pull/1#discussion_r4112269457)) <!-- decided: 2026-09-26-team-key/key-model: A -->
