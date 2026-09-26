# ADR-0016 — The linkling command: commands, environment, output and exit codes that scripts can rely on

- Status: Accepted
- Approver: claude
- Date: 2026-09-26

## Context

The brief says most of the team will use the CLI more than anything else (LL-002), and
`demo.sh` (LL-004) and any script a team member writes will drive it. ADR-0007 put the CLI in
this package, `src/cli.ts`, installed with `npm install -g`; the Build Plan's Tech section
chose Node's own argument parser and `fetch`. R-015's verify line fixes the verbs and their
argument order, R-001's fixes `LINKLING_BASE` and `LINKLING_KEY`, R-008's fixes that the
login name is sent, ADR-0001 names `linkling edit <name> <url>` and the Build Plan's counts
decision (`products/linkling/gates/irreversibles.md`, "The one metric: what a count is", in the
program repo) names `linkling counts <name>`. Everything else about the command was open, and once scripts
depend on it the rest is as hard to change as the API. It reaches team members (the plan
review classified it `users`, covered by R-015); the owner reviews it through the run report.

## Decision

**Commands.** Each takes `--json`, and `-h` or `--help` prints the usage.

| Command | Prints on stdout |
|---|---|
| `linkling make <url> [--name <name>] [--expires <date\|lifetime>] [--by <name>]` | the short link, `$LINKLING_BASE/<name>` |
| `linkling list` | a table: name, made by (`-` when empty), expires (`never`, the time, or `expired <time>`), target |
| `linkling edit <name> <url>` | `<short link> -> <target>` |
| `linkling delete <name>` | `deleted <name>`, with no confirmation question |
| `linkling counts <name>` | `<name>: <total> total`, then one `<UTC day>  <count>` line per day, oldest first |

**`--json`** prints the API's answer as one line of JSON, unchanged: the link for `make` and
`edit`, `{"links": [...]}` for `list`, `{"name", "total", "days"}` for `counts`. `delete` has
no body to echo, so it prints `{"name": "<name>", "deleted": true}`. The human output above is
not promised stable; `--json` and the exit codes are.

**Configuration** is the environment: `LINKLING_BASE`, the origin the service answers on
(http or https, no path; required, no default), and `LINKLING_KEY`, the team key (required, and
usable as a header value, by the service's own `keyProblem`). There is no config file and no
flag for either.

**`made_by`** is `--by`, else `$USER`, else the system's login name, else the command refuses
and asks for `--by` (R-008).

**The command does not validate what the service validates.** A name, an expiry and a URL go to
the API as given, and the API's own sentence is what is printed, so the two cannot drift. It
checks only its own environment and arguments: the argument count, a blank `--by`, and `.` and
`..` as names, which are dot segments in a URL path.

**Exit codes.**

| Code | Meaning |
|---|---|
| 0 | done |
| 1 | the service said no: any 4xx but 401, with its own sentence, e.g. `the name "q3-plan" is already taken (409)` |
| 2 | the command line or the environment is wrong; nothing was sent |
| 3 | the key was refused (401) |
| 4 | no usable answer: unreachable, no answer in 10 s, a redirect (never followed), a 5xx, or an answer that is not Linkling's API, so a wrong `LINKLING_BASE` is neither a pass nor a crash |
| 70 | a bug in the command itself, or output it cannot write |

The one answer with nothing in it to check is a `204` to a `delete`, which is taken as done
whoever sends it (`tests/cli.test.ts`). An error goes to stderr, its first line beginning
`linkling: ` (a wrong command line adds the usage after it); stdout carries only results.

Rejected:

- A config file such as `~/.config/linkling`: a second place a key sits and a second thing to
  explain (principle small-over-clever).
- A `--key` flag: a key on the command line shows in `ps` and in shell history. A `--base` flag
  would be a second way to say what `LINKLING_BASE` already says.
- A default `LINKLING_BASE` of `http://localhost:8080`: it could quietly aim at a stale stack,
  and adding a default later is additive where removing one breaks scripts.
- One non-zero exit code for every failure: `demo.sh` could not tell a refused key from a dead
  service.
- Validating names, expiries and URLs in the command: a second copy of ADR-0013's rules.
- Following redirects: `fetch` answers a POST's 301 or 302 with a GET.

## Consequences

- Renaming a command or flag, changing the environment variable names, the `--json` shape or an
  exit code breaks scripts. Additive changes (a new command, a new flag, a new field in
  `--json` because the API gained one) are safe.
- The command is one file with no dependency but Node and `src/team-key.ts`, so it starts
  without loading the service (`tests/cli.test.ts` walks its imports). It is installed with
  `npm ci && npm run build && npm install -g .`: npm links the package folder, so the build must
  stay in place, and there is no `prepare` script because `Dockerfile` runs `npm ci` (line 13)
  before it copies `src` (line 15), where a `prepare: tsc` fails: `npm ci` exits 1 in a
  directory holding only `package.json` and the lockfile.
- `tests/cli.test.ts`, `tests/cli-bin.test.ts` and `tests/made-by.test.ts` exercise the above;
  `scripts/cli-e2e.sh` checks it against a running stack.
- A team that fronts the service on a path (`https://host/linkling/`) cannot use it: the
  address is an origin. The short-link shape (ADR-0001) already puts names straight after the
  host, so a path prefix was not a supported deployment.
