#!/usr/bin/env bash
# LL-004: the whole product, walked through from nothing (R-027).
#
#   ./demo.sh
#
# Starts the stack in a compose project of its own, then: makes a link, follows it, shows its
# count on the stats page and from the `linkling` command, makes a link that expires in 3 s,
# follows it, waits past its expiry and follows it again, which must answer 410. Each step
# prints its name. The last line is `DEMO OK` (exit 0), or `DEMO FAILED at step: <the step>`
# (exit non-zero) for the first step that did not do what it should.
#
# Whatever happens, the way out runs `docker compose down -v` on its own project, so no
# container, network, volume or image of the demo is left, and it checks that none is (a run
# that got that far but could not clean up after itself fails at the step "tear down").
#
# Needs Docker with Compose, Node 24.2 or newer, npm, curl, python3, and a network: the image is
# built (Docker Hub, npm), `npm ci` runs when node_modules/ is missing, and linkling-web is
# cloned from GitHub (so git too) unless it is found beside this checkout or LINKLING_WEB is set.
# Apart from that, it writes only this checkout's node_modules/ and dist/, its own temp
# directory, and Docker's build cache and pulled base image, which stay so the next run is quick.
# It sends requests only to the stack it starts and to its own static server, and never follows
# a redirect: LINKLING_BASE and LINKLING_SITE are set here whatever they were in the environment.
#
#   LINKLING_KEY      the team key; a random one is made when this is unset
#   PORT_BASE         the host port for the service (compose.yaml's); a free one when unset
#   LINKLING_WEB      a directory holding the public site (index.html, privacy.html); by default
#                     ../linkling-web when it is there, else a shallow clone of the public repo
#   DEMO_BREAK_AFTER  text: right after the first step whose name contains it, the stack is
#                     stopped (`docker compose stop`), so the step after it fails. That is how to
#                     see the failing arm: DEMO_BREAK_AFTER=follow ./demo.sh. Text that stops
#                     nothing (a typo, or only the last step's name) fails the run.
set -euo pipefail
set -o errtrace
# A reader that goes away (`./demo.sh | head`, or `| tee` and Ctrl-C) must not kill this script
# with SIGPIPE before it tears the stack down: a write to it fails instead, and that is a failure
# like any other.
trap '' PIPE

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"

CURRENT_STEP="set up"
STEPS_RUN=0
PROJECT="linkling-demo-$$-$RANDOM"
WORK=""
STACK_STARTED=0
WEB_PID=""
BROKEN=0
LIFETIME=3 # seconds the expiring link lives

# Whatever is in the user's curl config or proxy settings, curl here asks only this machine.
curl() { command curl -q --noproxy '*' "$@"; }
export NO_PROXY="127.0.0.1${NO_PROXY:+,$NO_PROXY}" no_proxy="127.0.0.1${no_proxy:+,$no_proxy}"

# Output the demo makes about itself.
step() {
  break_after_previous_step
  CURRENT_STEP=$1
  STEPS_RUN=$((STEPS_RUN + 1))
  echo "==> $1"
}
say() { echo "  $*"; }
die() {
  echo "  FAIL: $*"
  exit 1
}

# `docker compose stop`, once, right after the step DEMO_BREAK_AFTER names.
break_after_previous_step() {
  if [ "$BROKEN" = 0 ] && [ "$STEPS_RUN" -gt 0 ] && [ -n "${DEMO_BREAK_AFTER:-}" ]; then
    case "$CURRENT_STEP" in
      *"$DEMO_BREAK_AFTER"*)
        BROKEN=1
        echo "  DEMO_BREAK_AFTER=$DEMO_BREAK_AFTER: stopping the stack after the step \"$CURRENT_STEP\""
        dc stop >/dev/null 2>&1 || true
        ;;
    esac
  fi
}

dc() { docker compose -p "$PROJECT" -f "$ROOT/compose.yaml" "$@"; }

# run_quiet <log> <command...>: the command's output goes to $WORK/<log>; the tail of it is shown
# when the command fails.
run_quiet() {
  local log=$WORK/$1
  shift
  if ! "$@" >"$log" 2>&1; then
    tail -n 25 "$log" | sed 's/^/    | /'
    return 1
  fi
}

# free_port: a port nothing is listening on right now.
free_port() {
  python3 -c 'import socket; s = socket.socket(); s.bind(("", 0)); print(s.getsockname()[1])'
}

cli() { node "$ROOT/dist/cli.js" "$@"; }

# follow <url>: one request, never followed on; sets STATUS and LOCATION.
follow() {
  local out
  out=$(curl -s -o /dev/null --max-time 5 -w '%{http_code} %{redirect_url}' "$1") || die "curl could not get $1 (curl exit $?)"
  STATUS=${out%% *}
  LOCATION=${out#* }
}

# total_on_stats_page <name>: the Total column of the name's row on the stats page.
total_on_stats_page() {
  local status row total
  status=$(curl -s --max-time 5 -o "$WORK/stats.html" -w '%{http_code}' -u ":$LINKLING_KEY" "$BASE/-/stats") || die "curl could not get $BASE/-/stats (curl exit $?)"
  [ "$status" = 200 ] || die "$BASE/-/stats answered $status, not 200"
  row=$(grep "data-name=\"$1\"" "$WORK/stats.html" || true)
  [ -n "$row" ] || die "the stats page has no row for $1"
  total=$(printf '%s' "$row" | sed -n 's/.*<td class="total">\([0-9][0-9]*\)<\/td>.*/\1/p')
  [ -n "$total" ] || die "no count in the stats page's row for $1: $row"
  TOTAL=$total
}

# The way out, however it comes: tear the stack down, then say how it went, last.
finish() {
  local rc=$?
  set +e
  # A second Ctrl-C must not stop the teardown halfway (children inherit the ignore, so
  # `docker compose down` finishes too).
  trap '' INT TERM HUP
  trap - EXIT ERR
  if [ "$rc" -ne 0 ] && [ "$STACK_STARTED" = 1 ]; then
    # The service logs only when it will not start or cannot write its counts (README), so this is often empty.
    local service_log
    service_log=$(dc logs --no-color --tail 20 2>&1)
    if [ -n "$service_log" ]; then
      echo "  the service's own log, last lines:"
      printf '%s\n' "$service_log" | sed 's/^/    | /'
    fi
  fi
  if [ -n "$WEB_PID" ]; then
    kill "$WEB_PID" 2>/dev/null
    wait "$WEB_PID" 2>/dev/null
  fi
  if [ "$STACK_STARTED" = 1 ]; then
    echo "==> tear down (docker compose down -v)"
    local torn_down=1
    if dc down -v --rmi local --remove-orphans >"$WORK/down.log" 2>&1; then
      local left
      left=$(
        docker ps -a -q --filter "name=$PROJECT"
        docker volume ls -q --filter "name=$PROJECT"
        docker network ls -q --filter "name=$PROJECT"
        docker images -q --filter "reference=$PROJECT*"
      )
      if [ -n "$left" ]; then
        echo "  something of $PROJECT is still there after docker compose down -v"
        torn_down=0
      fi
    else
      tail -n 10 "$WORK/down.log" | sed 's/^/    | /'
      torn_down=0
    fi
    # A run that got this far cleanly but could not clean up after itself did not succeed.
    if [ "$torn_down" = 0 ] && [ "$rc" -eq 0 ]; then
      rc=1
      CURRENT_STEP="tear down"
    fi
  fi
  [ -z "$WORK" ] || rm -rf "$WORK"
  if [ "$rc" -eq 0 ]; then
    echo "DEMO OK"
  else
    echo "DEMO FAILED at step: $CURRENT_STEP"
  fi
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT TERM HUP
trap 'echo "  command failed (exit $?): $BASH_COMMAND"' ERR

# After the traps, so that a temp directory that cannot be made still ends in DEMO FAILED.
WORK=$(mktemp -d "${TMPDIR:-/tmp}/linkling-demo.XXXXXX")

echo "Linkling demo: the whole product, from nothing."

step "check the tools"
for tool in docker node npm curl python3; do
  command -v "$tool" >/dev/null || die "$tool is not installed"
done
docker info >/dev/null 2>&1 || die "Docker is not running (docker info fails)"
docker compose version >/dev/null 2>&1 || die "docker compose is not available"
# package.json's engines says >=24.2, and the command's `import.meta.main` needs it: an older Node
# runs dist/cli.js and prints nothing.
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 24 || (major === 24 && minor >= 2) ? 0 : 1)' \
  || die "Node 24.2 or newer is needed (package.json engines), found $(node -v)"
say "docker $(docker version --format '{{.Server.Version}}'), node $(node -v), npm $(npm -v)"

step "build the linkling command from this checkout"
[ -d node_modules ] || run_quiet npm-ci.log npm ci --no-audit --no-fund || die "npm ci failed"
run_quiet build.log npm run build || die "npm run build failed"
[ -f dist/cli.js ] || die "npm run build left no dist/cli.js"
say "node dist/cli.js, no global install"

step "serve the public site (linkling-web) on a throwaway local port"
if [ -n "${LINKLING_WEB:-}" ]; then
  WEB=$LINKLING_WEB
  say "using LINKLING_WEB=$WEB"
elif [ -f "$ROOT/../linkling-web/privacy.html" ]; then
  WEB=$ROOT/../linkling-web
  say "using the checkout beside this one: $WEB"
else
  command -v git >/dev/null || die "git is not installed, and linkling-web was not found (set LINKLING_WEB)"
  say "cloning https://github.com/jpslav/linkling2-web (nothing beside this checkout, no LINKLING_WEB)"
  GIT_TERMINAL_PROMPT=0 run_quiet clone.log git clone --depth 1 --quiet https://github.com/jpslav/linkling2-web.git "$WORK/linkling-web" || die "could not clone linkling-web"
  WEB=$WORK/linkling-web
fi
[ -f "$WEB/privacy.html" ] || die "$WEB has no privacy.html"
SITE_PORT=$(free_port)
python3 -m http.server "$SITE_PORT" --bind 127.0.0.1 --directory "$WEB" >"$WORK/site.log" 2>&1 &
WEB_PID=$!
export LINKLING_SITE="http://127.0.0.1:$SITE_PORT"
tries=0
until [ "$(curl -s -o /dev/null --max-time 2 -w '%{http_code}' "$LINKLING_SITE/privacy.html" || true)" = 200 ]; do
  tries=$((tries + 1))
  [ "$tries" -lt 25 ] || die "$LINKLING_SITE/privacy.html did not answer 200 (see the static server's log: $(tail -n 3 "$WORK/site.log"))"
  sleep 0.2
done
say "$LINKLING_SITE serves privacy.html"

step "start the stack and wait until it is healthy"
if [ -z "${LINKLING_KEY:-}" ]; then
  LINKLING_KEY=$(node -p 'require("node:crypto").randomBytes(16).toString("hex")')
  say "no LINKLING_KEY set: made a random one for this run"
fi
export LINKLING_KEY
# The service's own rule for a key (src/team-key.ts): a key it refuses would crash-loop the
# container until --wait-timeout runs out.
key_problem=$(node --input-type=module -e 'import { keyProblem } from "./dist/team-key.js"; console.log(keyProblem(process.env.LINKLING_KEY) ?? "")')
[ -z "$key_problem" ] || die "LINKLING_KEY $key_problem"
say "compose project $PROJECT; building the image (the first build takes a minute or two)"
STACK_STARTED=1
run_quiet build-image.log dc build || die "docker compose build failed"
# The port is chosen only now, after the slow part, so it is not held for minutes before it is used.
if [ -z "${PORT_BASE:-}" ]; then
  PORT_BASE=$(free_port)
fi
export PORT_BASE
BASE="http://127.0.0.1:$PORT_BASE"
export LINKLING_BASE=$BASE
say "starting it on $BASE"
run_quiet up.log dc up -d --wait --wait-timeout 180 || die "docker compose up did not give a healthy service"
health=$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' "$BASE/-/health" || true)
[ "$health" = 200 ] || die "$BASE/-/health answered '$health', not 200"
say "$BASE/-/health answers 200"

step "make a link with a name"
short=$(cli make https://example.com/plan --name demo-plan --by demo) || die "linkling make failed"
say "linkling make https://example.com/plan --name demo-plan  ->  $short"
[ "$short" = "$BASE/demo-plan" ] || die "expected $BASE/demo-plan, got '$short'"

step "follow it with curl"
follow "$BASE/demo-plan"
[ "$STATUS" = 302 ] || die "following $BASE/demo-plan answered $STATUS, not 302"
[ "$LOCATION" = "https://example.com/plan" ] || die "the 302 went to '$LOCATION', not https://example.com/plan"
say "GET $BASE/demo-plan  ->  302, Location: $LOCATION"

step "see its count on the stats page"
total_on_stats_page demo-plan
[ "$TOTAL" -ge 1 ] || die "the stats page counts $TOTAL follows of demo-plan after one, not at least 1"
say "the stats page lists demo-plan with a count of $TOTAL"

step "see its count from the linkling command"
counts=$(cli counts demo-plan) || die "linkling counts failed"
say "linkling counts demo-plan  ->  ${counts%%$'\n'*}"
counts_json=$(cli counts demo-plan --json) || die "linkling counts --json failed"
cli_total=$(printf '%s' "$counts_json" | sed -n 's/.*"total":\([0-9][0-9]*\).*/\1/p')
[ -n "$cli_total" ] || die "linkling counts --json gave no total"
[ "$cli_total" -ge 1 ] || die "linkling counts says $cli_total follows of demo-plan after one, not at least 1"

step "check the stats page's Privacy link goes to the public site"
grep -qF "href=\"$LINKLING_SITE/privacy.html\"" "$WORK/stats.html" || die "the stats page has no link to $LINKLING_SITE/privacy.html"
follow "$LINKLING_SITE/privacy.html"
[ "$STATUS" = 200 ] || die "$LINKLING_SITE/privacy.html answered $STATUS, not 200"
say "the stats page links to $LINKLING_SITE/privacy.html, and it answers 200"

step "make a link that expires in $LIFETIME seconds"
short=$(cli make https://example.com/flash --name demo-flash --by demo --expires "${LIFETIME}s") || die "linkling make --expires ${LIFETIME}s failed"
say "linkling make https://example.com/flash --name demo-flash --expires ${LIFETIME}s  ->  $short"

step "follow the expiring link before it expires"
follow "$BASE/demo-flash"
[ "$STATUS" = 302 ] || die "following $BASE/demo-flash straight away answered $STATUS, not 302"
[ "$LOCATION" = "https://example.com/flash" ] || die "the 302 went to '$LOCATION', not https://example.com/flash"
say "GET $BASE/demo-flash  ->  302, Location: $LOCATION"

step "wait past its expiry and follow it again"
say "waiting $((LIFETIME + 1)) seconds"
sleep $((LIFETIME + 1))
follow "$BASE/demo-flash"
[ "$STATUS" = 410 ] || die "following $BASE/demo-flash after it expired answered $STATUS, not 410"
say "GET $BASE/demo-flash  ->  410: the link has stopped working"

# A DEMO_BREAK_AFTER that stopped nothing (a typo, or only the last step) is not a run of the
# failing arm, and reporting DEMO OK for it would say the stack was broken when it was not.
if [ -n "${DEMO_BREAK_AFTER:-}" ] && [ "$BROKEN" = 0 ]; then
  CURRENT_STEP="DEMO_BREAK_AFTER=$DEMO_BREAK_AFTER"
  die "no step that has another step after it has that text in its name, so nothing was stopped"
fi
