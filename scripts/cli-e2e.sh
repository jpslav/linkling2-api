#!/usr/bin/env bash
# LL-002: the `linkling` command against a running stack (R-015, and the CLI halves of R-006,
# R-008 and R-009).
#
#   LINKLING_BASE=http://localhost:8080 LINKLING_KEY=... scripts/cli-e2e.sh
#
# `linkling` must be on PATH: `npm ci && npm run build && npm install -g .`. The script runs
# R-015's verify line exactly as products/linkling/REQUIREMENTS.md gives it, then checks what
# that line does not: made_by, expiry, the exit codes for a taken name, a link that is not
# there and a wrong key, and a follow showing up in `linkling counts`. It makes links under
# names of its own and deletes them on the way out. The one name it cannot choose is
# `cli-test`, which R-015's line fixes: on a stack that already has a link by that name it stops
# with CLI E2E BLIND before making anything, and it never deletes one it did not make.
#
# Exits 0 printing CLI E2E PASS, 1 printing CLI E2E FAIL: <the step> when a step's result is
# not what it should be, and 2 printing CLI E2E BLIND: <what was missing> when nothing could be
# measured: no `linkling` on PATH, no LINKLING_BASE or LINKLING_KEY, a service whose /-/health
# does not answer 200 within 5 s, or a stack that already has a link called cli-test. A missing
# stack is never a pass.
set -u

blind() {
  echo "CLI E2E BLIND: $*"
  exit 2
}
fail() {
  echo "CLI E2E FAIL: $*"
  exit 1
}

[ -n "${LINKLING_BASE:-}" ] || blind "LINKLING_BASE is not set"
[ -n "${LINKLING_KEY:-}" ] || blind "LINKLING_KEY is not set"
command -v curl >/dev/null || blind "curl is not installed"
command -v linkling >/dev/null || blind "linkling is not on PATH (npm ci && npm run build && npm install -g .)"

# A service that takes the connection and never answers must end in BLIND or FAIL, not hang.
curl() { command curl --max-time 5 "$@"; }

health=$(curl -s -o /dev/null -w '%{http_code}' "$LINKLING_BASE/-/health")
[ "$health" = 200 ] || blind "$LINKLING_BASE/-/health answered '$health', not 200"

# expect_exit <code> <step> <command...>: runs the command and fails the step unless it exits <code>.
expect_exit() {
  local want=$1 step=$2
  shift 2
  local out got
  out=$("$@" 2>&1)
  got=$?
  [ "$got" = "$want" ] || fail "$step: expected exit $want, got $got: $out"
}

R015='linkling make https://example.com/c --name cli-test && linkling list | grep -q cli-test && linkling edit cli-test https://example.com/d && linkling counts cli-test && linkling delete cli-test'
suffix="$$-$RANDOM"
plain="e2e-plain-$suffix"
byana="e2e-by-$suffix"
week="e2e-week-$suffix"
owned="$plain $byana $week"
trap 'for n in $owned; do linkling delete "$n" >/dev/null 2>&1; done' EXIT

# 0. R-015's line fixes the name `cli-test`. A link already called that is not this script's to
# delete, and the line would fail on it with a 409, which says nothing about the command.
listing=$(linkling list 2>&1) || fail "linkling list, before anything is made: $listing"
if printf '%s\n' "$listing" | grep -q '^cli-test '; then
  blind "a link named cli-test is already on $LINKLING_BASE; R-015's line makes it, so delete it or use a fresh stack"
fi
# It is absent now, so whatever R-015's line leaves behind is this run's, and goes on the way out.
owned="$owned cli-test"

# 1. R-015's verify line, character for character.
out=$(bash -c "$R015" 2>&1) || fail "R-015's verify line exited $?: $out"

# 2. R-008: made_by is the login name unless --by is given.
user="${USER:-$(id -un)}"
out=$(linkling make https://example.com/e2e --name "$plain" --json 2>&1) || fail "make with no --by: $out"
printf '%s' "$out" | grep -q "\"made_by\":\"$user\"" || fail "make with no --by did not send the login name '$user': $out"
out=$(linkling make https://example.com/e2e --name "$byana" --by ana --json 2>&1) || fail "make with --by: $out"
printf '%s' "$out" | grep -q '"made_by":"ana"' || fail "make with --by ana did not send ana: $out"

# 3. R-006 and R-005: no expiry lists as never; a lifetime lists a time.
out=$(linkling make https://example.com/e2e --name "$week" --expires 7d 2>&1) || fail "make --expires 7d: $out"
listing=$(linkling list 2>&1) || fail "list: $listing"
plain_row=$(printf '%s\n' "$listing" | grep "^$plain ")
week_row=$(printf '%s\n' "$listing" | grep "^$week ")
case "$plain_row" in *never*) ;; *) fail "a link made with no expiry did not list as never: '$plain_row'" ;; esac
case "$week_row" in "") fail "the link made with --expires 7d is not listed" ;; *never*) fail "a link made with --expires 7d listed as never: '$week_row'" ;; esac

# 4. The exit codes a script relies on (ADR-0015).
expect_exit 1 "making a taken name" linkling make https://example.com/e2e --name "$plain"
expect_exit 1 "deleting a link that is not there" linkling delete "e2e-no-such-link-$suffix"
LINKLING_KEY="wrong-$suffix" expect_exit 3 "listing with a wrong key" linkling list
LINKLING_BASE="http://127.0.0.1:1" expect_exit 4 "listing from a service that is not there" linkling list

# 5. R-009's CLI half: a follow shows up in linkling counts.
curl -s -o /dev/null "$LINKLING_BASE/$plain"
out=$(linkling counts "$plain" 2>&1) || fail "counts: $out"
case "$out" in *": 1 total"*) ;; *) fail "counts after one follow did not show '1 total': $out" ;; esac

echo "CLI E2E PASS"
