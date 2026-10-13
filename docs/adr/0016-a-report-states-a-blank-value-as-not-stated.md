---
status: proposed
---

# A Report of Analysis states a blank value as "Not stated"

Stage 6 refused to render a Report of Analysis when any metadata value was missing or blank. A Sample received from a chat Message has blanks by design: `parse_message` reads only what the Message states, so the Report To party's contact, address and city, and the Product Type, are empty in the Sample's `samples` row and Receiving Log row. Under the old rule no Sample received from chat could ever get a report, and the chat flow could not reach its `ExternalMessage` Gate.

`render_roa` now writes "Not stated" for a metadata value its source leaves blank, in both the xlsx and the PDF. It still refuses a Sample with no `samples` row or no Receiving Log row, and it still reads every value from those rows, never from the Message or by guess. The stage 6 Evaluation expects "Not stated" exactly where the source is blank, so a report that leaves a cell empty or fills it with anything else fails.

The report does not leave the lab on that basis alone. The Specialist that renders it requests an `ExternalMessage` Gate, and the Operator reads the report before approving it (ADR-0006). A report that says "Not stated" for its addressee is the Operator's to reject.

## Considered Options

- Keep the refusal, and have the Specialist ask in the Lab Room for the missing party details. Rejected for the first edition: nothing records an answer into the Sample's rows, so the report could never render.
- Leave the cell empty. Rejected because an empty cell reads as a rendering fault, and the Evaluation cannot tell it from a value the Script dropped.
- Fill the Report To party from the Submitted By party. Rejected because that is a guess about who receives the report.

## Consequences

- `test_script_render_roa.py`'s refusal test for a blank value became a test that the value reads "Not stated" in both reports.
- A Fixture-driven report is unchanged, since every Fixture states every value.
