"""Stage 6 Script: render the Report of Analysis for a verified Work Order.

Sandbox Script convention: run as
    python /script/main.py --inputs /inputs --outputs /outputs
with /inputs/manifest.json listing the inputs and each input at
/inputs/<artifact_id>/<filename>. The inputs must hold exactly one
`VerificationRecord` (the `verification_record/1` record `verify_results`
writes), exactly one `ReceivingLogRow` (the sheet `log_receipt` writes) and
exactly one `LimsDatabase`, the toy LIMS database version the stage carries.

The report is for the first Sample of the record's Work Order, by Lab
Reference, that the Receiving Log row lists. Every metadata value is read
from that Sample's Receiving Log row or from its `samples` row, as `CLIENT`
and `METADATA` name the source of each; the Test from its `work_orders` row;
the result is the record's recomputed mean, rounded to 4 places, and the
unit is that of the Sample's `results` row for the Test. The letterhead, the
Method, the Specification and the Document Revision belong to the report
form, not to the Sample. The signature area names this Script and the
Verification Record, whose Runs' actors the Ledger holds.

Outputs, typed in `/outputs/manifest.json`. The xlsx and the PDF are drawn
from one `Report`, so they cannot disagree:

- `report_of_analysis.xlsx` (`ReportOfAnalysis`): the layout of
  `sandbox/synth/report_of_analysis.py`. Letterhead in rows 1 to 5, the
  Client block from row 7 and the metadata block from row 12 (labels in
  column A, values in column B), the results table's columns in row 22 and
  its row in row 23, and the signature area from row 26.
- `report_of_analysis.pdf` (`ReportOfAnalysis`): the same report, drawn by
  reportlab with uncompressed page streams and invariant metadata, so the
  stage 6 Evaluation reads its text from the bytes and the same report
  gives the same bytes.
- `lims.sqlite` (`LimsDatabase`): the carried database with one `reports`
  row for the Sample: today's date (UTC) as `issued_date`, the form's
  Document Revision, and the PDF's Artifact id, the sha256 of its bytes, as
  `source_artifact`.
- `report_of_analysis.json` (`Other`): for the stage 6 Evaluation, which has
  no xlsx reader: `{"schema": "report_of_analysis/1", "receiving_log_row":
  {column: text}, "sheet": [[cell, ...], ...]}`, the Sample's Receiving Log
  row as this Script read it and the report's sheet as it reads back the
  saved xlsx, row 1 first. Dates read back as YYYY-MM-DD, times as HH:MM.

The Script refuses inputs it cannot read or render a complete report from,
including any metadata value that is missing or blank (exit 1, the reason on
stderr, no outputs). It judges nothing else: the stage 6 Evaluation decides
whether the report agrees with its sources and whether the verdict was pass.
"""

import argparse
import hashlib
import json
import shutil
import sqlite3
import sys
import tempfile
from contextlib import closing
from dataclasses import dataclass
from datetime import UTC, date, datetime, time
from pathlib import Path

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen.canvas import Canvas

SCHEMA_VERSION = 1
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

LAB_NAME = "Quillmere Analytical Laboratories"
LAB_ADDRESS = "27 Wrenfield Court, Velmora, NJ 07999"
LAB_CONTACT = "Tel (201) 555-0100 · reports@quillmere.example"
TITLE = "REPORT OF ANALYSIS"
SHEET = "Report of Analysis"
DOCUMENT_REVISION = "Rev. 03"
METHOD = "QAL-SOP-114"
SPECIFICATION = "Report value"
RESULT_COLUMNS = ("Test", "Method", "Specification", "Result", "Unit")
SIGNATURE_ROLES = ("Rendered By", "Verified By")

RECEIVING_LOG_COLUMNS = (
    "#",
    "Rec. DATE",
    "Rec. Time",
    "Product Code",
    "PRODUCT NAME",
    "TYPE",
    "LOT#",
    "CLIENT",
    "EXP DATE",
    "QTY RECD",
)


@dataclass(frozen=True)
class ReceivingLog:
    """A metadata value read from the Sample's Receiving Log row, by column."""

    column: str


@dataclass(frozen=True)
class Samples:
    """A metadata value read from the Sample's `samples` row, by column."""

    column: str


@dataclass(frozen=True)
class Form:
    """A value of the report form itself, not of the Sample."""

    value: str


Source = ReceivingLog | Samples | Form

CLIENT: tuple[tuple[str, Source], ...] = (
    ("Client", ReceivingLog("CLIENT")),
    ("Attention", Samples("report_to_contact")),
    ("Address", Samples("report_to_address")),
    ("", Samples("report_to_city")),
)
METADATA: tuple[tuple[str, Source], ...] = (
    ("Lab Reference", ReceivingLog("#")),
    ("Product", ReceivingLog("PRODUCT NAME")),
    ("Lot", ReceivingLog("LOT#")),
    ("Product Code", ReceivingLog("Product Code")),
    ("Product Type", ReceivingLog("TYPE")),
    ("Document Revision", Form(DOCUMENT_REVISION)),
    ("Date Received", ReceivingLog("Rec. DATE")),
    ("Time Received", ReceivingLog("Rec. Time")),
    ("Received By", Samples("received_by")),
)

Value = str | date | time


class ReportError(Exception):
    """The inputs are not ones this Script can render a complete report from."""


@dataclass(frozen=True)
class Report:
    """The one structure both renderings draw."""

    client: tuple[tuple[str, Value], ...]
    metadata: tuple[tuple[str, Value], ...]
    result: tuple[str, str, str, float, str]
    signatures: tuple[tuple[str, str], ...]

    @property
    def lab_reference(self) -> str:
        return str(dict(self.metadata)["Lab Reference"])


@dataclass(frozen=True)
class Inputs:
    record: Path
    record_id: str
    receiving_log: Path
    database: Path


def inputs_of(inputs: Path) -> Inputs:
    manifest = json.loads((inputs / "manifest.json").read_text())

    def only(artifact_type: str) -> dict:
        found = [e for e in manifest if e["artifact_type"] == artifact_type]
        if len(found) != 1:
            raise ReportError(
                f"expected exactly one {artifact_type} input, got {len(found)}"
            )
        return found[0]

    def path(entry: dict) -> Path:
        return inputs / entry["artifact_id"] / entry["filename"]

    record = only("VerificationRecord")
    return Inputs(
        path(record),
        record["artifact_id"],
        path(only("ReceivingLogRow")),
        path(only("LimsDatabase")),
    )


def text_of(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, time):
        return value.strftime("%H:%M")
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def read_receiving_log(path: Path) -> dict[str, dict[str, object]]:
    """Each row of the Receiving Log sheet, by its `#`, the Lab Reference."""
    ws = load_workbook(path).active
    rows = list(ws.iter_rows(values_only=True))
    if not rows or tuple(rows[0][: len(RECEIVING_LOG_COLUMNS)]) != (
        RECEIVING_LOG_COLUMNS
    ):
        raise ReportError("the Receiving Log row has no row of its columns")
    return {
        text_of(row[0]): dict(zip(RECEIVING_LOG_COLUMNS, row, strict=False))
        for row in rows[1:]
    }


def read_record(path: Path) -> tuple[str, float, str]:
    """The record's Work Order, recomputed mean and verdict."""
    try:
        record = json.loads(path.read_text())
    except json.JSONDecodeError as error:
        raise ReportError(f"the Verification Record is not JSON: {error}") from error
    if record.get("schema") != "verification_record/1":
        raise ReportError("the Verification Record is not verification_record/1")
    work_order, mean = record.get("work_order"), record.get("mean", {})
    value = mean.get("recomputed_g") if isinstance(mean, dict) else None
    if not isinstance(work_order, str) or not work_order:
        raise ReportError("the Verification Record names no Work Order")
    if not isinstance(value, int | float) or isinstance(value, bool):
        raise ReportError("the Verification Record has no recomputed mean")
    return work_order, float(value), str(record.get("verdict"))


def build_report(
    db: sqlite3.Connection,
    receiving_log: dict[str, dict[str, object]],
    record: Path,
    record_id: str,
) -> Report:
    work_order, mean, verdict = read_record(record)
    tests = db.execute(
        "SELECT lab_reference, test FROM work_orders WHERE work_order = ?"
        " ORDER BY lab_reference",
        (work_order,),
    ).fetchall()
    on_log = [(ref, test) for ref, test in tests if ref in receiving_log]
    if not on_log:
        raise ReportError(
            f"no Sample of Work Order {work_order} is on the Receiving Log row"
        )
    ref, test = on_log[0]
    db.row_factory = sqlite3.Row
    sample = db.execute(
        "SELECT * FROM samples WHERE lab_reference = ?", (ref,)
    ).fetchone()
    if sample is None:
        raise ReportError(f"the carried database has no samples row for {ref}")
    unit = db.execute(
        "SELECT unit FROM results WHERE lab_reference = ? AND test = ?", (ref, test)
    ).fetchone()
    if unit is None or not unit["unit"]:
        raise ReportError(f"the carried database has no {test} result for {ref}")
    row = receiving_log[ref]

    def value(label: str, source: Source) -> Value:
        match source:
            case ReceivingLog(column):
                found, where = row.get(column), f"the Receiving Log row of {ref}"
            case Samples(column):
                found, where = sample[column], f"the samples row of {ref}"
            case Form(form_value):
                return form_value
        if isinstance(found, datetime):
            found = found.date()
        if isinstance(found, date | time):
            return found
        if found is None or str(found).strip() == "":
            name = label or "Address, second line"
            raise ReportError(f"{name}: {where} has no {source.column}")
        return str(found)

    return Report(
        client=tuple((label, value(label, s)) for label, s in CLIENT),
        metadata=tuple((label, value(label, s)) for label, s in METADATA),
        result=(test, METHOD, SPECIFICATION, round(mean, 4), unit["unit"]),
        signatures=(
            ("Rendered By", "render_roa"),
            (
                "Verified By",
                f"Verification Record {record_id[:12]}, verdict {verdict}",
            ),
        ),
    )


def write_xlsx(report: Report, path: Path) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = SHEET
    ws["A1"] = LAB_NAME
    ws["A1"].font = Font(size=14, bold=True)
    ws["A2"] = LAB_ADDRESS
    ws["A3"] = LAB_CONTACT
    ws["A5"] = TITLE
    ws["A5"].font = Font(size=12, bold=True)
    for row, (label, value) in enumerate(report.client, start=7):
        ws.cell(row, 1, label)
        ws.cell(row, 2, value)
    for row, (label, value) in enumerate(report.metadata, start=12):
        ws.cell(row, 1, label).font = Font(bold=True)
        cell = ws.cell(row, 2, value)
        if isinstance(value, date):
            cell.number_format = "mm/dd/yyyy"
        elif isinstance(value, time):
            cell.number_format = "hh:mm"
    results_header = 22
    for col, title in enumerate(RESULT_COLUMNS, start=1):
        ws.cell(results_header, col, title).font = Font(bold=True)
    for col, value in enumerate(report.result, start=1):
        ws.cell(results_header + 1, col, value)
    for i, (role, who) in enumerate(report.signatures):
        col = 1 + 2 * i
        ws.cell(26, col, role).font = Font(bold=True)
        ws.cell(27, col, who)
        ws.cell(28, col, "Signature: ______________")
        ws.cell(29, col, "Date: ______________")
    ws.column_dimensions["A"].width = 22
    ws.column_dimensions["B"].width = 44
    wb.save(path)


def write_pdf(report: Report, path: Path) -> None:
    canvas = Canvas(str(path), pagesize=letter, pageCompression=0, invariant=1)
    y = 740

    def line(text: str, x: float = 72, font: str = "Helvetica", size: int = 10):
        canvas.setFont(font, size)
        canvas.drawString(x, y, text)

    def down(by: int) -> None:
        nonlocal y
        y -= by

    line(LAB_NAME, font="Helvetica-Bold", size=14)
    for text in (LAB_ADDRESS, LAB_CONTACT):
        down(14)
        line(text)
    down(28)
    line(TITLE, font="Helvetica-Bold", size=12)
    down(10)
    for block in (report.client, report.metadata):
        down(14)
        for label, value in block:
            down(14)
            line(label, font="Helvetica-Bold")
            line(text_of(value), x=200)
    down(28)
    xs = (72, 232, 312, 412, 492)
    for x, title in zip(xs, RESULT_COLUMNS, strict=True):
        line(title, x=x, font="Helvetica-Bold")
    down(14)
    for x, value in zip(xs, report.result, strict=True):
        line(f"{value:.4f}" if isinstance(value, float) else value, x=x)
    down(42)
    top = y
    for i, (role, who) in enumerate(report.signatures):
        x, y = 72 + 270 * i, top
        line(role, x=x, font="Helvetica-Bold")
        for text in (who, "Signature: ______________", "Date: ______________"):
            down(14)
            line(text, x=x)
    canvas.showPage()
    canvas.save()


def read_back(path: Path) -> list[list]:
    """The saved sheet, row 1 first: numbers as numbers, dates and times as text."""
    ws = load_workbook(path).active
    return [
        [v if v is None or isinstance(v, int | float) else text_of(v) for v in row]
        for row in ws.iter_rows(values_only=True)
    ]


def render_roa(inputs: Path, outputs: Path) -> Report:
    given = inputs_of(inputs)
    receiving_log = read_receiving_log(given.receiving_log)

    with tempfile.TemporaryDirectory() as work:
        out = Path(work)
        database = out / "lims.sqlite"
        shutil.copyfile(given.database, database)
        with closing(sqlite3.connect(database)) as db:
            (version,) = db.execute("PRAGMA user_version").fetchone()
            if version != SCHEMA_VERSION:
                raise ReportError(
                    f"the carried database has schema version {version};"
                    f" this Script writes version {SCHEMA_VERSION}"
                )
            report = build_report(db, receiving_log, given.record, given.record_id)
            write_xlsx(report, out / "report_of_analysis.xlsx")
            write_pdf(report, out / "report_of_analysis.pdf")
            pdf_id = hashlib.sha256(
                (out / "report_of_analysis.pdf").read_bytes()
            ).hexdigest()
            db.execute("PRAGMA foreign_keys = ON")
            db.execute(
                "INSERT INTO reports (lab_reference, issued_date, document_revision,"
                " source_artifact) VALUES (?, ?, ?, ?)",
                (
                    report.lab_reference,
                    datetime.now(UTC).date().isoformat(),
                    DOCUMENT_REVISION,
                    pdf_id,
                ),
            )
            db.commit()

        read = {
            "schema": "report_of_analysis/1",
            "receiving_log_row": {
                column: text_of(value)
                for column, value in receiving_log[report.lab_reference].items()
            },
            "sheet": read_back(out / "report_of_analysis.xlsx"),
        }
        (out / "report_of_analysis.json").write_text(json.dumps(read, indent=2) + "\n")
        manifest = {
            "report_of_analysis.xlsx": {
                "artifact_type": "ReportOfAnalysis",
                "media_type": XLSX,
            },
            "report_of_analysis.pdf": {
                "artifact_type": "ReportOfAnalysis",
                "media_type": "application/pdf",
            },
            "lims.sqlite": {
                "artifact_type": "LimsDatabase",
                "media_type": "application/vnd.sqlite3",
            },
            "report_of_analysis.json": {
                "artifact_type": "Other",
                "media_type": "application/json",
            },
        }
        (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        for name in [*manifest, "manifest.json"]:
            shutil.copyfile(out / name, outputs / name)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--outputs", type=Path, required=True)
    args = parser.parse_args(argv)

    try:
        report = render_roa(args.inputs, args.outputs)
    except (ReportError, KeyError, sqlite3.Error) as error:
        print(f"render_roa refused its inputs: {error!r}", file=sys.stderr)
        return 1
    print(f"rendered the Report of Analysis of {report.lab_reference}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
