# linkling2-api

The Linkling service: a small link shortener a team runs for itself. It is TypeScript on
Node 24 with Fastify and SQLite (`better-sqlite3`), started with one `docker compose up`.
Nobody who follows a link is asked for anything or recorded as anything but one more in
that day's count.

Built by the second rehearsal of [auto-program](https://github.com/jpslav/auto-program). Its program repo is private.

## Run it

```bash
LINKLING_KEY=choose-a-team-key docker compose up -d --wait
curl -s http://localhost:8080/-/health          # ok
```

The service refuses to start without `LINKLING_KEY`: printable ASCII, no spaces. Links
live in a SQLite file on the named volume `linkling-data`. `docker compose down` keeps
it; `docker compose down -v` deletes every link and count.

| Variable | Default | What it is |
|---|---|---|
| `LINKLING_KEY` | none, required | The one team key (ADR-0005) |
| `PORT_BASE` | `8080` | The host port compose publishes the service on |
| `LINKLING_DATA` | `/data` in the image, `./data` otherwise | The directory holding `linkling.db` |
| `PORT` | `8080` | The port the process listens on inside the container |

Outside Docker: `npm ci && npm run build && LINKLING_KEY=... node dist/server.js`.

The service writes no access log, and handling a request writes nothing about it to any log
(`privacy-manifest.json`). It writes a line only when it will not start, when it cannot rebuild the
database file at start, or when the day's counts could not be written. A failing database
shows up as the `500`s the API answers.

A click touches no file. The service tallies follows in memory and writes the day's counts
once, five seconds after UTC midnight, and again when it stops (ADR-0014). A crash loses
that day's unwritten counts, and `docker compose down` does not.

## Short links

`http://<host>/<name>` answers `302` to the link's target, uncached, with
`Referrer-Policy: no-referrer` and no cookie (ADR-0002, ADR-0009). A deleted or unknown
name answers a plain `404` page, and an expired one a plain `410` page. Every `GET` that
redirects counts once toward that UTC day. `HEAD`, `404` and `410` do not count, and chat
apps' link previews do (R-029).

## The API

Everything under `/-/` is the service's own; the rest is short names (ADR-0001). Each route
below needs `Authorization: Bearer $LINKLING_KEY`. The full contract is
[ADR-0013](docs/adr/0013-team-api.md).

| Route | Body | Answers |
|---|---|---|
| `POST /-/api/links` | `{"url", "name"?, "made_by"?, "expires"?}` | `201` link, `400`, `409` name taken, `415` |
| `GET /-/api/links` | none | `200 {"links": [link, …]}`, newest first |
| `GET /-/api/links/:name` | none | `200` link, `404` |
| `PATCH /-/api/links/:name` | `{"url"}` | `200` link, `400`, `404` |
| `DELETE /-/api/links/:name` | none | `204`, `404` |
| `GET /-/api/links/:name/counts` | none | `200 {"name", "total", "days": [{"day", "count"}, …]}`, `404` |

A link is `{"name", "url", "made_by", "created_at", "expires_at", "expired"}`, and an
error is `{"error": "…"}`.

- **`name`**: 1–64 letters, digits and hyphens, not starting with a hyphen, stored lower-case.
  Leave it out and the service makes up six characters like `hjkm4t`.
- **`expires`**: a date `YYYY-MM-DD`, meaning the end of that day in UTC, or a lifetime such
  as `7d`, `36h`, `90m` or `30s`. Leave it out and the link never expires.

```bash
curl -s -X POST http://localhost:8080/-/api/links \
  -H "Authorization: Bearer $LINKLING_KEY" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/a","name":"q3-plan","made_by":"ana","expires":"7d"}'
```

## The `linkling` command

Everything the API does, from a terminal, with only Node and the team key. It is this
package's `bin`, so it is built and installed from here (ADR-0007, [ADR-0015](docs/adr/0015-linkling-command.md)):

```bash
npm ci && npm run build && npm install -g .    # npm links this folder: keep it, and dist/, in place
export LINKLING_BASE=http://localhost:8080     # where the service answers: an origin, no path
export LINKLING_KEY=choose-a-team-key          # the team key
linkling make https://example.com/plan --name q3-plan --expires 7d
```

After a `git pull`, `npm run build` is all the installed command needs. `npm uninstall -g
linkling-api` removes it.

| Command | Does | Prints |
|---|---|---|
| `linkling make <url> [--name <name>] [--expires <date\|lifetime>] [--by <name>]` | makes a link; without `--name` the service makes one up | the short link, `$LINKLING_BASE/<name>` |
| `linkling list` | lists every link, newest first | name, made by, expires, target |
| `linkling edit <name> <url>` | changes where a link points; its name, counts and maker stay | `<short link> -> <target>` |
| `linkling delete <name>` | deletes a link, with no confirmation question | `deleted <name>` |
| `linkling counts <name>` | shows a link's followed count for each UTC day | `<name>: <total> total`, then one line per day |

- **`--expires`** is a date `YYYY-MM-DD` (to the end of that UTC day) or a lifetime such as `7d`,
  `36h`, `90m` or `30s`; without it the link never expires, and `list` shows `never`. An expired
  link stays listed as `expired <time>`.
- **`--by`** is who made the link. Without it the command sends `$USER`, and when that is not
  set, the system's login name. Nothing checks it (ADR-0005).
- **The service decides what is valid.** The command sends names, expiries and URLs as given
  and prints the service's own sentence when it refuses one, such as
  `linkling: the name "q3-plan" is already taken (409)`.

**In scripts**, use the exit code and `--json`; the human output above can change. `--json`,
on any command, prints the service's answer as one line of JSON, unchanged
([ADR-0013](docs/adr/0013-team-api.md)'s link, `{"links": [...]}` or `{"name", "total", "days"}`);
for `delete` it prints `{"name": "<name>", "deleted": true}`. Errors are one line on stderr
beginning `linkling: `, and stdout carries only results.

| Exit | Means |
|---|---|
| 0 | done |
| 1 | the service said no: a taken name (409), no such link (404), a value it refuses (400) |
| 2 | the command line or `LINKLING_BASE`/`LINKLING_KEY` is wrong; nothing was sent |
| 3 | the team key was refused (401) |
| 4 | no usable answer: the service is not there or is silent for 10 s, redirects, fails (5xx), or is not Linkling's API |
| 70 | a bug in the command itself |

```bash
short=$(linkling make https://example.com/plan --name q3-plan) || exit
linkling counts q3-plan --json
```

## Develop

```bash
npm ci
npm run typecheck && npm run build && npm test
LINKLING_BASE=http://localhost:8080 LINKLING_KEY=... scripts/latency.sh   # R-016's p95
LINKLING_BASE=http://localhost:8080 LINKLING_KEY=... scripts/cli-e2e.sh   # R-015 against a running stack, with `linkling` on PATH
```

`scripts/cli-e2e.sh` prints `CLI E2E PASS` (exit 0) or `CLI E2E FAIL: <step>` (exit 1), and
`CLI E2E BLIND: <what was missing>` (exit 2) when there is no `linkling`, no key or address,
or no service to try it on.

Decisions are in [docs/adr/](docs/adr/README.md).
