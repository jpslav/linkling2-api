#!/usr/bin/env bash
# R-016: follows one short link 1,000 times and prints the 95th-percentile answer time.
#
#   LINKLING_BASE=http://localhost:8080 LINKLING_KEY=... scripts/latency.sh
#
# It makes its own link through the API, follows it with a fresh curl each time (a fresh
# connection, like a browser's first click), then deletes it. The deleted link's counts
# stay under its internal id, shown nowhere (ADR-0004).
#
# Exits 0 when the p95 is within the budget (LATENCY_BUDGET_MS, default 50), 1 when it is
# over or a follow answered anything but a 302, and 2 printing LATENCY BLIND when the
# service did not answer at all (each request gives up after 5 s) or a setting is unusable,
# so a missing service is never a pass. LATENCY_FOLLOWS (default 1000) sets the count.
set -u

FOLLOWS="${LATENCY_FOLLOWS:-1000}"
BUDGET_MS="${LATENCY_BUDGET_MS:-50}"

blind() {
  echo "LATENCY BLIND: $*"
  exit 2
}

# A budget or count that is not a whole number would make every comparison below meaningless.
[[ "$FOLLOWS" =~ ^[1-9][0-9]*$ ]] || blind "LATENCY_FOLLOWS must be a whole number of at least 1, not '$FOLLOWS'"
[[ "$BUDGET_MS" =~ ^[0-9]+$ ]] || blind "LATENCY_BUDGET_MS must be a whole number of milliseconds, not '$BUDGET_MS'"
[ -n "${LINKLING_BASE:-}" ] || blind "LINKLING_BASE is not set"
[ -n "${LINKLING_KEY:-}" ] || blind "LINKLING_KEY is not set"
command -v curl >/dev/null || blind "curl is not installed"

# A service that takes the connection and never answers must end in BLIND or FAIL, not hang.
curl() { command curl --max-time 5 "$@"; }

health=$(curl -s -o /dev/null -w '%{http_code}' "$LINKLING_BASE/-/health")
[ "$health" = 200 ] || blind "$LINKLING_BASE/-/health answered '$health', not 200"

made=$(curl -s -X POST "$LINKLING_BASE/-/api/links" \
  -H "Authorization: Bearer $LINKLING_KEY" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/latency","made_by":"latency.sh"}')
name=$(printf '%s' "$made" | sed -n 's/.*"name":"\([a-z0-9-]*\)".*/\1/p')
[ -n "$name" ] || blind "making a link did not answer with a name: $made"

times=$(mktemp)
trap 'rm -f "$times"; curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $LINKLING_KEY" "$LINKLING_BASE/-/api/links/$name"' EXIT

for _ in $(seq "$FOLLOWS"); do
  curl -s -o /dev/null -w '%{http_code} %{time_total}\n' "$LINKLING_BASE/$name" >>"$times"
done

answered=$(awk '$1 != "000"' "$times" | wc -l | tr -d ' ')
[ "$answered" -gt 0 ] || blind "none of $FOLLOWS follows of /$name was answered"
not_302=$(awk '$1 != "302"' "$times" | wc -l | tr -d ' ')
if [ "$not_302" -gt 0 ]; then
  echo "LATENCY FAIL: $not_302 of $FOLLOWS follows of /$name did not answer 302 ($(awk '$1 != "302" {print $1}' "$times" | sort | uniq -c | tr -s ' ' | tr '\n' ';'))"
  exit 1
fi

# The nearest-rank p95: the value at position ceil(0.95 * n) of the sorted times.
# n is the number of times measured, never the number asked for.
p95_ms=$(awk '{print $2 * 1000}' "$times" | sort -n | awk '
  { t[NR] = $1 }
  END { r = int(0.95 * NR); if (r < 0.95 * NR) r++; printf "%.1f", t[r] }')
measured=$(wc -l <"$times" | tr -d ' ')
[ "$measured" = "$FOLLOWS" ] || blind "measured $measured follows of /$name, not $FOLLOWS"
echo "p95 ${p95_ms} ms over $measured follows of /$name (budget ${BUDGET_MS} ms)"
if awk -v p="$p95_ms" -v b="$BUDGET_MS" 'BEGIN { exit !(p > b) }'; then
  echo "LATENCY FAIL: p95 ${p95_ms} ms is over ${BUDGET_MS} ms"
  exit 1
fi
exit 0
