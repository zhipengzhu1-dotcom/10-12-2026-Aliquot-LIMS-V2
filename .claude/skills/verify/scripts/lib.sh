# Shared by the verify helpers; sourced, never run.
set -euo pipefail

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(git -C "$SCRIPTS" rev-parse --show-toplevel)
ALIQUOT="$REPO/tools/aliquot"

die() {
	printf 'verify: %s\n' "$*" >&2
	exit 1
}

# A run directory is what launch.sh made: run.env, home/, proof/. Anything
# else is a home this run did not create, and the helpers refuse to drive it.
load_run() {
	RUN=${1:?the first argument is the run directory launch.sh printed}
	RUN=$(cd "$RUN" 2>/dev/null && pwd) || die "$1 is not a directory"
	[ -f "$RUN/run.env" ] || die "$RUN has no run.env: launch.sh did not create it, so it is not ours to drive"
	. "$RUN/run.env"
	PROOF="$RUN/proof"
}

alive() {
	[ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null
}

# The Ledger's writer lock holds the pid of the process that opened it.
lock_pid() {
	cat "$AQ_HOME/ledger.sqlite.lock" 2>/dev/null || true
}

# The person every Operator act of a verify run names (ADR-0019), and the actor
# column of the Events that person appends, as the Ledger stores it.
VERIFY_OPERATOR=verify@lab.test
VERIFY_ACTOR="{\"email\":\"$VERIFY_OPERATOR\",\"tag\":\"Operator\"}"

# aliquot with no key and no live-Turn switch in its environment: a Turn in a
# proof runs only on the scripted model (ALIQUOT_SCRIPTED_MODEL).
aliquot() {
	env -u ALIQUOT_API_KEY -u ANTHROPIC_API_KEY -u ALIQUOT_LIVE_TURN ALIQUOT_OPERATOR="$VERIFY_OPERATOR" "$ALIQUOT" "$@"
}
