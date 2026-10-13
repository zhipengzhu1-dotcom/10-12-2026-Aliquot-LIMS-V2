---
status: accepted
---

# Slice 3 runs in parallel first

Slice 3 takes the chat flow to the lab's real documents: the lab's Submission Form, the Receiving Log workbook and the Reports of Analysis. The Receiving Log workbook is a System of record. The raw-material report reads it by external reference, so a wrong row the engine writes there changes a report the lab issues. On 2026-10-13 the owner ruled that slice 3 runs in parallel first.

The engine writes shadow copies of the System of record in the real layout, beside the lab's own: the Receiving Log rows in the real columns and sheets (#76), and later the reports (#77). The real workbook's path is set per home, outside git, and the engine opens it read-only. A comparison reports each difference between the engine's rows and the rows the lab entered by hand, field by field, and is an Artifact in the Ledger named by the Run that made it. The engine writes the real workbook only when the Operator says so: a separate ticket, after the Operator has judged the comparisons, behind the `WriteSystemOfRecord` Gate.

Real lab text reaches Anthropic inside prompts during the parallel run. The owner accepted this for the demo to lab members on 2026-10-13. ADR-0009 still holds: the real templates are never committed, and the Fixtures in their layout are scrubbed copies (#75).

Reverse word: `direct`, which skips the parallel run and writes the real workbook behind the `WriteSystemOfRecord` Gate from the start.

## Considered Options

- Write the real workbook from the first ticket, behind the Gate. Rejected because a Gate approves one write the Operator reads, and does not show whether the engine's rows agree with the lab's over many Samples.
- Run slice 3 on scrubbed copies only. Rejected because the comparison needs the lab's real rows for the same Samples.

## Consequences

- A slice 3 Script writes a new file in the real layout and never opens the real workbook for writing. A test checks that the real workbook's hash is the same before and after a stage and the comparison.
- Slice 3 has started when the first comparison is read, not when the first real row is written.
- The `WriteSystemOfRecord` Gate stays off until a data source is declared a System of record in configuration, as the overview's toy System of record section says.
