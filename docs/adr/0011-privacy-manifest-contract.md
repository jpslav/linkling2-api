# ADR-0011 — The privacy manifest carries the page's wording, and the site's check reads it from a same-named branch on a pull request, else main

- Status: Accepted
- Approver: claude
- Date: 2026-09-26

## Context

ADR-0004 puts `privacy-manifest.json` in `linkling-api`, pins it to the schema with
`tests/privacy-manifest.test.ts`, and has `linkling-web`'s CI read it "from
`linkling-api`'s `main`" and fail when the manifest lists something the privacy page does
not. It does not say what the manifest looks like, what "the page lists it" means, or
how a change that needs both repos gets through CI. This ADR refines ADR-0004 on those
three points. It leaves the rest of ADR-0004 as it is: a page row the manifest lacks is a
warning, and the check runs daily.

Two things forced the choice. First, if the page only has to name each field and can
word it freely, a retention changed in the manifest still passes a page that says the old
one. Second, a check that reads only `main` cannot go green on a pull request that
introduces the manifest, or on any later pair of changes made together. The site's pull
request is blind until the service's pull request merges. For the first pull request in
each repo (LL-005) there is no `main` manifest at all.

This reaches no user. It is how two repos' CI agree, so it is Claude's. The privacy page's
path, `/privacy.html`, is ADR-0007's, not this one's.

## Decision

- **Shape.** `privacy-manifest.json` has four keys:
  - `about`: one sentence on what the file is.
  - `stored`: a list of entries `{ id, fields, what, kept }`. `id` is a lower-case slug,
    and `fields` lists `table.column` names.
  - `counted`: the sentence saying what one count is.
  - `logged`: the sentence saying what is logged.

  `what`, `kept`, `counted` and `logged` are the visitor-facing text itself.
- **What the service pins.** `tests/privacy-manifest.test.ts` fails unless the union of
  every entry's `fields` equals the database's columns, SQLite's own `sqlite_sequence`
  included. It also fails when a field or an id appears twice, or when an entry has no
  text. The text is not checked by the service. It is a promise, not a schema.
- **What the page carries.** `linkling-web`'s `privacy.html` carries exactly one `<tr
  data-stored="<id>">` per entry. Each has exactly two cells, `what` and `kept`, word for
  word. Exactly one element each, marked `data-manifest="counted"` and
  `data-manifest="logged"`, carries those two sentences. The check does these steps in
  order:
  1. It removes comments and `template`, `script`, `style` and `noscript` elements.
  2. It drops tags, decodes character references and collapses whitespace.
  3. It compares.

  It fails on:
  - a missing, duplicated or differing row;
  - a row with any number of cells other than two;
  - a missing, duplicated or differing statement;
  - any of those, or a table, marked `hidden`.

  It warns on a row whose id the manifest lacks (ADR-0004), and on a body row with no id
  at all. `linkling-web`'s `checks/privacy.mjs` header is the full list.
- **Where the site reads it.** On a push to `main` and on the daily run, the check reads
  `linkling-api`'s `main`. On a pull request it first tries the `linkling-api` branch
  with the same name as the pull request's head branch. It falls back to `main` only when
  that fetch answers 404. Any other failure, and a 404 from `main` itself, is BLIND
  (exit 2), never a pass. A service change and the page change it needs are made on
  branches with one name, and the service's pull request merges first.

## Consequences

- The manifest is the one source of the page's stored-data wording. Changing a retention
  or a description is a manifest change. That turns the site's daily run red until the
  page says the same.
- **A green site pull request proves nothing about `main`** while a same-named service
  branch exists. It proves the page matches that branch's manifest. If the site's pull
  request merges first, the site's next push to `main` and its daily run read the
  service's `main`. They fail until the service's pull request merges, so the gap is
  visible, not silent.
- Neither repo deletes a branch when its pull request merges. `delete_branch_on_merge`
  is `false` on both (`gh api repos/jpslav/linkling2-api --jq .delete_branch_on_merge`).
  So a merged service branch keeps answering the site's pull requests of that name until
  someone deletes it. That is harmless while its manifest equals `main`'s. Delete the
  service branch after it merges, and after that the site's runs get a 404 for it and
  read `main`.
- A site branch that happens to share a name with an unrelated `linkling-api` branch
  compares against that branch's manifest. If that manifest is missing the fetch is
  BLIND. If it is older or newer, the check may fail or warn about differences the site
  branch did not cause. The branch naming convention (`<prefix>/<item-id>-…`) makes that
  unlikely. The remedy is to rename the site branch.
- Alternatives considered:
  - **Reading `main` only**, as ADR-0004 first said. It deadlocks every paired change
    until the service merges.
  - **Pinning a commit SHA in the site repo.** It is reproducible, but the daily run would
    never see `main` move, which is the drift that run exists to catch.
  - **Vendoring a copy of the manifest into the site.** That makes two copies of one
    promise.
  - **A page that names fields with free wording.** A changed retention would pass
    unnoticed.
