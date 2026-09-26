# ADR-0013 — The team API under /-/api/: routes, JSON fields and errors

- Status: Accepted
- Approver: claude
- Date: 2026-09-26

## Context

ADR-0001 put the API under `/-/api/`, unversioned, because the CLI ships in the same
release. It did not say what the API is. The CLI (LL-002), the stats page (LL-008) and
anyone scripting against the service with curl all speak it. Several requirements' verify
lines already fix parts of it:

- R-001 posts `{"url","name"}` and reads `.name`.
- R-003 expects a 409.
- R-006 reads `expires_at`.
- R-008 sends `made_by`.

The rest was open. The owner reviews this through the run report, as
jpslav/linkling2-api#8's plan said. The plan reviewer's classification there was that the
contract reaches team members and is covered by R-001.

## Decision

Every route needs `Authorization: Bearer <key>` (ADR-0005, enforced by the guard in
`src/app.ts`). Bodies and answers are JSON with snake_case fields.

| Route | Body | Success | Errors |
|---|---|---|---|
| `POST /-/api/links` | `{"url", "made_by"?, "name"?, "expires"?}` | `201` and the link | `400`, `409` name taken |
| `GET /-/api/links` | none | `200 {"links": [link, …]}`, newest first | none |
| `GET /-/api/links/:name` | none | `200` and the link | `404` |
| `PATCH /-/api/links/:name` | `{"url"}` only | `200` and the link | `400`, `404` |
| `DELETE /-/api/links/:name` | none | `204` | `404` |
| `GET /-/api/links/:name/counts` | none | `200 {"name", "total", "days": [{"day", "count"}, …]}`, oldest day first | `404` |

A link is `{"name", "url", "made_by", "created_at", "expires_at", "expired"}`. Times are
UTC ISO 8601, and `expires_at: null` means never. The internal id is never shown
(ADR-0004).

The first four points below are what R-001 to R-028's verify lines already fix. The rest
go beyond them, one decision apiece:

- `url`, `name`, `made_by`, `expires_at` and the 409 on a taken name, from the verify lines
  above.
- `:name` in a path is folded to lower case, as the redirect folds it, so `Q3-Plan` edits
  `q3-plan` (R-004). A path name that is not a name is a 404, like an unknown one.
- Errors are `{"error": "<sentence>"}`. The 409 names the clash:
  `the name "q3-plan" is already taken`. The 401 stays the guard's plain-text page, which is
  shared with the stats page (ADR-0005).
- Every API answer carries `Cache-Control: no-store`.
- **`expired`** is computed with the same rule the redirect uses, so the CLI and the stats
  page never re-derive it.
- **`GET /-/api/links/:name`** reads one link.
- **`/counts`** is its own route rather than a field of every listed link, so a list does
  not join over all of history. The stats page runs in the same process and can read the
  store directly.
- **`url` is `http:` or `https:` only, at most 2,048 characters once encoded,** and is
  stored in the URL parser's encoded form (`new URL(url).href`). A short link can then
  never answer with a `javascript:` Location, nor with a header Node refuses to send.
- **`made_by` is optional; absent, it is stored and shown as the empty string.** R-001's
  verify line sends none and must pass. `made_by` is `NOT NULL` (ADR-0003), and the
  service does not check who it names (ADR-0005), so it stores what it was given: nothing.
  It never invents a name such as `api`. The CLI always sends one, the login name unless
  `--by` says otherwise (R-008). Given, it is trimmed, at most 64 characters, and has no
  control characters. A link made through the raw API with no `made_by` therefore shows
  an empty Made-by. That is at odds with R-008's plain statement, "every link shows who
  made it", and the stats page should show that value deliberately (a dash, say) rather
  than leaving a gap that looks like a fault.
- **A body field the route does not know is a 400 naming it,** so a typo like `expiry` is
  refused rather than silently dropped. Fastify's default schema validation removes unknown
  properties and coerces types (`@fastify/ajv-compiler` defaults `removeAdditional: true`,
  `coerceTypes: 'array'`), which is why `src/api-input.ts` checks bodies by hand.
- **`expires` is a date `YYYY-MM-DD`, meaning the end of that UTC day
  (`…T23:59:59.999Z`, ADR-0003), or a lifetime `<n><unit>`** from now, with `n` from 1
  to 999999 and the unit `s`, `m`, `h` or `d`. R-005 names `7d`, and its verify line needs
  two seconds. `null` or absent means forever. An expiry already past is a 400, and
  today's date is allowed, since it lasts until the day ends.

Rejected:

- `PUT` with the whole link. Only the target may change (Build Plan decision
  `2026-09-26-short-links/fix-a-link`, A).
- Addressing links by id. The id is shown nowhere (count-retention C), and the name is
  what people know and type.
- Counts embedded in each listed link. Every list would read all of `daily_counts`.
- camelCase. The verify lines already fix snake_case.
- A default `made_by` such as `api` or `unknown`. It would put a name nobody gave into the
  Made-by column.
- Fastify's JSON schema for bodies. See above.

## Consequences

- LL-002's CLI and LL-008's stats page build on this shape. Because the API is
  unversioned, a change to it lands in the same release as the CLI, and a script someone
  wrote against it may break. Additive fields are safe; renaming one is not.
- A lifetime unit longer than a day (`w`, `y`) is a later, additive change.
- `tests/api.test.ts`, `tests/name-clash.test.ts`, `tests/edit.test.ts`,
  `tests/made-by.test.ts`, `tests/counts.test.ts` and `tests/delete.test.ts` pin the shapes
  above.
