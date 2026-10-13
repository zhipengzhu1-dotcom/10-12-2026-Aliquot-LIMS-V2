# Org tree and its Actions

The Org view at `#/org` draws the reporting tree that `org tree` prints, each Agent with its Mood, Trust tier, load and a `paused` badge, and lets the Operator pause and resume an Agent, order Rest through the Action bar, reassign it, and request its retirement, with the tree redrawn from the Event stream and no reload.

## Sub-features

- `org-tree` draws the Operator, Odile (Director), Pia and Anselm (Supervisors), the Specialist pool under both (Rin, Ines, Bram), Mabel (Steward) and Thorne (Auditor).
- `org-pause` pauses an Agent with a reason from its Actions panel; the `paused` badge and a Resume button appear.
- `org-resume` resumes a paused Agent; a second resume is refused with `AgentResumed refused: <id> is not paused`.
- `org-rest` orders Rest through the Action bar's `rest-order` verb; the Mood badge reads `resting`.
- `org-reassign` revises `supervisor_id` through the Reassign form; the Agent moves in the tree.
- `org-retire-request` requests a `RetireAgent` Gate; it appears in `#/gates` (see [gates.md](./gates.md)).
- `org-live` redraws the tree when another client appends an Event, keeping open panels and typed text.
- `org-promotion` shows the Trust tier badge. No view action promotes: the tier follows Merit, and `Mentor` also needs an approved `PromoteToMentor` Gate.

## How to get to it (user POV)

- Open the interface and choose `Org` in the navigation, or go to `#/org`.
- Open an Agent's `Actions` disclosure under its line.
- Type a verb and a JSON body into the Action bar above every page, and choose `Run`.

## Driving it with drive.sh and browser.mjs

Preconditions:

- The baseline of [README.md](./README.md): Rin running, Ines not resting, `doctor.sh` ok.

- **Whole drive.** Run `scripts/drive.sh "$RUN" org`. It runs the Pause, Redraw, Refused resume, Rest and Proof bullets below and appends the Org section to `proof/proof.md`; Reassign and Request retirement are driven by hand (the Gates drive requests two retirements).
- **Pause from the view.** Open Rin's panel, type a reason, choose Pause. `scripts/browser.mjs "$RUN" org/ui goto '#/org' mark click '#act-A-rin > summary' fill '#pause-A-rin-reason' 'verify: pause Rin from the Org view' click '#pause-A-rin button' text '#answer' 'Appended AgentPaused' wait '[data-agent="A-rin"] .badge.paused' wait '#resume-A-rin'`. The status line reads `Appended AgentPaused at seq <n>` and Rin shows `paused` and the Resume form `#resume-A-rin` in place of the Pause one.
- **Redraw over the stream.** In the same browser run, another client resumes Rin: `outside resume '{"agent_id":"A-rin"}' gone '[data-agent="A-rin"] .badge.paused'`. The badge goes with no reload (`same-page` holds).
- **Refused resume.** `scripts/api.sh "$RUN" act resume '{"agent_id":"A-rin"}' --expect 409`. The body is `AgentResumed refused: A-rin is not paused`.
- **Rest through the Action bar.** `fill '#action input[name=verb]' rest-order fill '#action textarea[name=body]' '{"agent_id":"A-ines","action":"begin","reason":"verify: Rest from the Action bar"}' click '#action button' text '#answer' 'Appended RestOrdered' wait '[data-agent="A-ines"] .badge.mood-resting'`. The Mood badge is `.badge.mood-<mood>`; `.badge` alone also matches the tier and paused badges.
- **Reassign.** `click '#act-A-mabel > summary' choose '#revise-A-mabel-supervisor' A-odile fill '#revise-A-mabel-reason' 'verify: report to Odile' click '#revise-A-mabel button' text '#answer' 'Appended AgentDefinitionRevised'`. Mabel's line moves under Odile. Not in `drive_org`.
- **Proof.** `scripts/api.sh "$RUN" get org` has `.agents["A-rin"].paused == false`; `scripts/api.sh "$RUN" get vitality` has `.["A-ines"].mood == "resting"`; `sqlite3 "$RUN/home/ledger.sqlite" "select seq, kind, actor, payload from events where kind in ('AgentPaused','AgentResumed','RestOrdered')"` shows the three rows with actor `{"tag":"Operator"}`; `tools/aliquot --home "$RUN/home" ledger verify` says chain intact.

## Gotchas

- The view offers Pause only on a running Agent and Resume only on a paused one, so a refusal is reachable only from a second client: `AgentResumed refused: <id> is not paused`, or, since #48, `AgentPaused refused: <id> is already paused`. A drive that pauses an Agent another drive left paused fails with the second text; the recipes use different Agents for this reason.
- The Actions panel is a `<details>`. Open `#act-<id> > summary` before filling its form, so the screenshots show the form the Operator sees. A redraw keeps it open.
- The status line `#answer` keeps the last answer. Wait for the text of this action (`Appended AgentPaused`), not for the line to be non-empty.
- Rest has no form in the Org view; it is the Action bar's `rest-order` verb. `end` needs Rest in effect, or the Ledger refuses it.
- The load meter reads 0.00 for every Agent on the baseline: the workflow's Tasks are all `Done`.
