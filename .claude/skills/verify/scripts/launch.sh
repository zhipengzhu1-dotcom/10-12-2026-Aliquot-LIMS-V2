#!/usr/bin/env bash
# launch.sh [--port <n>]: build, seed a fresh home, start `aliquot serve
# --no-schedule`, and print the run directory on the last line as RUN=<dir>.
. "$(dirname "$0")/lib.sh"

port=0
while [ $# -gt 0 ]; do
	case $1 in
	--port) port=${2:?--port takes a number}; shift 2 ;;
	*) die "usage: launch.sh [--port <n>]" ;;
	esac
done

docker info >/dev/null 2>&1 || die "Docker is not running; workflow run needs it for the Sandbox"

root=${ALIQUOT_VERIFY_ROOT:-${TMPDIR:-/tmp}/aliquot-verify}
mkdir -p "$root"
RUN=$(cd "$root" && pwd)/$(date -u +%Y%m%dT%H%M%SZ)-$$
AQ_HOME="$RUN/home"
PROOF="$RUN/proof"
mkdir -p "$AQ_HOME" "$PROOF"
log="$PROOF/launch.log"

step() {
	printf '$ %s\n' "$*" >>"$log"
	"$@" >>"$log" 2>&1 || die "'$*' failed; see $log"
}

step pnpm --silent -C "$REPO/conductor" install --frozen-lockfile
step pnpm --silent -C "$REPO/conductor" build
step aliquot --home "$AQ_HOME" org seed
step aliquot --home "$AQ_HOME" workflow run "$REPO/fixtures/submission-form-seed1.docx"
step aliquot --home "$AQ_HOME" intake "$REPO/fixtures/submission-form-seed2.docx"
step aliquot --home "$AQ_HOME" room seed
greeting='Morning, everyone. What is the lab waiting on?'
printf '$ echo %s | aliquot --home %s room say RM-lab --as A-odile\n' "'$greeting'" "$AQ_HOME" >>"$log"
printf '%s\n' "$greeting" | aliquot --home "$AQ_HOME" room say RM-lab --as A-odile >>"$log" 2>&1 ||
	die "room say failed; see $log"

printf '$ aliquot --home %s serve --port %s --no-schedule\n' "$AQ_HOME" "$port" >>"$log"
nohup env -u ALIQUOT_API_KEY -u ANTHROPIC_API_KEY -u ALIQUOT_LIVE_TURN -u ALIQUOT_SCRIPTED_MODEL \
	ALIQUOT_OPERATOR="$VERIFY_OPERATOR" \
	"$ALIQUOT" --home "$AQ_HOME" serve --port "$port" --no-schedule >"$PROOF/serve.log" 2>&1 &
launcher=$!

url=""
for _ in $(seq 1 120); do
	url=$(sed -n "s|^Serving $AQ_HOME at \(http://127.0.0.1:[0-9]*\)$|\1|p" "$PROOF/serve.log")
	[ -n "$url" ] && break
	alive "$launcher" || break
	sleep 0.5
done
if [ -z "$url" ]; then
	alive "$launcher" && kill -TERM "$launcher"
	die "serve did not print its Serving line; see $PROOF/serve.log"
fi

# The pid we signal at cleanup is the Conductor that holds the writer lock,
# found by walking up from it to the launcher this script started.
server=$(cat "$AQ_HOME/ledger.sqlite.lock")
pid=$server
while [ "$pid" != "$launcher" ] && [ "$pid" -gt 1 ]; do
	pid=$(ps -o ppid= -p "$pid" | tr -d ' ')
	[ -n "$pid" ] || break
done
if [ "$pid" != "$launcher" ]; then
	kill -TERM "$launcher"
	die "the writer lock names pid $server, which this launch did not start"
fi

cat >"$RUN/run.env" <<EOF
AQ_HOME='$AQ_HOME'
URL='$url'
LAUNCHER_PID=$launcher
SERVE_PID=$server
COMMIT='$(git -C "$REPO" rev-parse --short HEAD) on $(git -C "$REPO" branch --show-current)'
STARTED='$(date -u +%Y-%m-%dT%H:%M:%SZ)'
EOF

cat >"$PROOF/proof.md" <<EOF
# Proof run $(basename "$RUN")

- Run directory: \`$RUN\`
- Commit: $(git -C "$REPO" rev-parse --short HEAD) on $(git -C "$REPO" branch --show-current)
- Home: \`$AQ_HOME\`, seeded by [launch.log](launch.log): \`org seed\`, \`workflow run\` on seed 1, \`intake\` of seed 2, \`room seed\` and one Message by Odile in RM-lab
- Interface: $url, \`serve --no-schedule\`, pid $server, output in [serve.log](serve.log)
EOF

printf 'Serving %s at %s (pid %s)\nRUN=%s\n' "$AQ_HOME" "$url" "$server" "$RUN"
