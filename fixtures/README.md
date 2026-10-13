# Fixtures

A Fixture is an Artifact with a known expected outcome. Every new Script version must handle every Fixture before it replaces the previous version.

Every file here is synthetic. The synthetic generator in `sandbox/synth/` invents every Client, contact, address, product, Product Code, and Lot number. No Fixture quotes or copies a file from `Templates/` (ADR-0009).

| Fixture | Generated with | Expected outcome |
|---|---|---|
| `submission-form-seed1.docx` | `synth --seed 1` | `submission-form-seed1.expected.json`: the record `parse_submission` must write. Stage 2 passes with two containers, received Tuesday 2026-01-06. Stage 3 passes with Work Order `WO-2026-0001`, TAT class `Rush3to4Days`, due Monday 2026-01-12. Stage 4 passes on `submission-form-seed1.weighings.json` with averages 0.35443 g and 0.360515 g and a mean of 0.3574725 g. Stage 5 verifies that worksheet against the same weighings with the verdict `pass`. Stage 6 renders the Report of Analysis for `LR-2026-0001`, Lot `LT-268123`, Product Code `TLB-1475`, with the result 0.3575 g. |
| `submission-form-seed2.docx` | `synth --seed 2` | `submission-form-seed2.expected.json`. Stage 2 passes with three containers of another Client and Lot, received Monday 2026-07-27. Stage 3 passes with Work Order `WO-2026-0002`, TAT class `Regular`, due Monday 2026-08-10. Stage 4 passes on `submission-form-seed2.weighings.json`, three containers. Stage 5 passes on the same weighings. Stage 6 renders the Report of Analysis for `LR-2026-0003`, Lot `LT-269173`, Product Code `CVN-3239`, with the result 0.5821 g. |

Every Fixture needs its weighings beside it, `<fixture stem>.weighings.json`, the `weighings.json` that `synth` writes for its seed. The workflow tracer stores that file as the Operator's `Other` Artifact before stage 4, gives the same Artifact to stage 5, and refuses stage 4 when the file is missing, naming the file.

CI runs every `*.docx` here through all six stages of the toy workflow with `aliquot workflow run-all fixtures`. The job fails when any Evaluation fails. Per stage, CI checks the following:

| Stage | What its Evaluation checks on each Fixture |
|---|---|
| 1 Submission | Every required field of the record is filled and the TAT code is valid. |
| 2 Receipt | One Receiving Log row per container, each with the record's Lot and Product Code, a `samples` row per Lab Reference, one `lots` row for the Lot, and no Lab Reference already in the carried database. |
| 3 Work Order | The due date the Evaluation computes from TAT, a Test for every Sample on the Receiving Log row, a new Work Order number, and `work_orders` rows that agree with the Work Order. |
| 4 Results | Every average and the mean are formulas, the weights equal the weighings, and the `results` rows agree within 0.0001 g. |
| 5 Verification | The record names the worksheet and the weighings, every recomputation agrees with the weighings within 0.0001 g, and the verdict says so. |
| 6 Report | The record's verdict was `pass`, every metadata cell equals the Receiving Log row's and the database's value, the result is the record's mean, the PDF shows the Lab Reference, Lot, Product Code and result, and the `reports` row names the PDF. |

The Fixtures run in name order on one home, so seed 2's stage 2 carries the toy LIMS database that seed 1's stage 6 wrote. Its Lab References continue from seed 1's: `LR-2026-0001` and `0002`, then `0003` to `0005`. Its Work Order number continues the same way.

`sandbox/tests/test_script_log_receipt.py` runs `log_receipt` on seed 1's expected record, with no database and with one that already holds a Sample from the same year. `sandbox/tests/test_script_create_work_order.py` runs `log_receipt` and then `create_work_order` on seed 1's expected record, once with each TAT class, and checks the due date for each. `sandbox/tests/test_script_compute_results.py` runs those two and then `compute_results` with seed 1's committed weighings, and checks the worksheet's formulas and the `results` rows. `sandbox/tests/test_script_verify_results.py` runs `verify_results` on that worksheet, which passes, and on a copy with one typed average that disagrees with its weights, which fails. `sandbox/tests/test_script_render_roa.py` runs `render_roa` on that Verification Record, seed 1's Receiving Log row and stage 4's database. It checks every metadata cell against its source, reads the PDF back with pdfplumber, and checks the `reports` row. It also checks that the Script refuses a blank Receiving Log or `samples` value and writes nothing. `sandbox/tests/test_synth_cli.py` checks that each Fixture's weighings file is the one its seed writes.

## Regenerate a Fixture

The generator writes byte-identical files for the same seed, so the commands below reproduce the committed bytes.

```sh
uv run --directory sandbox synth --seed 1 --out /tmp/synth-1
cp /tmp/synth-1/submission_form.docx fixtures/submission-form-seed1.docx
cp /tmp/synth-1/weighings.json fixtures/submission-form-seed1.weighings.json
```

Seed 2 is the same with `2` in place of `1`. The expected JSON comes from `/tmp/synth-<seed>/manifest.json`, the invented record behind the documents:

- `submitted_by`, `bill_to`, `report_to`: `company`, `contact`, `address` (the manifest's `street`), `city`, `phone`, `email` from `submitter`, `bill_to`, `report_to`.
- `sample`: `no` is `"1"`; `sample_description` is `product_name`; `sample_type`, `tat_code`, `tat_class`, `lot`, `product_code`, `product_type` as named; `no_of_containers` is the number of `containers`, as text.
- `date_submitted` is `submitted_on`; `receipt` holds `date_received` (`received_on`), `time_received` (`received_at`), `received_by`.
- `schema` is `"submission/1"`.

`sandbox/scripts/parse_submission/main.py` documents the schema. `sandbox/tests/test_script_parse_submission.py` runs the Script on each Fixture and compares its output with the expected JSON.
