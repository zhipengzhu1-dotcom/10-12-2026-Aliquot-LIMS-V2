---
status: accepted
---

# This repository is the automation engine behind the human LIMS

Slices 0 to 2 built a society of Agents that was meant to run the lab. Its Agents have Vitality, Merit, Reviews and Trust tiers, train each other, and rewrite their own Scripts. The owner also builds a second application, aliquot-lims-dev (served at `app.nitrolims-demo.com`), which is the lab's LIMS for people. In a regulated lab a named person reviews each result, a second person checks it, QA releases the report, and an OOS investigation has an owner. An Agent cannot be that person. On 2026-10-13 the owner ruled that aliquot-lims-dev stays the human LIMS and that this repository is the automation engine behind it.

The human LIMS keeps people, roles, two-person review, QA release, OOS investigations and the Client portal. The engine reads submissions, logs receipts, computes results and drafts reports, and every human act it records names the person (#74). The engine's Agents, Scripts, Gates and Ledger stay as built. A Gate decision is still the Operator's signature (ADR-0006), and a report still leaves the engine only through a Gate.

The society machinery, Vitality, Merit, Reviews, Trust tiers and Training, is not on the first edition's path. Nothing is deleted. Its Events stay in the Ledger, its commands and views stay, and Mood stays flat (#62). No ticket builds on it or removes it until the owner decides. An Agent's Review is not the lab's two-person review, and a Trust tier releases nothing.

Reverse word: `society`, which makes the society the product again and puts its machinery back on the roadmap.

## Considered Options

- The society as the product, as the overview said until now. Rejected because the lab's accountable acts need named people, and the human LIMS already holds them.
- Delete the society machinery. Rejected because the owner kept it, and a Ledger written with its Events must still open (ADR-0012).
- Merge the engine into aliquot-lims-dev now. Rejected because the seam between them comes after slice 3, once the engine has run beside the lab's own work (ADR-0018).

## Consequences

- The roadmap brings identity forward before slice 3 (#74). Each person-authored Event names the person by email, and that email on the actor is the shape the seam to the human LIMS will use.
- After slice 3 come the Client submission interface, the seam to aliquot-lims-dev, and the choice of login mechanism, which is made last, before deployment. Until then people sign in through Cloudflare Access.
- `docs/design/vitality-and-merit.md` and ADR-0004, ADR-0007 and ADR-0011 stay in force for the code as built, but no first-edition ticket depends on them.
