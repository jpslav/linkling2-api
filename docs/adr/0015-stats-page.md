# ADR-0015 — The stats page is server-rendered at /-/stats, loads only its own /-/stats.css and /-/stats.js, and takes the public site's address from LINKLING_SITE

- Status: Accepted
- Approver: claude
- Date: 2026-09-26

## Context

The owner's sketch puts the stats page at `/-/stats`, behind the team key, with a filter that
narrows the list as you type (R-010 to R-013). ADR-0001 puts every service route under `/-/`;
ADR-0005 has the browser ask for the key with its own Basic prompt and sets no cookie; ADR-0008
lets nothing from another origin into the product. The footer links to the one privacy page,
on the public site (PRODUCT.md "Contradictions"), but this run gives that site no address.

## Decision

- `GET /-/stats` is HTML rendered by the service from the link store, reading counts only
  through `LinkStore.dailyCounts` (ADR-0014). Every name, target and maker is HTML-escaped.
- The page loads two files and nothing else: `/-/stats.css` and `/-/stats.js`, served by the
  same process from strings in `src/stats.ts`. All three routes sit under `/-/`, so the
  team-key guard covers them without any change to `OPEN`. Each answer carries
  `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; …`,
  `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`.
- Without the script every link is still listed; the script adds the filter and Copy, which
  copies `location.origin + "/" + name`, the address the browser reached the service at.
- `LINKLING_SITE`, optional, is the public site's address; the Privacy link is
  `$LINKLING_SITE/privacy.html` (the path is ADR-0007's). Unset or empty, it is the page's
  source in the public repo (run decision 2026-09-26 in the program's `DECISIONS.md`). A value
  that is not a plain http or https address stops the service at start.

Alternatives: a page built by a script from `/-/api/links` plus a new bulk-counts endpoint —
it changes the API and shows nothing without the script. Inline CSS and script under CSP
hashes — the hashes must be redone on every edit, more moving parts than two routes. A
hard-coded site address — there is none to hard-code yet. A copy of the privacy page on the
service — two copies of a promise are two chances to disagree.

## Consequences

- A later service page follows the same shape: HTML from the server, same-origin assets under
  `/-/`, a CSP of `'self'`.
- The page makes one counts read per link; for one team's links that is cheap, and a bulk
  read can replace it without changing anything a team member sees.
- When the public site gets an address, a team sets `LINKLING_SITE` and restarts.
- Playwright (already ADR-0006's) runs in CI; `ci.yml` installs Chromium before the tests.
