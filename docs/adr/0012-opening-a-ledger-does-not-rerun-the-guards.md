---
status: proposed
---

# Opening a Ledger does not re-run the guards

The rules at append get stricter over time, as ADR-0011 made them for tier Revisions, and a Ledger keeps every Event its rules accepted when it was written. When the Ledger opens, it builds the Projections from its Events and does not run the guards again. Only a stored Event that a Projection cannot apply makes the Ledger corrupt. So a Ledger written under older rules still opens, and its Events keep the meaning they had when they were recorded.

## Considered Options

- Re-run the guards on open and report any Event they refuse as corruption. Rejected because every stricter rule would then make a lawful history unreadable, and history is never migrated (ADR-0001).
- Rewrite stored Events so that they pass the rules in force. Rejected because it changes what the audit trail says happened and breaks the hash chain.

## Consequences

- A guard holds policy for new Events. A Projection holds only what the state can express, and it must apply every Event that any earlier rule accepted.
- A Ledger that the rules in force would not write is repaired by appending, never by editing: the tier catch-up of ADR-0011 appends the Revisions that an older Ledger lacks and says that they are recorded late.
- Tests that need a Ledger written under older rules write it with `conductor/src/test-support/forge.ts`. The Ledger itself has no option that turns a rule off.
