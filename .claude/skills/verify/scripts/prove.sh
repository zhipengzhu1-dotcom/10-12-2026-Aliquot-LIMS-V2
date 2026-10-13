#!/usr/bin/env bash
# prove.sh <feature> [--intent '<acceptance box, quoted>']: the whole loop in
# one command. Launch a fresh run, run the doctor, drive the feature, clean
# up, and confirm the proof outlived the cleanup. Exits 1 when any part fails.
. "$(dirname "$0")/lib.sh"
feature=${1:?usage: prove.sh <feature> [--intent '<text>'], feature one of org, flow, agent, gates, ledger}
shift

launched=$("$SCRIPTS/launch.sh") || die "launch failed: $launched"
printf '%s\n' "$launched"
RUN=$(printf '%s\n' "$launched" | sed -n 's/^RUN=//p')

status=0
if "$SCRIPTS/doctor.sh" "$RUN" | tee "$RUN/proof/doctor.txt"; then
	printf -- '- Doctor: [doctor.txt](doctor.txt) says `doctor: ok`.\n' >>"$RUN/proof/proof.md"
	"$SCRIPTS/drive.sh" "$RUN" "$feature" "$@" || status=1
else
	printf -- '- Doctor: [doctor.txt](doctor.txt) failed, so nothing was driven.\n' >>"$RUN/proof/proof.md"
	status=1
fi
"$SCRIPTS/cleanup.sh" "$RUN" || status=1

[ -s "$RUN/proof/proof.md" ] || die "the proof did not survive cleanup: $RUN/proof/proof.md is missing"
grep -q '^\*\*PASS\.' "$RUN/proof/proof.md" || status=1
printf 'proof: %s/proof/proof.md\n' "$RUN"
exit "$status"
