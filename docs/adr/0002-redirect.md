# ADR-0002 — Short links answer with an uncached 302

- Status: Accepted
- Approver: @jpslav
- Date: 2026-09-26

## Context

Browsers cache a 301 or 308 indefinitely, so a link that is later deleted, or deleted and
made again, keeps sending people who clicked it before to the old target — which the brief
names as the thing to decide deliberately (raw/brief.md L46–48). Every click must also be
counted (L24), which a cached redirect would silently skip.

Settled by the Build Plan decision `2026-09-26-short-links/redirect`.

## Decision

A live short link answers `302 Found` with `Location: <target>`,
`Cache-Control: private, no-store` and `Referrer-Policy: no-referrer` — so the target is
not told which chat or document the click came from. It sets no cookie, and carries no
other header a framework adds by default without that header being reviewed here. An expired link answers `410 Gone`
and a deleted or unknown one `404 Not Found`, each with a short plain page and no
`Location` header.

## Consequences

- Every click reaches the service, so every click is counted and every fix or delete takes
  effect on the next click.
- A repeat click costs one round trip to the service that a permanent redirect would have
  saved; R-016's 50 ms budget is set against that.
- Switching to a permanent redirect later is possible; switching back is not, for anyone
  who clicked in between.

## Decision record

Accepted 2026-09-26 by @jpslav, from line comments on [the definition PR](https://github.com/jpslav/tinyworks2-program/pull/1). Written by `tools/decision-record.py`; each answer is also in its question file.

A sub-decision the body proposes that no line below names was not put to the owner: it stands as the body recommends, and a worker building on it names that choice in its plan.

- **Which redirect does a short link answer with?** — **A.** 302, marked not to be cached — every click asks the service again, so fixes and deletes reach everyone — @jpslav, 2026-09-26: "Yes" ([comment](https://github.com/jpslav/tinyworks2-program/pull/1#discussion_r4112267921)) <!-- decided: 2026-09-26-short-links/redirect: A -->
