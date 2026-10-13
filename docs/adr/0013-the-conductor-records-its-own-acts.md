---
status: proposed
---

# The Conductor records its own acts

The Conductor schedules Turns, and fatigue is the tokens an Agent's Turns used in the rolling 5-hour window (ADR-0004). Fatigue must come from the Ledger, so the Ledger must record each Turn and its usage. The Conductor starts a Turn and receives its result. No Agent and not the Operator does either. So the Conductor records the Events it causes itself, its own acts: `TurnStarted` and `TurnFinished`, and `ActionRefused`, the refusal of a Tool call by its hook. The Vitality sample it takes at the end of each Turn is its act too: it records that `VitalitySampled` itself, naming the Turn's `TurnFinished` as the cause, and the Ledger refuses a sample by the Conductor that names no `TurnFinished` of the same Agent, while the Operator and the Agents still record samples of their own. The scheduler's assignment of a Proposed Task that no one assigned within a tick is its act too: it records that `TaskAssigned` itself, naming the Task's previous Event as the cause, and the Ledger refuses an assignment by the Conductor of a Task that is not Proposed or that names another cause, while the Operator and the Agents still assign Tasks themselves. This amends ADR-0011, which says that the Conductor authors only tier Revisions. The Conductor still authors the tier Revisions of ADR-0011, and the Ledger still refuses every other Event by the Conductor.

Each act is recorded by the actor `Conductor` and by no one else. The Ledger refuses a `TurnStarted` or a `TurnFinished` from an Agent or the Operator. A `TurnFinished` names its Turn's `TurnStarted` in `causation_id`. No command line acts as the Conductor, so no command writes these Events. The Turn lifecycle (`conductor/src/turn/lifecycle.ts`) appends them, and the Conductor's Turn loop calls it.

A refusal is the Conductor's act too. The hook that runs before every Tool call is the Conductor's, not the Agent's: it refuses a call that performs an Action the Agent's Charter forbids, or that the Agent's Policy forbids. The Agent did not record the refusal and the Operator did not decide it, so the Conductor records it as `ActionRefused`, naming the Agent, the Tool, the Action or `Policy`, the reason, and the Task when the call named one. Its cause is the `TurnStarted` of the Agent's open Turn. The Ledger refuses an `ActionRefused` from an Agent or the Operator. The Tools lifecycle (`conductor/src/tools/lifecycle.ts`) appends it. `tools call` runs the same hook from the command line, so a refusal it meets is recorded the same way; no command takes the Conductor as its `--as`.

## Considered Options

- The Operator as author. Rejected for the reason ADR-0011 gives: it records a decision the Operator never made.
- The Agent as author of its own Turn. Rejected because an Agent does not start its Turn, and its usage is what the model reports to the Conductor, not what the Agent says.
- Token use outside the Ledger, in a log or a counter. Rejected because a Vitality sample must be recomputable from the Ledger (ADR-0004), and the Auditor must be able to check every Mood.

## Consequences

- Fatigue is the sum of input, output and cache creation tokens of the Agent's `TurnFinished` Events in the trailing 5 hours, divided by its share of the Energy budget. Cache reads are recorded but not counted. `vitality sample` takes no token count from the command line.
- A new kind of act joins the list of acts in the Conductor guard (`conductor/src/org/guards.ts`), and its own domain's guard refuses it from any other actor.
- A Ledger written before this decision holds no Turn Events, so it opens unchanged (ADR-0012), and its Agents' fatigue is 0 until they have Turns.
- Every refused attempt is in the Ledger, so the Auditor and a Review's boundary score can read it. A call the hook allows and the Ledger then refuses is not an `ActionRefused`: the Ledger's refusal text goes back to the model and nothing is appended.
