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
- The chat flow ends at an `ExternalMessage` Gate requested by A-ines, the stage 6 Specialist, whose payload is `{"artifact_id": <the PDF Report of Analysis>, "lab_reference": <its Lab Reference>}` (README "Chat"). It names no Task, so `Blocks` reads `no Task`.

## Driving it with drive.sh and browser.mjs

Preconditions:

- The baseline of [README.md](./README.md): no Gate open.

- **Whole drive.** Run `scripts/drive.sh "$RUN" gates`.
- **Request two Gates from the Org view.** `scripts/browser.mjs "$RUN" gates/request goto '#/org' click '#act-A-bram > summary' fill '#retire-request-A-bram-reason' 'verify: a Gate to reject' click '#retire-request-A-bram button' text '#answer' 'Appended GateRequested'`, then the same for `A-mabel`.
- **Read the ids and hash.** `scripts/api.sh "$RUN" get gates` gives the Gate ids by `payload.agent_id` and each `payload_hash`.
- **Reject and approve.** `scripts/browser.mjs "$RUN" gates/decide goto '#/gates' wait '[data-gate="G-1"] table.diff' fill '#reject-G-1-reason' 'verify: rejected from the Gates view' click '#reject-G-1 button' text '#answer' 'Appended GateDecided' gone '[data-gate="G-1"] .state-open'`, then `approve` on `G-2` the same way.
- **Refusal.** `scripts/api.sh "$RUN" act gate-decide '{"gate_id":"G-1","decision":"approve","hash":"<hash>","reason":"again"}' --expect 409`. The body starts `GateDecided refused`.
- **Proof.** Two `GateDecided` rows by `{"tag":"Operator"}`, each with the Gate's `payload_hash`, and `/api/org` still has Mabel with `retired: false`.

## The chat flow's ExternalMessage Gate, by hand

`drive.sh` has no case for it: the Gate comes from scripted Turns, which need `serve` stopped. Ticket 61 drove it by hand on a `launch.sh --port <n>` run, in this order:

1. Say the receiving Message in `#/chat` with `browser.mjs` (the `chat` drive's report text).
2. Stop serve with SIGTERM to the pid in `home/ledger.sqlite.lock`, register `parse_message` and `parse_results_message` (README "Chat"; `workflow run` registered stages 2 to 6), and run the Turns with `ALIQUOT_SCRIPTED_MODEL`, one file per Turn: Odile proposes and assigns, Bram works stages 2 and 3, Pia reviews.
3. Restart serve on the same port with `--no-schedule`, write its pids into `run.env` so `cleanup.sh` stops it, and say the results Message in `#/chat`.
4. Stop serve again and run the Turns: Odile, Rin (store, `S-parse_results_message`, stage 4, hand on), Bram (stage 5, hand on), Ines (stage 6, `request_gate`, reply), then Pia and Anselm review.
5. Restart serve, then approve in `#/gates`: `wait '[data-gate="G-1"] .state-open' text '[data-gate="G-1"] .kind' 'ExternalMessage' fill '#approve-G-1-reason' '<reason>' click '#approve-G-1 button' text '#answer' 'Appended GateDecided' text 'li.gate[data-gate="G-1"]' 'Approved'`.

Proof: `/api/gates` has G-1 approved by the Operator, its `GateDecided` names the `GateRequested` as cause, and Ines's reply in RM-lab names G-1 and the PDF. The PDF's text shows the receipt's Report To contact, address and city and its Product Type (`render_roa` refuses a blank one, so a receipt without them is refused by `parse_message` at step 2 and the flow stops there). The ticket 61 report links the run's `proof.md` and the lever script that wrote each Turn's file.

## Gotchas

- The action body says `decision`, but the `GateDecided` row stores it as `meaning` (`approve` or `reject`) beside `decided_by`, `decided_at` and `payload_hash`. Query `json_extract(payload, '$.meaning')`.
- Approving a `RetireAgent` Gate retires nobody. `org retire <id> --gate G-<n>` does, and only while `serve` is stopped.
- The decide form signs the hash the page read when it drew; a Gate's payload never changes (a second `GateRequested` with the same id is refused), so a hash refusal is reachable only by posting a wrong hash through `api.sh act`, and it shows in `#answer`, not in the Gates view.
- The drive's two Gates come from `Request retirement` in the Org view, so their requester is the Operator; Bram and Mabel are only the Agents the payloads name. A `PromoteToMentor` request or approval is also refused while the Agent holds an unused approved one.
- An expired Gate shows as `Expired` with no Event; the default lifetime is 86400 seconds, so a drive never sees one without `gate request --lifetime`.
- `PromoteToMentor` approval does not change the tier by itself: the tier rises only when Merit and tenure meet the tier's bar, which the baseline's two Reviews do not.
- On the launch baseline, the chat receipt's `S-log_receipt` Run carries the Fixture's toy LIMS database when the scripted Turn names it, as the Director's goal says, so its Lab References continue at `LR-2026-0003`. Read Lab References from the Run's outputs, never by number.
- Approving an `ExternalMessage` Gate sends nothing; the `GateDecided` is the whole effect.
