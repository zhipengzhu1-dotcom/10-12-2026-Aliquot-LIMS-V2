# Fixtures

A Fixture is an Artifact with a known expected outcome. Every new Script version must handle every Fixture before it replaces the previous version.

Every file here is synthetic or scrubbed. The synthetic generator in `sandbox/synth/` invents every Client, contact, address, product, Product Code, and Lot number in the files at the top of this folder. The files in `real-layout/` are scrubbed copies of the lab's five templates (see [Scrubbed copies](#scrubbed-copies-of-the-templates)). No Fixture quotes a value from `Templates/` (ADR-0009).

| Fixture | Generated with | Expected outcome |
|---|---|---|
| `submission-form-seed1.docx` | `synth --seed 1` | `submission-form-seed1.expected.json`: the record `parse_submission` must write. Stage 2 passes with two containers, received Tuesday 2026-01-06. Stage 3 passes with Work Order `WO-2026-0001`, TAT class `Rush3to4Days`, due Monday 2026-01-12. Stage 4 passes on `submission-form-seed1.weighings.json` with averages 0.35443 g and 0.360515 g and a mean of 0.3574725 g. Stage 5 verifies that worksheet against the same weighings with the verdict `pass`. Stage 6 renders the Report of Analysis for `LR-2026-0001`, Lot `LT-268123`, Product Code `TLB-1475`, with the result 0.3575 g. |
| `submission-form-seed2.docx` | `synth --seed 2` | `submission-form-seed2.expected.json`. Stage 2 passes with three containers of another Client and Lot, received Monday 2026-07-27. Stage 3 passes with Work Order `WO-2026-0002`, TAT class `Regular`, due Monday 2026-08-10. Stage 4 passes on `submission-form-seed2.weighings.json`, three containers. Stage 5 passes on the same weighings. Stage 6 renders the Report of Analysis for `LR-2026-0003`, Lot `LT-269173`, Product Code `CVN-3239`, with the result 0.5821 g. |
| `real-layout/submission-form-seed4.docx` | `synth --seed 4 --real-layout real-layout/submission-form.docx` | `submission-form-seed4.expected.json`: the record `parse_submission` reads from the lab's real layout. The real form has no cell for the report-to company, street and city, so they are the submitter's, and none for the bill-to phone and email, so they are blank. Stage 2 passes with three containers of `60 ct HDPE bottle`, Lot `LT-267759`, Product Code `TLB-5077`, received Monday 2026-09-28. Stages 3 to 6 pass on `submission-form-seed4.weighings.json`, three containers with a mean average of 0.4484 g. In `run-all` its Lab References continue from seed 2's, `LR-2026-0006` to `0008`. |
| `real-layout/improvised/*.docx` | `python -m synth.improvise` (see [Improvised forms](#improvised-forms)) | `<stem>.expected.json` and `<stem>.weighings.json` for each of seven forms filled from the scrubbed Receiving Log's rows. Five run all six stages; `received-2026-06-26-form-1` (RM) and `unlogged-sample` (IP) stop at stage 3, their known gap. |

Every Fixture needs its weighings beside it, `<fixture stem>.weighings.json`, the `weighings.json` that `synth` writes for its seed. The workflow tracer stores that file as the Operator's `Other` Artifact before stage 4, gives the same Artifact to stage 5, and refuses stage 4 when the file is missing, naming the file.

CI runs every `*.docx` here and in `real-layout/` that has its `<stem>.expected.json` beside it through all six stages of the toy workflow with `aliquot workflow run-all fixtures`. A form without one has no expected outcome and is not a Fixture, so `run-all` lists it as skipped: that is the blank `real-layout/submission-form.docx`. The job fails when any Fixture fails, other than at its known gap. Per stage, CI checks the following:

| Stage | What its Evaluation checks on each Fixture |
|---|---|
| 1 Submission | Every required field of the record is filled and the TAT code is valid. |
| 2 Receipt | One Receiving Log row per container, each with the record's Lot and Product Code, a `samples` row per Lab Reference, one `lots` row for the Lot, and no Lab Reference already in the carried database. |
| 3 Work Order | The due date the Evaluation computes from TAT, a Test for every Sample on the Receiving Log row, a new Work Order number, and `work_orders` rows that agree with the Work Order. |
| 4 Results | Every average and the mean are formulas, the weights equal the weighings, and the `results` rows agree within 0.0001 g. |
| 5 Verification | The record names the worksheet and the weighings, every recomputation agrees with the weighings within 0.0001 g, and the verdict says so. |
| 6 Report | The record's verdict was `pass`, every metadata cell equals the Receiving Log row's and the database's value, the result is the record's mean, the PDF shows the Lab Reference, Lot, Product Code and result, and the `reports` row names the PDF. |

The Fixtures run in name order on one home, this folder's before `real-layout/`'s, so seed 2's stage 2 carries the toy LIMS database that seed 1's stage 6 wrote. Its Lab References continue from seed 1's: `LR-2026-0001` and `0002`, then `0003` to `0005`, and seed 4's go on from there. Its Work Order number continues the same way.

`sandbox/tests/test_script_log_receipt.py` runs `log_receipt` on seed 1's expected record, with no database and with one that already holds a Sample from the same year. `sandbox/tests/test_script_create_work_order.py` runs `log_receipt` and then `create_work_order` on seed 1's expected record, once with each TAT class, and checks the due date for each. `sandbox/tests/test_script_compute_results.py` runs those two and then `compute_results` with seed 1's committed weighings, and checks the worksheet's formulas and the `results` rows. `sandbox/tests/test_script_verify_results.py` runs `verify_results` on that worksheet, which passes, and on a copy with one typed average that disagrees with its weights, which fails. `sandbox/tests/test_script_render_roa.py` runs `render_roa` on that Verification Record, seed 1's Receiving Log row and stage 4's database. It checks every metadata cell against its source, reads the PDF back with pdfplumber, and checks the `reports` row. It also checks that the Script refuses a blank Receiving Log or `samples` value and writes nothing. `sandbox/tests/test_synth_cli.py` checks that each Fixture's weighings file is the one its seed writes, and that the real-layout Fixture is what seed 4 writes into the blank form. `sandbox/tests/test_script_log_receipt_shadow.py` runs `log_receipt` on seed 4's expected record with the scrubbed Receiving Log as the lab's workbook and checks the Shadow's rows and that no cell of the lab's changed. `sandbox/tests/test_script_compare_receiving_log.py` enters rows by hand in a copy of that workbook and checks the Comparison.

## Regenerate a Fixture

The generator writes byte-identical files for the same seed, so the commands below reproduce the committed bytes.

```sh
uv run --directory sandbox synth --seed 1 --out /tmp/synth-1
cp /tmp/synth-1/submission_form.docx fixtures/submission-form-seed1.docx
cp /tmp/synth-1/weighings.json fixtures/submission-form-seed1.weighings.json
```

Seed 2 is the same with `2` in place of `1`. The real-layout Fixture fills the scrubbed blank form:

```sh
uv run --directory sandbox synth --seed 4 --out /tmp/synth-4 --real-layout "$PWD/fixtures/real-layout/submission-form.docx"
cp /tmp/synth-4/submission_form_real_layout.docx fixtures/real-layout/submission-form-seed4.docx
cp /tmp/synth-4/weighings.json fixtures/real-layout/submission-form-seed4.weighings.json
```

Its expected JSON is the manifest's record as the real form carries it, which `sandbox/scripts/parse_submission/main.py` describes: the report-to `company`, `address` and `city` are the submitter's, and the bill-to `phone` and `email` are blank. The expected JSON of seeds 1 and 2 comes from `/tmp/synth-<seed>/manifest.json`, the invented record behind the documents:

- `submitted_by`, `bill_to`, `report_to`: `company`, `contact`, `address` (the manifest's `street`), `city`, `phone`, `email` from `submitter`, `bill_to`, `report_to`.
- `sample`: `no` is `"1"`; `sample_description` is `product_name`; `sample_type`, `tat_code`, `tat_class`, `lot`, `product_code`, `product_type` as named; `no_of_containers` is the number of `containers`, as text.
- `date_submitted` is `submitted_on`; `receipt` holds `date_received` (`received_on`), `time_received` (`received_at`), `received_by`.
- `schema` is `"submission/1"`.

`sandbox/scripts/parse_submission/main.py` documents the schema. `sandbox/tests/test_script_parse_submission.py` runs the Script on each Fixture and compares its output with the expected JSON.

## Improvised forms

`real-layout/improvised/` holds Submission Forms in the lab's real layout, filled from the scrubbed Receiving Log's own rows, so that a Comparison (see the README's Parallel run) pairs the Shadow's rows with rows the lab entered. The generator reads only the scrubbed copies, and invents every value the log does not hold with one seed, so nothing in these forms is real. It rewrites the same bytes on every run:

```sh
uv run --directory sandbox python -m synth.improvise --log "$PWD/fixtures/real-layout/receiving-log.xlsx" --blank "$PWD/fixtures/real-layout/submission-form.docx" --out "$PWD/fixtures/real-layout/improvised"
```

`sandbox/synth/improvise.py` documents the rules. The rows received on one date from one Client make one submission. Each row is one Sample line, and a submission longer than the form's ten lines goes on to a second form. A line carries the row's product name, Lot and Product Code. Its TYPE is the row's when that is a Sample Type code (FP, IP, RM), and FP otherwise, because stage 3 plans Tests only for FP. `parse_submission` reads the first line only, and its containers are the form's lines with that line's Lot and Product Code. Contacts, addresses, TAT codes, Tests, limits and weighings are invented.

| Form | What it is | Comparison against the scrubbed log |
|---|---|---|
| `received-2026-03-31-lot-mistyped` | Eight lines; the first, 4 containers; every Lot one character off | Every row pairs on its Product Code and differs in `LOT#` |
| `received-2026-04-14` | Two lines, 2 containers, rush TAT, report-to is the submitter | Every row pairs |
| `received-2026-05-05` | Nine lines, 6 containers, bill-to filled | Every row pairs |
| `received-2026-06-26-form-1` | Ten lines, the first RM with 1 container; known gap at stage 3 | Every row pairs; the other Lot of the same Product Code is missing in the Shadow |
| `received-2026-06-26-form-2` | The last five lines of that day, 3 containers | Every row pairs; the day's other rows of that Product Code are missing in the Shadow |
| `received-2026-09-04` | One line, 1 container | The row pairs |
| `unlogged-sample` | An IP Sample on a date, Lot and Product Code the log lacks; known gap at stage 3 | Missing in the lab's |

No row is `matched`: on every paired row the Shadow leaves EXP DATE blank where the lab writes `TBD`, writes QTY RECD `1` where the lab writes a count and a unit, writes the contact's name in SENT BY where the lab writes initials, and, except on RM rows, writes FP in TYPE where the lab writes a stability condition. `sandbox/tests/test_synth_improvise.py` checks that the committed forms are what the generator writes and that the set covers FP, RM and IP, one container and several, regular and rush TAT, a report-to contact other than the submitter, and a filled and a blank bill-to block. `conductor/src/shadow/improvised.test.ts` runs the Comparison on each.

## Scrubbed copies of the templates

`real-layout/` holds the lab's five templates in their own layout, with every value replaced. The sheets, cell positions, merged cells, column widths, styles, formulas, and the Submission Form's tables are the templates'. The values are not.

| Fixture | The template it copies | What `run-all` does with it |
|---|---|---|
| `real-layout/submission-form.docx` | The Submission Form, blank as the lab prints it | Lists it as skipped: it has no expected outcome. The generator fills it to make `submission-form-seed4.docx`, which `run-all` runs. |
| `real-layout/receiving-log.xlsx` | The Receiving Log workbook: the year's sheet and a hidden daily sheet | Lists it as skipped. The Shadow tests use it as the lab's workbook. |
| `real-layout/report-of-analysis-finished-product.xlsx` | A Report of Analysis for a finished product | Lists it as skipped. |
| `real-layout/report-of-analysis-raw-material.xlsx` | A Report of Analysis for a raw material, whose header cells are formulas into the Receiving Log | Lists it as skipped. |
| `real-layout/analyst-worksheet.xlsx` | An analyst's worksheet: one row per Sample, with the weights and the formulas that compute the result | Lists it as skipped. |

The scrub keeps a text only when it is on an allowlist: a label the blank form prints, a unit, a generic sheet name, or a small count (`sandbox/synth/anonymize/labels.py`). A label that names the lab, a Client or a product is replaced like any value. Every other text and number is replaced by a synthetic value of the same shape: letters by letters, digits by digits, a date by a date in 2026, with punctuation and units kept. Formulas keep their functions, references and operators. Their number and string literals are replaced, and so is every external workbook path. The tool also clears the document properties (author, last modified by, title, company) and replaces every image and thumbnail with a blank of the same size. Printer settings lose the printer's name and its driver's private data. The file names are the kinds above, never the templates' names. Values come from one seeded generator in the order the scrub meets them, never from the real values, so the same templates always give the same bytes.

### Known gaps

A Fixture that the workflow cannot finish yet carries `<fixture stem>.known-gap.json` beside it, with the stage that stops it, the issue that will close the gap, and why. `run-all` counts the Fixture as a known gap, not a failure, only when the run stops at exactly that stage. A run that stops at another stage fails. A run that finishes also fails and names the file to delete, so a closed gap cannot stay listed.

Two Fixtures carry a known gap today, both at stage 3 (#82): `real-layout/improvised/received-2026-06-26-form-1` reads an RM Sample and `real-layout/improvised/unlogged-sample` an IP one, and stage 3 plans Tests only for FP. Since #76, stage 1 reads the real Submission Form and stage 2 writes the Shadow in the real Receiving Log's sheets and columns. Seed 4 passes stages 3 to 6 because they run on the toy Work Order, worksheet and report, not on the real layouts. These stages cannot read or write the real layout yet:

| Stage | What it cannot read | Issue |
|---|---|---|
| 4 Results and 5 Verification | `compute_results` writes, and `verify_results` reads, the synthetic Result Worksheet, not the analyst's worksheet. | none yet |
| 6 Report | `render_roa` renders the synthetic Report of Analysis, not the two real layouts. | #77 |

Stage 3 has no template of its own. `run-all` starts only from a Submission Form, so it never gives the four workbooks to a stage. It lists each one as skipped.

### Regenerate the scrubbed copies

Run this on the lab's machine. It takes the templates folder as its argument and prints counts only:

```sh
uv run --directory sandbox anonymize "$PWD/Templates" --out "$PWD/fixtures/real-layout"
```

`sandbox/tests/test_anonymize_templates.py` checks the copies on that machine when `ALIQUOT_TEMPLATES` names the templates folder. Without it, CI included, the tests are skipped with the reason. The tests check four things:

- Leaks. They collect every value of four or more characters that is not on the allowlist from each template's parts, file name included. None may appear in its scrubbed copy, in any of the copy's parts, or in any file under `fixtures/`. A failure names the part and the value's length, never the value.
- Bytes. The committed copies are exactly what the tool writes now.
- Blanks. Every image, thumbnail and printer setting is blank.
- Layout. The sheets, cell positions and types, styles, merged cells and column widths match the templates. So do the labels, the formulas' shapes, and the Submission Form's paragraphs, tables and headers.

Before you commit regenerated copies, run those tests and the forbidden-terms check (`ALIQUOT_FORBIDDEN_TERMS`), which scans every file under `fixtures/`.
