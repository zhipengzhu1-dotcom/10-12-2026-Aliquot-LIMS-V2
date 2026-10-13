#!/usr/bin/env bash
# Serve the Conductor at agents.nitrolims-demo.com: `aliquot serve` behind Cloudflare Access,
# and the Cloudflare Tunnel `aliquot` in front of it. Ctrl-C stops both. See docs/ops/tunnel.md.
# The Scheduler runs, as in `aliquot serve`, so a Message said in the Chat view gets a Turn on the
# subscription login, within the Energy budget. --no-schedule serves without it: no Turn starts.
# Usage: tools/serve.sh [--home <dir>] [--no-tunnel] [--no-schedule]
set -euo pipefail

root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
settings="$root/.aliquot/serve.json"
tunnel_config="$root/tools/tunnel/config.yml"
home="${ALIQUOT_HOME:-$root/.aliquot}"
tunnel=yes
no_schedule=""

usage() {
	echo "usage: tools/serve.sh [--home <dir>] [--no-tunnel] [--no-schedule]" >&2
	exit 2
}

while [ $# -gt 0 ]; do
	case "$1" in
		--home) [ $# -ge 2 ] || usage; home="$2"; shift 2 ;;
		--no-tunnel) tunnel=no; shift ;;
		--no-schedule) no_schedule=yes; shift ;;
		*) usage ;;
	esac
done

if [ ! -f "$settings" ]; then
	echo "serve: $settings is missing; copy tools/tunnel/serve.example.json there and fill it in (docs/ops/tunnel.md)" >&2
	exit 2
fi

setting() {
	jq -er --arg key "$1" '.[$key] | select(type == "string" and . != "" and (startswith("<") | not))' "$settings" \
		|| { echo "serve: $settings needs \"$1\"" >&2; exit 2; }
}
access_team="$(setting access_team)"
access_aud="$(setting access_aud)"
operator_email="$(setting operator_email)"

# The tunnel's ingress names the Conductor's port, so the Conductor listens where the tunnel sends.
port="$(sed -n 's|^ *service: http://127\.0\.0\.1:\([0-9][0-9]*\)$|\1|p' "$tunnel_config")"
[ -n "$port" ] || { echo "serve: no 127.0.0.1 service in $tunnel_config" >&2; exit 2; }

pnpm --silent -C "$root/conductor" build

# With job control on while they start, both children run in process groups of their own,
# so Ctrl-C reaches only this script and each child gets exactly one SIGTERM from stop.
# A second signal would cut short the Conductor's closing of the Ledger.
set -m
serve_pid=""
tunnel_pid=""

stop() {
	trap - INT TERM
	kill -TERM $serve_pid $tunnel_pid 2>/dev/null || true
	wait $serve_pid $tunnel_pid 2>/dev/null || true
}
trap 'stop; exit 130' INT
trap 'stop; exit 143' TERM

node "$root/conductor/dist/cli.js" --home "$home" serve --bind 127.0.0.1 --port "$port" ${no_schedule:+--no-schedule} \
	--access-team "$access_team" --access-aud "$access_aud" --operator-email "$operator_email" &
serve_pid=$!

if [ "$tunnel" = yes ]; then
	cloudflared tunnel --no-autoupdate --config "$tunnel_config" run aliquot &
	tunnel_pid=$!
else
	echo "serve: --no-tunnel, so only http://127.0.0.1:$port serves, and only to a request Access signed" >&2
fi

set +m

running() {
	kill -0 "$1" 2>/dev/null
}
# A trap runs as soon as `wait` is interrupted, but only after a foreground command ends.
while running "$serve_pid" && { [ "$tunnel" = no ] || running "$tunnel_pid"; }; do
	sleep 1 &
	wait $! || true
done
echo "serve: a process stopped on its own; stopping the other" >&2
stop
exit 1
