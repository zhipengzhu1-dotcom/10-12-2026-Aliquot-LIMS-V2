#!/usr/bin/env bash
# drive.sh <run dir> <feature> [--intent '<what to prove, quoted>']: drive one
# feature of features/ through the interface, check its end state, and append
# its section (intent, commands, evidence, verdict) to proof/proof.md.
# Features: org, flow, agent, gates, ledger, chat, access, views. Exits 1 when
# a check fails.
. "$(dirname "$0")/lib.sh"
load_run "${1:-}"
feature=${2:?the second argument is a feature: org, flow, agent, gates, ledger, chat, access or views}
shift 2
map="$(dirname "$SCRIPTS")/features/$feature.md"
[ -f "$map" ] || die "features/$feature.md does not exist"
intent="$(sed -n '1s/^# //p' "$map"). $(sed -n '3p' "$map")"
[ "${1:-}" = --intent ] && intent=${2:?--intent takes the text to prove}

out="$PROOF/$feature"
mkdir -p "$out"
db="$AQ_HOME/ledger.sqlite"
base=$(sqlite3 "$db" 'select max(seq) from events')
commands=()
evidence=()
checked=0
failed=0
LAST=0

# A command as the reader reruns it from the skill directory, with $RUN set.
word() {
	local a=${1//"$SCRIPTS"/scripts}
	a=${a//"$RUN"/\$RUN}
	a=${a//"$REPO"\//}
	case $a in
	*[!A-Za-z0-9_./:=@%+,\$-]* | '') printf "'%s'" "${a//\'/\'\\\'\'}" ;;
	*) printf '%s' "$a" ;;
	esac
}
shown() {
	local s="" a
	case $1 in
	api) s='scripts/api.sh $RUN ' && shift ;;
	aliquot) s='tools/aliquot ' && shift ;;
	esac
	for a in "$@"; do s+="$(word "$a") "; done
	printf '%s' "${s% }"
}

# step <output file> <command>...: run it, keep its output, record it and its
# exit code; LAST holds the code. A step never stops the drive: checks judge.
step() {
	local file=$1
	shift
	LAST=0
	"$@" >"$out/$file" 2>"$out/$file.stderr" || LAST=$?
	[ -s "$out/$file.stderr" ] || rm -f "$out/$file.stderr"
	commands+=("$ $(shown "$@")"$'\n'"# exit $LAST, output $feature/$file")
}
browser() {
	local part=$1
	shift
	step "$part.log" node "$SCRIPTS/browser.mjs" "$RUN" "$feature/$part" "$@"
	expect "every browser step of $part held ([steps]($feature/$part/steps.tsv))" test "$LAST" -eq 0
	local n s result shot
	while IFS=$'\t' read -r n s result shot; do
		[ "$n" = n ] && continue
		evidence+=("    $n. \`$s\`: $result"$'\n'"       ![$s]($feature/$part/$shot)")
	done <"$out/$part/steps.tsv"
}
api() { "$SCRIPTS/api.sh" "$RUN" "$@"; }
sql() { sqlite3 "$db" "$@"; }
expect() {
	local claim=$1
	shift
	checked=$((checked + 1))
	if "$@" >/dev/null 2>&1; then
		evidence+=("- PASS. $claim")
	else
		failed=$((failed + 1))
		evidence+=("- FAIL. $claim")
	fi
}
same() { [ "$1" = "$2" ]; }
has() { grep -qF -- "$2" "$out/$1"; }
rows_since() {
	sql -header -column "select seq, actor, kind, task_id, causation_id, payload from events where seq > $base order by seq" >"$out/ledger-rows.txt"
	evidence+=("- The Ledger rows this drive appended, from \`sqlite3 home/ledger.sqlite\` ([$feature/ledger-rows.txt]($feature/ledger-rows.txt)):"$'\n\n```text\n'"$(cat "$out/ledger-rows.txt")"$'\n```')
}
chain() {
	step ledger-verify.txt aliquot --home "$AQ_HOME" ledger verify
	expect "\`ledger verify\` exits 0 and says chain intact after the drive ($(tr -d '\n' <"$out/ledger-verify.txt"))" has ledger-verify.txt 'chain intact'
}
kinds_since() { sql "select group_concat(kind, ' ') from (select kind from events where seq > $base order by seq)"; }

drive_access() {
	local host=${URL#http://}
	browser landing goto '#/org' landing \
		text '#access-operator' "$VERIFY_OPERATOR" text '#access-terminal' "$host" \
		text '#access-laboratory' 'Lab Room · RM-lab' text '#access-date' "$(date +%Y)" \
		scheme dark landing scheme light \
		viewport 390 landing no-hscroll viewport 1280 \
		enter wait '[data-agent="A-rin"]' goto '#/gates' shell
	expect "the drive appended no Event: the landing only reads" same "$(sql 'select max(seq) from events')" "$base"
	chain
}

# Every view, in light and in dark at 1280 px, then at 390 px.
VIEW_ROUTES=('#/org' '#/flow' '#/agent?id=A-rin' '#/chat' '#/rooms' '#/scripts' '#/gates' '#/performance' '#/ledger')
drive_views() {
	local scheme route steps=()
	for scheme in light dark; do
		steps+=(scheme "$scheme")
		for route in "${VIEW_ROUTES[@]}"; do steps+=(goto "$route" wait 'main h1' gone 'main [role=alert]' no-hscroll); done
	done
	browser wide "${steps[@]}"
	steps=(scheme light viewport 390)
	for route in "${VIEW_ROUTES[@]}"; do steps+=(goto "$route" wait 'main h1' no-hscroll); done
	browser phone "${steps[@]}"
	expect "the drive appended no Event: every view only reads" same "$(sql 'select max(seq) from events')" "$base"
	chain
}

drive_org() {
	local reason="verify: pause Rin from the Org view"
	local rest="verify: Rest from the Action bar"
	browser ui goto '#/org' mark \
		click '#act-A-rin > summary' fill '#pause-A-rin-reason' "$reason" click '#pause-A-rin button' \
		text '#answer' 'Appended AgentPaused' wait '[data-agent="A-rin"] .badge.paused' wait '#resume-A-rin' \
		outside resume '{"agent_id":"A-rin"}' gone '[data-agent="A-rin"] .badge.paused' \
		fill '#action input[name=verb]' rest-order \
		fill '#action textarea[name=body]' "{\"agent_id\":\"A-ines\",\"action\":\"begin\",\"reason\":\"$rest\"}" \
		click '#action button' text '#answer' 'Appended RestOrdered' count '.agent .badge.tier' 8 count '.agent [class*="mood"]' 0 \
		same-page
	step resume-again.txt api act resume '{"agent_id":"A-rin"}' --expect 409
	expect "a second resume of Rin is refused with 409 and the Ledger's text" \
		has resume-again.txt 'AgentResumed refused: A-rin is not paused'
	step org.json api get org
	expect "/api/org has Rin running again (paused false)" \
		same "$(jq '.agents["A-rin"].paused' "$out/org.json" 2>/dev/null)" false
	step vitality.json api get vitality
	expect "/api/vitality has Ines fresh after her Rest order: Mood is flat" \
		same "$(jq -r '.["A-ines"].mood' "$out/vitality.json" 2>/dev/null)" fresh
	expect "/api/vitality has every live Agent fresh" \
		same "$(jq -r '[.[] | .mood] | unique | join(" ")' "$out/vitality.json" 2>/dev/null)" fresh
	expect "the RestOrdered row carries Ines, begin and the typed reason, by $VERIFY_OPERATOR" \
		same "$(sql "select count(*) from events where seq > $base and kind = 'RestOrdered' and actor = '$VERIFY_ACTOR' and json_extract(payload, '$.agent_id') = 'A-ines' and json_extract(payload, '$.action') = 'begin' and json_extract(payload, '$.reason') = '$rest'")" 1
	expect "the AgentPaused row carries Rin and the typed reason, by $VERIFY_OPERATOR" \
		same "$(sql "select count(*) from events where seq > $base and kind = 'AgentPaused' and actor = '$VERIFY_ACTOR' and json_extract(payload, '$.agent_id') = 'A-rin' and json_extract(payload, '$.reason') = '$reason'")" 1
	expect "the drive appended AgentPaused, AgentResumed and RestOrdered, in that order ($(kinds_since))" \
		same "$(sql "select group_concat(kind, ' ') from (select kind from events where seq > $base and kind in ('AgentPaused', 'AgentResumed', 'RestOrdered') order by seq)")" 'AgentPaused AgentResumed RestOrdered'
	rows_since
	chain
}

drive_flow() {
	step lots.json api get lots
	local lot
	lot=$(jq -r '[.[]] | first // empty' "$out/lots.json")
	step stages.json api get stages
	local lanes=$(($(jq length "$out/stages.json") + 1))
	browser ui goto '#/flow' mark count '[data-lane]' "$lanes" wait '[data-task="T-1"]' \
		choose 'form.filter select[name=lot]' "$lot" click 'form.filter button' \
		wait "form.filter option[selected][value=\"$lot\"]" wait '[data-task="T-6"]' count '[data-task]' 6 \
		click '[data-task="T-1"]' wait 'aside.panel li[data-seq]' wait 'svg.arrows path[data-from][data-to]' \
		count 'aside.panel li.outside' 1 save 'aside.panel' panel.txt \
		goto '#/flow?task=T-2' wait '[data-task="T-2"]' gone '[data-task="T-1"]' same-page
	expect "the Lot filter offered $lot, the Lot /api/lots names" test -n "$lot"
	local proposed_cause
	proposed_cause=$(sql "select causation_id from events where kind = 'TaskProposed' and json_extract(payload, '$.task_id') = 'T-1'")
	expect "the T-1 panel lists T-1's Events" has ui/panel.txt TaskProposed
	expect "the T-1 panel names TaskProposed's cause, seq $proposed_cause, as the Ledger records it" has ui/panel.txt "cause $proposed_cause"
	expect "the drive appended no Event: Flow only reads" same "$(sql 'select max(seq) from events')" "$base"
	chain
}

drive_agent() {
	local note="verify: name the Lot in every Artifact"
	local reason="verify: a Revision from the Agent view"
	browser ui goto '#/agent?id=A-rin' mark \
		wait '#charter' text '#vitality' 'Mood is flat in the first edition' text '#vitality' 'sample computed now' \
		text '#vitality' 'Policy' count '#vitality [class*="mood"]' 0 \
		count '#merit tbody tr' 2 save '#merit' merit.txt \
		fill '#coach-A-rin-note' "$note" click '#coach-A-rin button' \
		text '#answer' 'Appended HumanCoached' text '#coaching' "$note" \
		click '#revise-A-rin-panel > summary' fill '#revise-A-rin-reason' "$reason" click '#revise-A-rin button' \
		text '#answer' 'Appended AgentDefinitionRevised' same-page
	step org.json api get org
	expect "/api/org has Rin at version 2 with the typed revision_reason" \
		same "$(jq -r '.agents["A-rin"].definition | "\(.version) \(.revision_reason)"' "$out/org.json" 2>/dev/null)" "2 $reason"
	step training.json api get training
	expect "/api/training holds the Coaching for Rin" \
		same "$(jq -r --arg n "$note" '[.coaching["A-rin"][]? | select(.note == $n)] | length' "$out/training.json" 2>/dev/null)" 1
	expect "the Merit section lists Rin's Review on T-1 from the workflow run" has ui/merit.txt T-1
	expect "the Merit section lists Rin's Review on T-4 from the workflow run" has ui/merit.txt T-4
	expect "the drive appended HumanCoached, then AgentDefinitionRevised ($(kinds_since))" \
		same "$(sql "select group_concat(kind, ' ') from (select kind from events where seq > $base and kind in ('HumanCoached', 'AgentDefinitionRevised') order by seq)")" 'HumanCoached AgentDefinitionRevised'
	rows_since
	chain
}

drive_gates() {
	browser request goto '#/org' \
		click '#act-A-bram > summary' fill '#retire-request-A-bram-reason' 'verify: a Gate to reject' \
		click '#retire-request-A-bram button' text '#answer' 'Appended GateRequested' \
		click '#act-A-mabel > summary' fill '#retire-request-A-mabel-reason' 'verify: a Gate to approve' \
		click '#retire-request-A-mabel button' text '#answer' 'Appended GateRequested'
	step gates-open.json api get gates
	local reject approve hash
	reject=$(jq -r '[.gates[] | select(.payload.agent_id == "A-bram")] | last | .id' "$out/gates-open.json")
	approve=$(jq -r '[.gates[] | select(.payload.agent_id == "A-mabel")] | last | .id' "$out/gates-open.json")
	hash=$(jq -r --arg g "$reject" '.gates[$g].payload_hash' "$out/gates-open.json")
	browser decide goto '#/gates' mark \
		wait "[data-gate=\"$reject\"] table.diff" wait "[data-gate=\"$approve\"] table.diff" \
		fill "#reject-$reject-reason" 'verify: rejected from the Gates view' click "#reject-$reject button" \
		text '#answer' 'Appended GateDecided' gone "[data-gate=\"$reject\"] .state-open" \
		fill "#approve-$approve-reason" 'verify: approved from the Gates view' click "#approve-$approve button" \
		text '#answer' 'Appended GateDecided' gone "[data-gate=\"$approve\"] .state-open" \
		text "[data-gate=\"$reject\"]" "decided by $VERIFY_OPERATOR" same-page
	step decide-again.txt api act gate-decide "{\"gate_id\":\"$reject\",\"decision\":\"approve\",\"hash\":\"$hash\",\"reason\":\"verify: a second decision\"}" --expect 409
	expect "a second decision on $reject is refused with 409" has decide-again.txt 'GateDecided refused'
	expect "the drive appended two GateDecided rows: $reject rejected, $approve approved, each by $VERIFY_OPERATOR over its payload hash" \
		same "$(sql "select group_concat(json_extract(payload, '$.gate_id') || ':' || json_extract(payload, '$.meaning'), ' ') from (select payload from events where seq > $base and kind = 'GateDecided' and actor = '$VERIFY_ACTOR' order by seq)")" "$reject:reject $approve:approve"
	expect "each decision names $VERIFY_OPERATOR as decided_by, the signer of the record" \
		same "$(sql "select group_concat(json_extract(payload, '$.decided_by.email'), ' ') from (select payload from events where seq > $base and kind = 'GateDecided' order by seq)")" "$VERIFY_OPERATOR $VERIFY_OPERATOR"
	expect "the rejected decision signs the hash the page read ($hash)" \
		same "$(sql "select json_extract(payload, '$.payload_hash') from events where seq > $base and kind = 'GateDecided' and json_extract(payload, '$.gate_id') = '$reject'")" "$hash"
	step org.json api get org
	expect "approving a RetireAgent Gate retires nobody by itself: Mabel is not retired" \
		same "$(jq '.agents["A-mabel"].retired' "$out/org.json" 2>/dev/null)" false
	rows_since
	chain
}

drive_ledger() {
	step verify-before.json api get ledger/verify
	step org.json api get org
	local head cause verb=pause body='{"agent_id":"A-thorne","reason":"verify: a live Event on the Ledger view"}'
	if [ "$(jq '.agents["A-thorne"].paused' "$out/org.json")" = true ]; then
		verb=resume body='{"agent_id":"A-thorne"}'
	fi
	head=$(jq .count "$out/verify-before.json")
	cause=$(sql "select max(seq) from events where kind like 'Agent%' and 'A-thorne' in (json_extract(payload, '$.id'), json_extract(payload, '$.agent_id'), json_extract(payload, '$.definition.id'))")
	browser ui goto '#/ledger' mark \
		text '.verdict' "Ledger verified: $head Events, chain intact" wait "#event-$head" \
		click "#payload-$head > summary" wait "#payload-$head[open]" \
		outside "$verb" "$body" \
		wait "#event-$((head + 1))" wait "#payload-$head[open]" \
		text "#event-$((head + 1)) td:nth-child(3)" "$VERIFY_OPERATOR" \
		click '[data-reload]' text '.verdict' "Ledger verified: $((head + 1)) Events, chain intact" \
		click "#event-$((head + 1)) td.cause a" wait "#event-$cause" \
		same-page
	expect "the live Event's actor names the person who acted: $VERIFY_ACTOR" \
		same "$(sql "select actor from events where seq = $((head + 1))")" "$VERIFY_ACTOR"
	expect "the live Event ($verb Thorne, seq $((head + 1))) names his previous Org Event (seq $cause, his Recruitment on the baseline) as its cause, and its cause link opened that page" \
		same "$(sql "select causation_id from events where seq = $((head + 1))")" "$cause"
	rows_since
	chain
}

drive_chat() {
	local said=$((base + 1)) conductor='{"tag":"Conductor"}'
	local report='Received 3 bottles of Vitamin C 500 mg capsules, Lot 2403A, Product Code VC500, Product Type 60 ct HDPE bottle, finished product, from Acme Nutrition, regular TAT. Report to: Acme Nutrition; Contact: Dana Reyes; Address: 12 Harbor Road; City: Portland, OR 97201'
	local results='Lab Ref 26-0412, notebook NB-07 p.31. Container 1: 10.246 g for 20 capsules, 10.246 g taken. Container 2: 10.198 g for 20 capsules, 10.198 g taken. Container 3: 10.302 g for 20 capsules, 10.302 g taken.'
	local second='verify: a second client says this'
	browser ui goto '#/chat' mark \
		wait '#chat-say' text 'li.message .said b' 'Odile' \
		text '.note' 'aliquot intake' \
		fill '#chat-body' "$report" click '#chat-say button' \
		text '#answer' "Appended MessageSent at seq $said" \
		text "li.message[data-seq=\"$said\"] .body" "$report" \
		text "li.message[data-seq=\"$said\"] .said b" "$VERIFY_OPERATOR" \
		text 'ol.chat > li:last-child .said' "replying to seq $said" \
		text 'ol.chat > li:last-child .said b' 'Conductor' \
		text 'ol.chat > li:last-child .body' 'Logged LR-2026-0003, LR-2026-0004, LR-2026-0005 on WO-2026-0002, due ' \
		same-page \
		fill '#chat-body' "$results" click '#chat-say button' \
		text 'ol.chat > li:last-child .said b' 'Conductor' \
		text 'ol.chat > li:last-child .body' 'The Report of Analysis of LR-2026-0003 waits on G-' \
		same-page \
		outside room-say "$(jq -cn --arg b "$second" '{room_id: "RM-lab", body: $b}')" \
		text 'ol.chat > li:last-child .body' "$second" same-page
	step chat.json api get chat
	step gates.json api get gates
	local asked replied
	asked=$(sql "select seq from events where kind = 'MessageSent' and seq > $said and json_extract(payload, '$.body') = '$results'")
	expect "/api/chat ends with the receipt, the Conductor's reply naming the Lab References, the results, the Conductor's reply naming the Gate, then the second client's Message, after Odile's from the baseline" \
		same "$(jq -r --argjson b "$base" '[.messages[] | select(.seq > $b) | "\(.name): \(.body[0:32])"] | join(" | ")' "$out/chat.json")" \
		"$VERIFY_OPERATOR: ${report:0:32} | Conductor: Logged LR-2026-0003, LR-2026-000 | $VERIFY_OPERATOR: ${results:0:32} | Conductor: The Report of Analysis of LR-202 | $VERIFY_OPERATOR: ${second:0:32}"
	expect "the Messages are in seq order, newest last" \
		same "$(jq -c '[.messages[].seq] == ([.messages[].seq] | sort)' "$out/chat.json")" true
	for m in "$said" "$asked"; do
		replied=$(sql "select round((julianday(r.ts) - julianday(o.ts)) * 86400000) from events o join events r on r.causation_id = o.seq and r.kind = 'MessageSent' and r.actor = '$conductor' where o.seq = $m")
		replied=${replied%.0}
		printf 'seq %s answered after %s ms\n' "$m" "$replied" >>"$out/reply-times.txt"
		expect "the Conductor's reply to seq $m was appended ${replied:-never} ms after it, within the 5000 ms bound ([reply-times.txt]($feature/reply-times.txt))" \
			test "${replied:-99999}" -lt 5000
	done
	expect "no Agent got a Turn: no TurnStarted since the drive began" \
		same "$(sql "select count(*) from events where seq > $base and kind = 'TurnStarted'")" 0
	expect "the results Chain left ${conductor} an open ExternalMessage Gate naming the report's PDF and LR-2026-0003" \
		same "$(jq -r '[.gates[] | select(.requester.tag == "Conductor") | "\(.kind) \(.payload.lab_reference) \(.decision == null)"] | join(",")' "$out/gates.json")" \
		"ExternalMessage LR-2026-0003 true"
	expect "every Event the Conductor appended reaches an Operator's MessageSent of this drive through its causes" \
		same "$(sql "with recursive walk(start, at) as (select seq, causation_id from events where seq > $base and actor = '$conductor' union all select w.start, e.causation_id from walk w join events e on e.seq = w.at where not (e.kind = 'MessageSent' and e.actor = '$VERIFY_ACTOR')) select count(*) from events c where c.seq > $base and c.actor = '$conductor' and not exists (select 1 from walk w join events m on m.seq = w.at where w.start = c.seq and m.kind = 'MessageSent' and m.actor = '$VERIFY_ACTOR' and m.seq > $base)")" 0
	expect "the drive's MessageSent rows are the Operator's three and the Conductor's two replies, each naming the Message it answers" \
		same "$(sql "select group_concat(json_extract(actor, '$.tag') || ':' || ifnull(causation_id, '-'), ' ') from (select * from events where seq > $base and kind = 'MessageSent' order by seq)")" \
		"Operator:- Conductor:$said Operator:- Conductor:$asked Operator:-"
	rows_since
	chain
}

case $feature in
org | flow | agent | gates | ledger | chat | access | views)
	# Called in a || list, the drive runs to its end past a failing command;
	# its checks, not errexit, decide the verdict.
	"drive_$feature" || {
		failed=$((failed + 1))
		evidence+=("- FAIL. the drive's last command exited $?")
	}
	;;
*) die "drive.sh knows org, flow, agent, gates, ledger, chat, access and views; add a drive_$feature for features/$feature.md" ;;
esac

verdict="PASS. $checked of $checked checks held."
[ "$failed" -eq 0 ] || verdict="FAIL. $failed of $checked checks failed."
{
	printf '\n## %s\n\n' "$(sed -n '1s/^# //p' "$map")"
	printf 'Intent, from [features/%s.md](%s):\n\n> %s\n\n' "$feature" "$map" "$intent"
	printf '### Commands\n\n```sh\n'
	printf '%s\n' "${commands[@]}"
	printf '```\n\n### Evidence\n\n'
	printf '%s\n' "${evidence[@]}"
	printf '\n### Verdict\n\n**%s** Driven at %s from Ledger seq %s.\n' "$verdict" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$base"
} >>"$PROOF/proof.md"
printf '%s: %s See %s/proof.md\n' "$feature" "$verdict" "$PROOF"
[ "$failed" -eq 0 ]
