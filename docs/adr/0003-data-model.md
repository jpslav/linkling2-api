# ADR-0003 — Data model: a links table and a daily-counts table, links forever by default

- Status: Accepted
- Approver: @jpslav
- Date: 2026-09-26

## Context

The service stores links and one count per link per day, and nothing else (raw/brief.md
L24–26). SQLite is the owner's choice (L55). A link may expire; what happens when nobody
gives an expiry was left open (L20–22). The stats page shows expired links with their old
counts (the sketch).

Settled by the Build Plan decision `2026-09-26-link-lifetime/default-lifetime`; what is
stored about clicks, and for how long, is ADR-0004.

## Decision

Two tables, in one SQLite file on a named compose volume:

- `links(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, target TEXT NOT NULL,
  made_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NULL)` — times in UTC,
  ISO 8601. `expires_at` NULL means the link never expires, which is what a link made with
  no expiry gets; an expiry given as a date is stored as the end of that UTC day.
- `daily_counts(link_id INTEGER NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (link_id, day))` — `day` is the UTC calendar date. A click is one upsert
  incrementing that row. Counts hang off the internal id, never the name, so a reused
  name can never inherit an old link's counts. There is deliberately no foreign key:
  counts outlive their link (ADR-0004), and `AUTOINCREMENT` guarantees SQLite never hands
  a deleted link's id to a new one, which plain `INTEGER PRIMARY KEY` does not.

Deleting a link deletes its `links` row and leaves its counts, which then belong to no
name and are shown nowhere; editing a link changes only `target`. SQLite runs in WAL mode. Schema changes go through numbered migrations run at
start-up.

An append-only table of click events was rejected: one row per click is a record of an
individual click, which is more than the privacy promise allows even without an address.

The daily count is the only metric the product has; there are no event names to fix.

## Consequences

- Nothing in the schema can hold an IP address, browser or referrer; adding a column that
  could is a privacy-page change first (ADR-0004), and `tests/privacy-manifest.test.ts`
  fails until the manifest is updated with it.
- A link made without an expiry keeps working for as long as the service runs.
- `daily_counts` only grows: at most one row per link per day, deleted links included.
  For a team's links that is small for decades.
- One write per click on SQLite is ample for a team; it would be the first thing to
  revisit at thousands of clicks a second, which is not this product.

## Decision record

Accepted 2026-09-26 by @jpslav, from line comments on [the definition PR](https://github.com/jpslav/tinyworks2-program/pull/1). Written by `tools/decision-record.py`; each answer is also in its question file.

A sub-decision the body proposes that no line below names was not put to the owner: it stands as the body recommends, and a worker building on it names that choice in its plan.

- **How long does a link last when whoever made it gave no expiry?** — **A.** Forever — a link without an expiry never expires — @jpslav, 2026-09-26: "Yes" ([comment](https://github.com/jpslav/tinyworks2-program/pull/1#discussion_r4112263545)) <!-- decided: 2026-09-26-link-lifetime/default-lifetime: A -->
