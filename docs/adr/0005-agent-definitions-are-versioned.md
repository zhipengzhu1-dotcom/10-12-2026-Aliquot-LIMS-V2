---
status: proposed
---

# Agent definitions are versioned, and every change is a Revision Event

Agents may change their own roles, Charters, and team structure, and the lab must be able to show who changed what and why. An Agent definition is never edited in place. Each change is an `AgentDefinitionRevised` Event with an author and a reason, and only the Operator may author a Revision of the Auditor's definition.

## Considered Options

- In-place edits with a change log. Rejected for the same reason as mutable tables in ADR-0001.

## Consequences

- The Auditor stays independent. Neither the Director nor the Steward can weaken its Charter.
- Gate enforcement lives in the Conductor, not in any Charter, so a Revision cannot remove a Gate.
