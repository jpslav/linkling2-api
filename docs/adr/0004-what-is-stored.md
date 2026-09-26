# ADR-0004 — What is stored and logged, for how long, and how the privacy page is kept true

- Status: Accepted
- Approver: @jpslav
- Date: 2026-09-26

## Context

What is stored about clicks is "a promise to people who never agreed to anything" (raw/brief.md
L49–51), and the privacy page must say exactly what is stored and for how long, matching
what the service really keeps (L36–38). The default for most web servers is an access
log line per request carrying the client's IP address, which would break that promise
without any code anyone wrote on purpose.

Settled by the Build Plan decisions `2026-09-26-what-is-stored/count-retention` and
`/what-counts`.

## Decision

⚠️ **Decided 2026-09-26** — the owner chose differently from what is proposed below (count-retention). The *Decision record* at the end is what was decided, and where the two disagree it wins.

- Stored about a click: which link, the UTC day, and that day's count. Nothing else,
  anywhere.
- A count is a `GET` that is redirected. `HEAD`, 404 and 410 are not counted. Nothing about
  the request — address, browser name, referrer — is read to decide, so chat-app link
  previews count like anyone else, and the stats page and privacy page both say so.
- Stored about a link: its name, target, the maker's name as given, when it was made, and
  its expiry.
- Kept: a link's name, target, maker, creation time and expiry until the link is deleted;
  its daily counts forever, including after the link is deleted. A deleted link's counts
  stay tied to its internal id and to no name, so a link made later under the same name
  starts from zero, and they are shown nowhere (ADR-0003).
- Logged: no access log at all. Application logs never include a request's IP address,
  user agent, referrer or headers; errors log the route and the status only.
- `linkling-api` carries `privacy-manifest.json`, the list of every stored field with its
  retention. `tests/privacy-manifest.test.ts` fails if the schema holds a column the
  manifest does not list, or the manifest lists one the schema lacks.
- `linkling-web`'s privacy page carries that list as a table, and its CI reads the
  manifest from `linkling-api`'s `main` and fails if the manifest lists anything the page
  does not (stored but not promised); a page row the manifest lacks is a warning, so the
  page can be changed first, as the principle asks, without turning its own trunk red.
- The page states its scope: what the Linkling service stores. At launch, the proxy in
  front of the service and the host serving the site each keep their own logs; whether
  those log addresses is a launch decision, listed in the end review.

## Consequences

- The privacy page cannot silently fall behind the service: a new column fails the service's
  tests until the manifest names it, and the manifest change fails the site's CI until the
  page says it. `linkling-web`'s check also runs daily, so a manifest change made first
  shows as a red run within a day, rather than surfacing at the site's next pull request.
- Without access logs, debugging a bad request means reproducing it; that is the price of
  the promise.
- Collecting anything more later is a privacy-page change first, by construction.

## Decision record

Accepted 2026-09-26 by @jpslav, from line comments on [the definition PR](https://github.com/jpslav/tinyworks2-program/pull/1). Written by `tools/decision-record.py`; each answer is also in its question file.

A sub-decision the body proposes that no line below names was not put to the owner: it stands as the body recommends, and a worker building on it names that choice in its plan.

- **How long are a link's daily counts kept?** — **C.** Forever, even after the link is deleted — @jpslav, 2026-09-26: "This" ([comment](https://github.com/jpslav/tinyworks2-program/pull/1#discussion_r4112270034)) <!-- decided: 2026-09-26-what-is-stored/count-retention: C -->
  *Not the recommendation, which was A.*
- **What counts as one use of a link?** — **A.** Every followed link, previews included; nothing about the visitor is read; both pages say so — @jpslav, 2026-09-26: "accepted by approval, not individually — "Approved"" ([comment](https://github.com/jpslav/tinyworks2-program/pull/1#discussion_r4112401139)) <!-- decided: 2026-09-26-what-is-stored/what-counts: A -->
