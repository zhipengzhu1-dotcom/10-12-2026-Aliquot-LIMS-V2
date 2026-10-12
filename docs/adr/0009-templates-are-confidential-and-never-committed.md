---
status: proposed
---

# The real templates are confidential and never committed, and Fixtures come from a synthetic generator

The files in `Templates/` are records of a regulated lab and carry real Client names, contact names, Lot numbers, and Product Codes. `.gitignore` excludes `Templates/`. A synthetic generator copies only their shape (sheet layout, column headers, field labels, and formula patterns) and fills it with invented Clients, products, Lots, and dates. No Fixture, prompt example, or document in this repository quotes a template.

## Consequences

- If real-shaped data becomes necessary, the path is scrubbed copies made under an explicit Operator decision, not the originals.
