---
status: proposed
---

# Trust tiers projected from Merit set review depth and allocation, and Mentor promotion needs a Gate

The Operator wants rewards that change what an Agent may do. We project a Trust tier (`Probation`, `Trusted`, `Senior`, or `Mentor`) from each Agent's Merit and tenure. The tier sets how many of its Tasks get a Review and how much work the Conductor offers it. Promotion to `Mentor` also needs a `PromoteToMentor` Gate.

## Considered Options

- Static roles with fixed permissions. Rejected because they give the Operator no reward to grant and no signal to act on.

## Consequences

- An Agent that does good work gets fewer Reviews. The Auditor samples Reviews at every tier to catch drift.
- A boundary score of 0 demotes one tier at once, so one serious violation costs more than many small mistakes.
