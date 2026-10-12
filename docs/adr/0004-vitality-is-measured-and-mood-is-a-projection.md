---
status: proposed
---

# Vitality is measured from signals, and Mood is a Projection that limits behavior

The Operator wants Moods that change what Agents do. We compute Vitality from Ledger signals (load, fatigue, friction, confidence, and morale), derive Mood from Vitality with fixed thresholds, and derive Policy from Mood. An Agent's own words about how it feels never become system state. The Persona colors how an Agent talks about its Mood but cannot change its Policy.

## Considered Options

- Role-played state that the system reads back from the Agent's text. Rejected because it cannot be audited, reproduced, or trusted to limit behavior.

## Consequences

- Any Mood can be reproduced from the Ledger, so the Auditor can check that each Hand-off or Rest followed from the numbers.
- The thresholds are guesses until slice 1 produces data. See `docs/design/vitality-and-merit.md`.
