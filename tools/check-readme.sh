#!/usr/bin/env bash
# Run every command of README.md's sh blocks, in README order, against one fresh home,
# and say for each whether it did what the README says. Usage: tools/check-readme.sh
#
# What it changes on the way, and why:
# - /tmp/aliquot and /tmp/synth-42 become directories under a fresh temporary one.
# - The input files the README names but does not ship (thorne-v2.json, deploy.json, ...)
#   are written there, and a revise file holds the Agent's current definition one version up.
# - <payload hash>, <artifact id>, <task id>, <seq> and <worksheet id> take the value an earlier
#   command printed.
# - ALIQUOT_SCRIPTED_MODEL names a model that calls no Tool, so `turn run` and the
#   Scheduler inside `serve` spend no subscription window.
# - `serve` runs in the background until the next `## ` section; `curl -N` is cut after 3 s.
# - tools/check.sh (the check itself) and tools/serve.sh (the owner's Cloudflare account,
#   gate G2) are skipped and listed.
# A comment that says "refused" or "exits 1" (not "exits 1 if") expects exit 1; "prints T-2"
# expects T-2 in the output.
set -uo pipefail

root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
readme="$root/README.md"
work="$(mktemp -d "${TMPDIR:-/tmp}/check-readme.XXXXXX")"
home="$work/home"
port=8787

if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
	echo "check-readme: port $port is in use; the README's serve and curl commands need it" >&2
	exit 2
fi

unset ALIQUOT_API_KEY ALIQUOT_HOME
export ALIQUOT_SCRIPTED_MODEL="$work/scripted-model.json"
printf '%s\n' '{"calls": [], "usage_per_round": {"input_tokens": 100, "output_tokens": 20, "cache_creation_tokens": 0, "cache_read_tokens": 0, "cost_usd": 0}, "stop": {"tag": "Completed"}}' >"$ALIQUOT_SCRIPTED_MODEL"
printf '%s\n' '{"release": "README example", "artifact": "none"}' >"$work/deploy.json"
printf '%s\n' '# Parse a Submission Form' '' 'Read the header table first.' >"$work/parse-form.md"
printf '%s\n' 'lab_reference,lot' 'LR-2026-0001,LOT-7' >"$work/receiving_log.csv"

payload_hash="" artifact_id="" task_id="" seq="" worksheet_id=""
serve_pid=""
ran=0 skipped=0 failed=0

stop_serve() {
	[ -n "$serve_pid" ] || return 0
	kill -TERM -- "-$serve_pid" 2>/dev/null
	wait "$serve_pid" 2>/dev/null
	serve_pid=""
}
trap 'stop_serve' EXIT

# The full next definition of an Agent, from its latest definition in the Ledger.
revise_file() {
	local agent="$1" file="$2" skills="$3"
	sqlite3 "$home/ledger.sqlite" \
		"select payload from events where kind in ('AgentRecruited','AgentDefinitionRevised') order by seq" |
		jq -s --arg id "$agent" --argjson skills "$skills" \
			'map(.definition // .) | map(select(.id == $id)) | last
			| .version += 1 | .revised_by = {tag: "Operator"} | .revision_reason = "README example"
			| .skills = (.skills + $skills | unique)' >"$work/$file"
}

capture() {
	local cmd="$1" out="$2" hex='[0-9a-f]\{64\}' value
	case "$cmd" in
	*"gate request"* | *"org retire"*"--reason"*)
		value="$(grep -o "$hex" "$out" | tail -1)"
		[ -n "$value" ] && payload_hash="$value"
		;;
	*"sandbox store"*)
		value="$(grep -o "$hex" "$out" | head -1)"
		[ -n "$value" ] && artifact_id="$value"
		;;
	*"room say"*)
		value="$(sed -n 's/^\([0-9][0-9]*\)  .*/\1/p' "$out" | head -1)"
		[ -n "$value" ] && seq="$value"
		;;
	*"task propose"*)
		value="$(grep -o 'T-[0-9][0-9]*' "$out" | head -1)"
		[ -n "$value" ] && task_id="$value"
		;;
	esac
	value="$(sed -n "s/.*\($hex\) ResultWorksheet.*/\1/p" "$out" | tail -1)"
	[ -n "$value" ] && worksheet_id="$value"
	return 0
}

substitute() {
	local cmd="$1" f
	cmd="${cmd//\/tmp\/aliquot/$home}"
	cmd="${cmd//\/tmp\/synth-42/$work/synth-42}"
	for f in thorne-v2.json odile-v2.json deploy.json parse-form.md receiving_log.csv samples.csv turns.csv reviews.csv; do
		cmd="${cmd// $f/ $work/$f}"
	done
	cmd="${cmd//<payload hash>/$payload_hash}"
	cmd="${cmd//<artifact id>/$artifact_id}"
	cmd="${cmd//<task id>/$task_id}"
	cmd="${cmd//<seq>/$seq}"
	cmd="${cmd//<worksheet id>/$worksheet_id}"
	case "$cmd" in "curl -N "*) cmd="curl -N -i --max-time 3 ${cmd#curl -N }" ;; esac
	printf '%s' "$cmd"
}

report() {
	local verdict="$1" line="$2" cmd="$3" detail="${4:-}"
	printf '%-4s README.md:%-4s %s\n' "$verdict" "$line" "$cmd"
	[ -z "$detail" ] || printf '%s\n' "$detail" | sed 's/^/       /'
}

# One record per command: line, command, and the comment after it (trailing, or the first
# comment line under it), separated by tabs. A "## " heading is a record of its own.
records="$(awk '
	function flush() { if (cmd != "") print start "\t" cmd "\t" note; cmd = ""; note = "" }
	/^## / && !inblock { flush(); print NR "\t##\t" substr($0, 4); next }
	/^```sh/ { inblock = 1; next }
	/^```/ && inblock { flush(); inblock = 0; next }
	!inblock { next }
	/^#/ { if (!noted) note = note " " $0; noted = 1; next }
	{
		text = $0
		if (cont) { cmd = cmd " " text } else { flush(); start = NR; cmd = text; noted = 0 }
		cont = (text ~ /\\$/)
		if (cont) sub(/ *\\$/, "", cmd)
		if (!cont && match(cmd, /  +# /)) { note = substr(cmd, RSTART); cmd = substr(cmd, 1, RSTART - 1) }
	}
	END { flush() }
' "$readme")"

cd "$root" || exit 2
while IFS="$(printf '\t')" read -r line cmd note; do
	if [ "$cmd" = "##" ]; then
		stop_serve
		continue
	fi
	case "$cmd" in
	"tools/check.sh")
		report skip "$line" "$cmd" "the check itself: run it on its own"
		skipped=$((skipped + 1))
		continue
		;;
	"tools/serve.sh")
		report skip "$line" "$cmd" "needs the owner's Cloudflare Tunnel and .aliquot/serve.json (gate G2)"
		skipped=$((skipped + 1))
		continue
		;;
	esac
	case "$cmd" in
	*" thorne-v2.json"*) revise_file A-thorne thorne-v2.json '[]' ;;
	*" odile-v2.json"*) revise_file A-odile odile-v2.json '["parse-submission-form"]' ;;
	esac
	run="$(substitute "$cmd")"
	out="$work/out-$line.txt"
	ran=$((ran + 1))

	if [[ "$run" =~ ^tools/aliquot.*\ serve($|\ ) ]]; then
		stop_serve
		# Its own process group, so stop_serve's signal reaches the node process under pnpm.
		set -m
		eval "$run" >"$out" 2>&1 </dev/null &
		serve_pid=$!
		set +m
		for _ in $(seq 1 120); do
			grep -q '^Serving ' "$out" && break
			kill -0 "$serve_pid" 2>/dev/null || break
			sleep 0.5
		done
		if grep -q '^Serving ' "$out"; then
			report ok "$line" "$cmd" "$(grep '^Serving ' "$out")"
		else
			report FAIL "$line" "$cmd" "$(tail -5 "$out")"
			failed=$((failed + 1))
		fi
		continue
	fi

	eval "$run" >"$out" 2>&1 </dev/null
	status=$?
	capture "$run" "$out"

	expected=0
	case "$note" in *"exits 1 if"*) ;; *"exits 1"* | *refused*) expected=1 ;; esac
	case "$run" in "curl -N "*) expected=28 ;; esac
	problem=""
	if [ "$status" -ne "$expected" ]; then
		problem="exit $status, the README expects $expected"
	elif [ "$expected" -eq 28 ] && ! grep -q '^HTTP/[0-9.]* 200' "$out"; then
		problem="the stream did not answer 200"
	elif [[ "$note" =~ prints\ ([A-Z]+-[0-9]+|[0-9]+)([^A-Za-z0-9-]|$) ]] && ! grep -qw -- "${BASH_REMATCH[1]}" "$out"; then
		problem="the README says it prints ${BASH_REMATCH[1]}"
	fi
	if [ -z "$problem" ]; then
		report ok "$line" "$cmd"
	else
		report FAIL "$line" "$cmd" "$problem"$'\n'"$(tail -5 "$out")"
		failed=$((failed + 1))
	fi
done <<<"$records"
stop_serve

echo "check-readme: $ran ran, $skipped skipped, $failed failed (home $home)"
[ "$failed" -eq 0 ]
