"""Stage 1 Script: read a Submission Form (docx) into a structured submission record.

Sandbox Script convention: run as
    python /script/main.py --inputs /inputs --outputs /outputs
with /inputs/manifest.json listing the inputs and each input at
/inputs/<artifact_id>/<filename>. The inputs must hold exactly one docx.

Tables are found by their labels, not their position, and columns by their
header text. The labels are the ones `sandbox/synth/submission_form.py` writes.

Output `/outputs/submission.json` (keys sorted, two-space indent):

    {
      "schema": "submission/1",
      "date_submitted": "YYYY-MM-DD",
      "submitted_by": Party,
      "bill_to": Party,
      "report_to": Party,
      "sample": {
        "no", "sample_description", "sample_type", "tat_code",
        "tat_class", "lot", "product_code", "product_type",
        "no_of_containers"
      },
      "receipt": {"date_received": "YYYY-MM-DD", "time_received": "HH:MM",
                  "received_by"}
    }
    Party = {"company", "contact", "address", "city", "phone", "email"}

Every value is a string holding the cell's text with surrounding whitespace
removed; a blank cell, or a label the form lacks, gives "". Dates printed as
MM/DD/YYYY become ISO 8601 YYYY-MM-DD; any other date text is kept as
printed. `sample` is the first Sample row. `tat_class` is derived from
`tat_code` with the TAT code table below ("" for a code not in the table).
The Script reports what the form says and judges nothing: the stage 1
Evaluation decides whether the record is complete.

`/outputs/manifest.json` types submission.json as `artifact_type: "Other"`:
the ArtifactType enum has no "SubmissionRecord" member yet.
"""

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

from docx import Document
from docx.table import Table

DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
SCHEMA = "submission/1"

# Copied from sandbox/synth/tat.py: the container mounts only this directory,
# so the Script cannot import `synth`.
TAT_CODES = {"1": "Regular", "2": "Rush1to2Days", "3": "Rush3to4Days"}

PARTIES = {
    "Submitted By": "submitted_by",
    "Bill To": "bill_to",
    "Report To": "report_to",
}
PARTY_FIELDS = {
    "Company": "company",
    "Contact": "contact",
    "Address": "address",
    "City": "city",
    "Phone": "phone",
    "Email": "email",
}
SAMPLE_COLUMNS = {
    "No.": "no",
    "Sample Description": "sample_description",
    "Sample Type": "sample_type",
    "TAT Code": "tat_code",
    "Lot": "lot",
    "Product Code": "product_code",
    "Product Type": "product_type",
    "No. of Containers": "no_of_containers",
}
RECEIPT_FIELDS = {
    "Date Received": "date_received",
    "Time Received": "time_received",
    "Received By (initials)": "received_by",
}
DATE_SUBMITTED = re.compile(r"^\s*Date Submitted:\s*(.*)$")


class FormError(Exception):
    """The inputs are not a Submission Form this Script can read."""


def iso_date(text: str) -> str:
    try:
        return datetime.strptime(text, "%m/%d/%Y").date().isoformat()
    except ValueError:
        return text


def cells(row) -> list[str]:
    return [cell.text.strip() for cell in row.cells]


def find_table(tables: list[Table], label: str) -> Table | None:
    """The first table whose first row or first column holds `label`."""
    for table in tables:
        if label in cells(table.rows[0]) or label in [
            cells(row)[0] for row in table.rows
        ]:
            return table
    return None


def parties(table: Table | None) -> dict[str, dict[str, str]]:
    record = {key: dict.fromkeys(PARTY_FIELDS.values(), "") for key in PARTIES.values()}
    if table is None:
        return record
    header = cells(table.rows[0])
    for row in table.rows[1:]:
        values = cells(row)
        field = PARTY_FIELDS.get(values[0])
        if field is None:
            continue
        for col, title in enumerate(header):
            if title in PARTIES and col < len(values):
                record[PARTIES[title]][field] = values[col]
    return record


def first_row(table: Table | None, columns: dict[str, str]) -> dict[str, str]:
    record = dict.fromkeys(columns.values(), "")
    if table is None or len(table.rows) < 2:
        return record
    header = cells(table.rows[0])
    values = cells(table.rows[1])
    for col, title in enumerate(header):
        if title in columns and col < len(values):
            record[columns[title]] = values[col]
    return record


def parse(form: Path) -> dict:
    doc = Document(str(form))
    date_submitted = ""
    for paragraph in doc.paragraphs:
        match = DATE_SUBMITTED.match(paragraph.text)
        if match:
            date_submitted = iso_date(match.group(1).strip())
            break

    tables = list(doc.tables)
    sample = first_row(find_table(tables, "Sample Description"), SAMPLE_COLUMNS)
    sample["tat_class"] = TAT_CODES.get(sample["tat_code"], "")
    receipt = first_row(find_table(tables, "Date Received"), RECEIPT_FIELDS)
    receipt["date_received"] = iso_date(receipt["date_received"])

    return {
        "schema": SCHEMA,
        "date_submitted": date_submitted,
        **parties(find_table(tables, "Submitted By")),
        "sample": sample,
        "receipt": receipt,
    }


def submission_form(inputs: Path) -> Path:
    manifest = json.loads((inputs / "manifest.json").read_text())
    forms = [
        entry
        for entry in manifest
        if entry["media_type"] == DOCX or entry["filename"].lower().endswith(".docx")
    ]
    if len(forms) != 1:
        raise FormError(
            f"expected exactly one Submission Form (docx) input, got {len(forms)}"
        )
    return inputs / forms[0]["artifact_id"] / forms[0]["filename"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--outputs", type=Path, required=True)
    args = parser.parse_args(argv)

    try:
        form = submission_form(args.inputs)
        record = parse(form)
    except FormError as error:
        print(error, file=sys.stderr)
        return 1

    (args.outputs / "submission.json").write_text(
        json.dumps(record, indent=2, sort_keys=True) + "\n"
    )
    (args.outputs / "manifest.json").write_text(
        json.dumps(
            {
                "submission.json": {
                    "artifact_type": "Other",
                    "media_type": "application/json",
                }
            },
            indent=2,
        )
        + "\n"
    )
    print(f"parsed {form.name}: {record['sample']['lot'] or 'no Lot'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
