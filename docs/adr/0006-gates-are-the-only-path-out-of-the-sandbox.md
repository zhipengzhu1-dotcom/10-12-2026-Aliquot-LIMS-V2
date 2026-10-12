---
status: proposed
---

# Gates are the only path to deployment, external messages, System of record writes, Retirement, and Mentor promotion

The lab must show a human decision behind every action with effects outside the Sandbox. Five Gate kinds (`Deploy`, `WriteSystemOfRecord`, `ExternalMessage`, `RetireAgent`, and `PromoteToMentor`) are the only way to perform those actions. Only the Operator may emit `GateDecided`, and that Event records who decided, when, the hash of the exact payload, and the meaning of the decision. It is the electronic signature record, in the style of 21 CFR Part 11.

## Consequences

- Each data source declares in configuration whether it is a System of record. The toy LIMS database is not, so agents write to it without a Gate. Connecting a real database changes configuration, not code.
- An approved Gate covers one payload hash. A changed payload needs a new Gate.
- An approved `PromoteToMentor` Gate covers one Promotion to Mentor. While an Agent holds an approved Gate that no Promotion has used, a new `PromoteToMentor` Gate for it is refused. An unused approval does not lapse; revoking one would be a new Event kind.
