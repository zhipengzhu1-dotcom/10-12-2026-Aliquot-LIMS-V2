# Gates

The Gates view at `#/gates` lists the Gates waiting on the Operator, oldest first, each with its kind, requester, age, lifetime, the Task it blocks and its payload, and for a `RetireAgent` or `PromoteToMentor` Gate a table of the Agent's fields now and as proposed; the Operator approves or rejects each with a reason, signing the payload hash the page read, and decided Gates move to the closed list.

## Sub-features

- `gates-open` lists open Gates as `article.gate[data-gate="G-<n>"]` with a `.state-open` badge.
- `gates-diff` draws `table.diff` (Field, Now, Proposed) for `RetireAgent` and `PromoteToMentor`.
- `gates-approve` posts `gate-decide` with `decision: "approve"` from `form#approve-G-<n>`.
- `gates-reject` posts `gate-decide` with `decision: "reject"` from `form#reject-G-<n>`.
- `gates-closed` lists decided and expired Gates, most recently closed first.
- `gates-refusal` surfaces the Ledger's refusal of a second decision, or of a hash that is not the Gate's, in the shell's `#answer` as `409: GateDecided refused: …`; the Gates markup itself shows nothing for it.
- Gates of kind `Deploy`, `WriteSystemOfRecord` and `ExternalMessage` list the same way with their payload JSON and no `table.diff`.

## How to get to it (user POV)

- Choose `Gates` in the navigation, or go to `#/gates`.
- A Gate appears after `Request retirement` in the Org view, `gate request` before `serve` starts, or an Agent's Turn.

## Driving it with drive.sh and browser.mjs

Preconditions:

- The baseline of [README.md](./README.md): no Gate open.

- **Whole drive.** Run `scripts/drive.sh "$RUN" gates`.
- **Request two Gates from the Org view.** `scripts/browser.mjs "$RUN" gates/request goto '#/org' click '#act-A-bram > summary' fill '#retire-request-A-bram-reason' 'verify: a Gate to reject' click '#retire-request-A-bram button' text '#answer' 'Appended GateRequested'`, then the same for `A-mabel`.
- **Read the ids and hash.** `scripts/api.sh "$RUN" get gates` gives the Gate ids by `payload.agent_id` and each `payload_hash`.
- **Reject and approve.** `scripts/browser.mjs "$RUN" gates/decide goto '#/gates' wait '[data-gate="G-1"] table.diff' fill '#reject-G-1-reason' 'verify: rejected from the Gates view' click '#reject-G-1 button' text '#answer' 'Appended GateDecided' gone '[data-gate="G-1"] .state-open'`, then `approve` on `G-2` the same way.
- **Refusal.** `scripts/api.sh "$RUN" act gate-decide '{"gate_id":"G-1","decision":"approve","hash":"<hash>","reason":"again"}' --expect 409`. The body starts `GateDecided refused`.
- **Proof.** Two `GateDecided` rows by `{"tag":"Operator"}`, each with the Gate's `payload_hash`, and `/api/org` still has Mabel with `retired: false`.

## Gotchas

- The action body says `decision`, but the `GateDecided` row stores it as `meaning` (`approve` or `reject`) beside `decided_by`, `decided_at` and `payload_hash`. Query `json_extract(payload, '$.meaning')`.
- Approving a `RetireAgent` Gate retires nobody. `org retire <id> --gate G-<n>` does, and only while `serve` is stopped.
- The decide form signs the hash the page read when it drew; a Gate's payload never changes (a second `GateRequested` with the same id is refused), so a hash refusal is reachable only by posting a wrong hash through `api.sh act`, and it shows in `#answer`, not in the Gates view.
- The drive's two Gates come from `Request retirement` in the Org view, so their requester is the Operator; Bram and Mabel are only the Agents the payloads name. A `PromoteToMentor` request or approval is also refused while the Agent holds an unused approved one.
- An expired Gate shows as `Expired` with no Event; the default lifetime is 86400 seconds, so a drive never sees one without `gate request --lifetime`.
- `PromoteToMentor` approval does not change the tier by itself: the tier rises only when Merit and tenure meet the tier's bar, which the baseline's two Reviews do not.
