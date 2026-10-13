# Agent page

The Agent view at `#/agent?id=<id>` shows one Agent's Charter, Persona, Vitality and Policy (no Mood badge: Mood is flat since #62), Merit after each Review counted toward it, Memory notes, Coaching and Skills, and lets the Operator open the Agent's Room, give Coaching, and author a Revision of its definition.

## Sub-features

- `agent-index` lists the Agents at `#/agent` with links to each page.
- `agent-sections` draws `#charter`, `#persona`, `#vitality`, `#merit`, `#notes`, `#coaching` and `#skills`.
- `agent-vitality` shows the Agent's latest `VitalitySampled`, which the Conductor writes at the end of a Turn; with no Turn yet (every baseline run, since `serve` runs with `--no-schedule`) it shows one computed now and says `sample computed now`. The section's heading reads `Vitality (Mood is flat in the first edition)`.
- `agent-merit` draws one row and one chart point per Review counted toward Merit: Task, Reviewer, the five rubric scores, the Merit after it (the mean over the Agent's last 20 reviewed Tasks at that point, not the Review's own score) and the note; with no counted Review it prints `No Reviews yet.` and no table.
- `agent-coach` gives Coaching with an optional Task (`form#coach-<id>`, verb `coach`); it appears under `#coaching`.
- `agent-revise` authors a Revision in `#revise-<id>-panel`: a JSON editor over the next version (version one higher, `revised_by` the Operator) and a reason that becomes `revision_reason`.
- `agent-room` links the Agent's Room (`#room-<id>`), or opens one as the Operator from `form#room-open-<id>` and goes to `#/rooms?id=RM-<slug>`, where the slug is the Agent id without `A-` (`RM-rin`). Not in `drive_agent`.

## How to get to it (user POV)

- Choose an Agent's name in the Org view, or `Agent` in the navigation and then a name.
- Go to `#/agent?id=A-rin`.

## Driving it with drive.sh and browser.mjs

Preconditions:

- The baseline of [README.md](./README.md): Rin at version 1, reviewed on T-1 and T-4 by the workflow run.

- **Whole drive.** Run `scripts/drive.sh "$RUN" agent`.
- **Sections and Merit.** `scripts/browser.mjs "$RUN" agent/ui goto '#/agent?id=A-rin' wait '#charter' text '#vitality' 'Mood is flat in the first edition' text '#vitality' 'sample computed now' count '#merit tbody tr' 2 save '#merit' merit.txt`. `merit.txt` lists T-1 and T-4, Rin's two counted Reviews.
- **Coaching.** `fill '#coach-A-rin-note' 'verify: name the Lot in every Artifact' click '#coach-A-rin button' text '#answer' 'Appended HumanCoached' text '#coaching' 'verify: name the Lot in every Artifact'`.
- **Revision.** `click '#revise-A-rin-panel > summary' fill '#revise-A-rin-reason' 'verify: a Revision from the Agent view' click '#revise-A-rin button' text '#answer' 'Appended AgentDefinitionRevised'`.
- **Proof.** `scripts/api.sh "$RUN" get org` has Rin at `definition.version` 2 with the typed `revision_reason`; `scripts/api.sh "$RUN" get training` has the note under `.coaching["A-rin"]`; the `HumanCoached` and `AgentDefinitionRevised` rows are in `home/ledger.sqlite`.

## Gotchas

- The Coaching Event kind is `HumanCoached`, not `CoachingGiven`.
- The Revision editor is pre-filled. A redraw restores only a field the Operator changed, so after a Revision the editor shows the next version again; a Revision that keeps the current version shows the Ledger's refusal.
- The Room action goes to `#/rooms?id=RM-<slug>`, which shows the Rooms JSON: the Rooms view is not drawn yet (Gate G1).
- A Revision is also refused for an unpublished Skill, a `forbidden` entry that is not an Action, a `trust_tier` other than the projected one, or a `revised_by` that is not the actor; the editor pre-fills all four lawfully, so only a changed field can trip them.
- The Merit table covers every Review counted toward Merit, in Ledger order; the `Probation` workflow run gives Rin two.
