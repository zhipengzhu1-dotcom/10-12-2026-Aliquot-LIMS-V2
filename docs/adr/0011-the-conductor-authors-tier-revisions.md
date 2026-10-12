---
status: proposed
---

# The Conductor authors the tier Revisions that Merit and Gates require

An Agent definition records its Trust tier (ADR-0005), and the Trust tier is projected from Merit, tenure and `PromoteToMentor` Gates (ADR-0007). The definition must never disagree with the Projection. After every append, in the same transaction, the Ledger appends an `AgentDefinitionRevised` for each live Agent whose recorded tier differs from its projected tier. The actor `Conductor` authors these Revisions, and each one names the Event that caused it through `causation_id`. The Conductor authors no other Event.

## Considered Options

- The Operator as author. Rejected because it records a decision the Operator never made, and every Event must be attributable.
- The actor of the causing Event. Rejected because a Supervisor's Review would then revise a Specialist's definition, which is authority the Supervisor does not have.
- Callers append the Revisions. Rejected because callers forget. The Gate path never appended one.

## Consequences

- A Revision of `trust_tier` that differs from the projected tier is refused, whoever authors it.
- A Ledger written before this decision catches up on its first append.
