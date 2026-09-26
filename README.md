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

The service writes no access log. Its only log lines are a server fault, as its method,
route pattern and status (`linkling: GET /:name answered 500`), and a follow whose count
could not be written. Neither says anything about the request (ADR-0004).

## Short links

`http://<host>/<name>` answers `302` to the link's target, uncached, with
`Referrer-Policy: no-referrer` and no cookie (ADR-0002, ADR-0009). A deleted or unknown
name answers a plain `404` page, and an expired one a plain `410` page. Every `GET` that
redirects counts once toward that UTC day. `HEAD`, `404` and `410` do not count, and chat
apps' link previews do (R-029).

## The API

Everything under `/-/` is the service's own; the rest is short names (ADR-0001). Every
`/-/api/` call needs `Authorization: Bearer $LINKLING_KEY`. The full contract is
[ADR-0013](docs/adr/0013-team-api.md).

| Route | Body | Answers |
|---|---|---|
| `POST /-/api/links` | `{"url", "name"?, "made_by"?, "expires"?}` | `201` link, `400`, `409` name taken |
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

## Develop

```bash
npm ci
npm run typecheck && npm run build && npm test
LINKLING_BASE=http://localhost:8080 LINKLING_KEY=... scripts/latency.sh   # R-016's p95
```

Decisions are in [docs/adr/](docs/adr/README.md).
