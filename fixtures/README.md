# Fixtures

A Fixture is an Artifact with a known expected outcome. Every new Script version must handle every Fixture before it replaces the previous version.

Every file here is synthetic. The synthetic generator in `sandbox/synth/` invents every Client, contact, address, product, Product Code, and Lot number. No Fixture quotes or copies a file from `Templates/` (ADR-0009).

| Fixture | Generated with | Expected outcome |
|---|---|---|
| `submission-form-seed1.docx` | `synth --seed 1` | `submission-form-seed1.expected.json`: the record `parse_submission` must write. Stage 2 passes with two containers, received 2026-01-06. |
| `submission-form-seed2.docx` | `synth --seed 2` | `submission-form-seed2.expected.json`. Stage 2 passes with three containers of another Client and Lot, received 2026-07-27. |

CI runs every `*.docx` here through every stage of the toy workflow with `aliquot workflow run-all fixtures`. The job fails when any Evaluation fails. The Fixtures run in name order on one home, so seed 2's stage 2 carries the toy LIMS database that seed 1's stage 2 wrote, and its Lab References continue from seed 1's: `LR-2026-0001` and `0002`, then `0003` to `0005`.

`sandbox/tests/test_script_log_receipt.py` runs `log_receipt` on seed 1's expected record, with no database and with one that already holds a Sample from the same year.

## Regenerate a Fixture

The generator writes byte-identical files for the same seed, so the commands below reproduce the committed bytes.

```sh
uv run --directory sandbox synth --seed 1 --out /tmp/synth-1
cp /tmp/synth-1/submission_form.docx fixtures/submission-form-seed1.docx
```

Seed 2 is the same with `2` in place of `1`. The expected JSON comes from `/tmp/synth-<seed>/manifest.json`, the invented record behind the documents:

- `submitted_by`, `bill_to`, `report_to`: `company`, `contact`, `address` (the manifest's `street`), `city`, `phone`, `email` from `submitter`, `bill_to`, `report_to`.
- `sample`: `no` is `"1"`; `sample_description` is `product_name`; `sample_type`, `tat_code`, `tat_class`, `lot`, `product_code`, `product_type` as named; `no_of_containers` is the number of `containers`, as text.
- `date_submitted` is `submitted_on`; `receipt` holds `date_received` (`received_on`), `time_received` (`received_at`), `received_by`.
- `schema` is `"submission/1"`.

`sandbox/scripts/parse_submission/main.py` documents the schema. `sandbox/tests/test_script_parse_submission.py` runs the Script on each Fixture and compares its output with the expected JSON.
