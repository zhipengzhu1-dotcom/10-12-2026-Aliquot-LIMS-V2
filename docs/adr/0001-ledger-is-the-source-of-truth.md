---
status: proposed
---

# The Ledger is the source of truth and everything else is a Projection

The lab is regulated, so every change made by an Agent or the Operator must be attributable and tamper-evident. We record all state as Events in one append-only, hash-chained Ledger. The org chart, Task states, Moods, Trust tiers, dashboards, and every interface view are Projections computed from it.

## Considered Options

- Mutable tables plus an audit log table. Rejected because the audit table and the live tables can disagree, and nothing proves which one is right.

## Consequences

- Reducers must be deterministic. A Projection rebuilt from the same Ledger gives the same result, so review sampling and allocation must not use wall-clock time or randomness that the Ledger does not record.
- A schema change is a new Event kind. Nobody migrates history.
- Rebuilding a Projection from scratch must stay cheap enough to do on startup.
