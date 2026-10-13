#!/usr/bin/env bash
# doctor.sh <run dir>: is this instance worth driving? Read-only. Prints one
# line per check and exits 1 when any check fails.
. "$(dirname "$0")/lib.sh"
load_run "${1:-}"

failed=0
check() {
	local what=$1
	shift
	if "$@" >/dev/null 2>&1; then
		printf 'ok    %s\n' "$what"
	else
		printf 'FAIL  %s\n' "$what"
		failed=$((failed + 1))
	fi
}

ours() { alive "$SERVE_PID" && [ "$(lock_pid)" = "$SERVE_PID" ]; }
eight_agents() { [ "$(curl -sf "$URL/api/org" | jq '.agents | length')" = 8 ]; }
no_scheduler() { [ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/scheduler")" = 404 ]; }
chain_intact() { aliquot --home "$AQ_HOME" ledger verify | grep -q 'chain intact'; }
api_intact() { curl -sf "$URL/api/ledger/verify" | jq -e '.ok' ; }
interface_served() { curl -sf "$URL/" | grep -q '<title>Aliquot Conductor</title>'; }
build_fresh() {
	local built="$REPO/conductor/dist/ui/main.js"
	[ -f "$built" ] && [ -z "$(find "$REPO/conductor/src" "$REPO/conductor/ui" -type f -newer "$built" -print -quit)" ] &&
		! grep -q 'The interface is not built' "$PROOF/serve.log"
}

check "serve pid $SERVE_PID is alive and holds the writer lock of $AQ_HOME" ours
check "$URL/api/org answers with eight Agents" eight_agents
check "/api/scheduler answers 404, so serve runs with --no-schedule" no_scheduler
check "ledger verify says chain intact" chain_intact
check "/api/ledger/verify answers ok" api_intact
check "GET / serves the built interface" interface_served
check "conductor/dist/ui is newer than conductor/src and conductor/ui (else rerun launch.sh)" build_fresh

if [ "$failed" -gt 0 ]; then
	printf 'doctor: %s check(s) failed for %s\n' "$failed" "$RUN"
	exit 1
fi
printf 'doctor: ok for %s\n' "$RUN"
