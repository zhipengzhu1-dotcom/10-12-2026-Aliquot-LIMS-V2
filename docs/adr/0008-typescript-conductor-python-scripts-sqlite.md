---
status: proposed
---

# A TypeScript Conductor, Python Scripts in the Sandbox, and SQLite with a single writer

The Agent SDK and the interface are TypeScript, and the lab's files (xlsx, docx, and PDF) have the strongest libraries in Python. The Conductor is TypeScript on Node. Scripts are Python in the Sandbox. The Ledger and the toy LIMS database are SQLite files, and only the Conductor writes to the Ledger.

## Considered Options

- All Python. Rejected because the Agent SDK and the interface are TypeScript first.
- Postgres. Rejected for now because it adds a service to run and gives one writer on one Mac nothing.

## Consequences

- There is exactly one Ledger writer process. A second process that wants to write must go through the Conductor.
- Moving the Ledger to Postgres later is a change to one storage adapter.
