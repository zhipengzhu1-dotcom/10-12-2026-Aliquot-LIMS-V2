#!/usr/bin/env bash
# cleanup.sh <run dir>: stop the processes this run started, by the pids it
# recorded, and remove its scratch state. home/ (the Ledger) and proof/ stay.
. "$(dirname "$0")/lib.sh"
load_run "${1:-}"

wait_gone() {
	for _ in $(seq 1 60); do
		alive "$1" || return 0
		sleep 0.25
	done
	return 1
}

if alive "$SERVE_PID" && [ "$(lock_pid)" = "$SERVE_PID" ]; then
	kill -TERM "$SERVE_PID"
	wait_gone "$SERVE_PID" || die "serve pid $SERVE_PID did not stop on SIGTERM; it still holds $AQ_HOME"
fi
if alive "$LAUNCHER_PID"; then
	kill -TERM "$LAUNCHER_PID"
	wait_gone "$LAUNCHER_PID" || die "launcher pid $LAUNCHER_PID did not stop on SIGTERM"
fi
if [ -f "$RUN/chrome.pids" ]; then
	while read -r chrome; do
		if alive "$chrome"; then kill -TERM "$chrome"; fi
	done <"$RUN/chrome.pids"
fi
rm -rf "$RUN"/chrome-profile-*

left=$(pgrep -f "$RUN/(home|chrome-profile)" || true)
[ -z "$left" ] || die "processes still name $RUN/home or a Chrome profile of this run: $left"
[ ! -e "$AQ_HOME/ledger.sqlite.lock" ] || die "the writer lock $AQ_HOME/ledger.sqlite.lock is still there"
curl -s -o /dev/null --max-time 2 "$URL/api/org" && die "$URL still answers"

[ -f "$PROOF/proof.md" ] || die "$PROOF/proof.md is missing"
{
	printf '\n## Cleanup\n\n'
	printf -- '- `cleanup.sh` at %s stopped serve pid %s and launcher pid %s; no process names the run directory, the writer lock is released, and %s no longer answers.\n' \
		"$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SERVE_PID" "$LAUNCHER_PID" "$URL"
	printf -- '- Kept: `home/` (the Ledger, readable with `sqlite3 home/ledger.sqlite`) and `proof/`, %s files.\n' "$(find "$PROOF" -type f | wc -l | tr -d ' ')"
} >>"$PROOF/proof.md"
printf 'stopped; evidence kept at %s/proof.md\n' "$PROOF"
