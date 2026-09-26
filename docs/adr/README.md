<!-- adr-index:start -->
| # | Title | Status |
| --- | --- | --- |
| [0001](0001-short-link-shape.md) | Short links: the name straight after the host, six-character made-up names, editable targets, deleted names reusable | Accepted |
| [0002](0002-redirect.md) | Short links answer with an uncached 302 | Accepted |
| [0003](0003-data-model.md) | Data model: a links table and a daily-counts table, links forever by default | Accepted |
| [0004](0004-what-is-stored.md) | What is stored and logged, for how long, and how the privacy page is kept true | Accepted |
| [0005](0005-team-key.md) | One team key; "Made by" is a name the maker gives | Accepted |
| [0006](0006-hosting-topology.md) | Hosting topology: one service container and a SQLite volume | Accepted |
| [0007](0007-repo-layout.md) | Repo layout: service and CLI in linkling-api, static site in linkling-web | Accepted |
| [0008](0008-third-party-services.md) | No third-party services, in the product or on the public site | Accepted |
| [0009](0009-redirect-header-allowlist.md) | The redirect's response headers are an allowlist, pinned by a test | Accepted |
| [0010](0010-migrations-user-version.md) | Migrations are numbered SQL files tracked by PRAGMA user_version, with no migrations table | Accepted |
| [0011](0011-privacy-manifest-contract.md) | The privacy manifest carries the page's wording, and the site's check reads it from a same-named branch on a pull request, else main | Accepted |
| [0012](0012-deleted-means-gone.md) | Deleted link data is overwritten, not just unlisted: secure_delete is on and the WAL is truncated after a delete | Accepted |
| [0013](0013-team-api.md) | The team API under /-/api/: routes, JSON fields and errors | Accepted |
| [0014](0014-counts-written-daily.md) | A click touches no file; the day's counts are written once, after the day | Accepted |
| [0015](0015-stats-page.md) | The stats page is server-rendered at /-/stats, loads only its own /-/stats.css and /-/stats.js, and takes the public site's address from LINKLING_SITE | Accepted |
| [0016](0016-linkling-command.md) | The linkling command: commands, environment, output and exit codes that scripts can rely on | Accepted |
<!-- adr-index:end -->
