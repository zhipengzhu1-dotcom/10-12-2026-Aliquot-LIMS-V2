"""Stage 4 Script: write the Result Worksheet for a Work Order from the weighings.

Sandbox Script convention: run as
    python /script/main.py --inputs /inputs --outputs /outputs
with /inputs/manifest.json listing the inputs and each input at
/inputs/<artifact_id>/<filename>. The inputs must hold exactly one
`WorkOrder` (the sheet `create_work_order` writes), exactly one `Other`,
the weighings, and exactly one `LimsDatabase`, the toy LIMS database
version the stage carries, whose `samples` rows give each Lab Reference's
container number and Lot.

The weighings are one JSON array of `{"container": n, "weight_of_20_g": g,
"weight_taken_g": g}`, one entry per container of the Work Order's Lot, as
the synthetic generator writes them in `weighings.json`. Weighings read
from the Operator's results Message (`parse_results_message`) also give
each entry the same `"notebook_reference"`; the Fixture's give none.

Outputs, typed in `/outputs/manifest.json`:

- `result_worksheet.xlsx` (`ResultWorksheet`): the layout of
  `sandbox/synth/result_worksheet.py`. Rows 1 to 3 are the header block
  (title, Work Order, Test), and row 4 holds "Notebook Reference" and the
  weighings' notebook reference when they name one; row 5 holds `COLUMNS`;
  then one row per
  container in container order, the weighings typed in columns F and G and
  the average weight in column H as the formula `=F<row>/20`; then a Mean
  row with "Mean" in column G and `=AVERAGE(H<first>:H<last>)` in column H.
- `lims.sqlite` (`LimsDatabase`): the carried database with two `results`
  rows per Sample, each with unit `g` and the weighings' Artifact id as
  `source_artifact`: `TEST` holds its container's average weight, and
  `MEAN_TEST` the mean of the Work Order's averages. Python computes both,
  the same arithmetic the formulas do.
- `result_worksheet.json` (`Other`): for the stage 4 Evaluation, which has
  no xlsx reader, the sheet as this Script reads it back from the saved
  xlsx, formulas as their text: `{"schema": "result_worksheet/1",
  "sheet": [[cell, ...], ...]}`, row 1 first.

The Script refuses inputs it cannot read or compute one worksheet from
(exit 1, the reason on stderr) and judges nothing else: the stage 4
Evaluation decides whether the formulas, the weights and the `results` rows
agree. It refuses a Work Order of more than one Sample until #86.
"""

import argparse
import json
import shutil
import sqlite3
import sys
import tempfile
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

from openpyxl import Workbook, load_workbook

SCHEMA_VERSION = 1
TEST = "Average capsule weight"
MEAN_TEST = "Average capsule weight, Work Order mean"
UNIT = "g"
TITLE = "Result Worksheet: Average Capsule Weight"
SHEET = "Average Weight"
COLUMNS = (
    "#",
    "Code",
    "Name",
    "Status",
    "Lot#",
    "Weight of 20 Capsules (g)",
    "Weight Taken (g)",
    "Average Weight (g)",
)
NOTEBOOK_LABEL = "Notebook Reference"
HEADER_ROW = 5
STATUS = "Complete"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


class ResultsError(Exception):
    """The inputs are not a Work Order, weighings and database this Script can read."""


@dataclass(frozen=True)
class Weighing:
    container: int
    weight_of_20_g: float
    weight_taken_g: float

    @property
    def average_g(self) -> float:
        return self.weight_of_20_g / 20


@dataclass(frozen=True)
class Sample:
    lab_reference: str
    lot: str
    product_code: str
    product_name: str
    weighing: Weighing


@dataclass(frozen=True)
class Inputs:
    work_order: Path
    weighings: Path
    weighings_id: str
    database: Path


def inputs_of(inputs: Path) -> Inputs:
    manifest = json.loads((inputs / "manifest.json").read_text())

    def only(artifact_type: str) -> dict:
        found = [e for e in manifest if e["artifact_type"] == artifact_type]
        if len(found) != 1:
            raise ResultsError(
                f"expected exactly one {artifact_type} input, got {len(found)}"
            )
        return found[0]

    def path(entry: dict) -> Path:
        return inputs / entry["artifact_id"] / entry["filename"]

    order, weighings, database = only("WorkOrder"), only("Other"), only("LimsDatabase")
    return Inputs(
        path(order), path(weighings), weighings["artifact_id"], path(database)
    )


def read_work_order(path: Path) -> tuple[str, list[str]]:
    """The Work Order number and the Lab Reference of each of its `TEST` rows."""
    rows = list(load_workbook(path).active.iter_rows(values_only=True))
    header = {row[0]: row[1] for row in rows if row and row[0] is not None}
    number = header.get("Work Order")
    if not number:
        raise ResultsError("the Work Order's header block has no Work Order number")
    columns = ("Lab Reference", "Test")
    starts = [i for i, row in enumerate(rows) if tuple(row[:2]) == columns]
    if not starts:
        raise ResultsError("the Work Order has no 'Lab Reference', 'Test' row")
    refs = []
    for ref, test, *_ in rows[starts[0] + 1 :]:
        if test != TEST:
            raise ResultsError(
                f"{ref}: compute_results computes {TEST!r}, not {test!r}"
            )
        refs.append(str(ref))
    if not refs:
        raise ResultsError(f"Work Order {number} lists no Sample")
    return str(number), refs


def notebook_reference(entries: list) -> str | None:
    """The notebook reference every weighing names, or None when none names one."""
    named = {entry.get("notebook_reference") for entry in entries}
    if named <= {None}:
        return None
    if len(named) > 1 or not all(isinstance(n, str) and n for n in named):
        raise ResultsError(
            "the weighings do not all name one notebook reference:"
            f" {sorted(map(str, named))}"
        )
    return named.pop()


def read_weighings(path: Path) -> tuple[dict[int, Weighing], str | None]:
    """Each container's weighing, by container number, and their notebook reference."""
    try:
        entries = json.loads(path.read_text())
    except json.JSONDecodeError as error:
        raise ResultsError(f"the weighings are not JSON: {error}") from error
    if not isinstance(entries, list):
        raise ResultsError("the weighings are not a JSON array")

    def field(entry: dict, key: str, kinds: tuple[type, ...], what: str):
        value = entry.get(key)
        if isinstance(value, bool) or not isinstance(value, kinds):
            raise ResultsError(f"weighing {entry!r}: {key} is not {what}")
        return value

    weighings: dict[int, Weighing] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ResultsError(f"weighing {entry!r} is not an object")
        weighing = Weighing(
            field(entry, "container", (int,), "a whole number"),
            float(field(entry, "weight_of_20_g", (int, float), "a number")),
            float(field(entry, "weight_taken_g", (int, float), "a number")),
        )
        if weighing.container in weighings:
            raise ResultsError(f"container {weighing.container} is weighed twice")
        weighings[weighing.container] = weighing
    return weighings, notebook_reference(entries)


def refuse_several_samples(db: sqlite3.Connection, number: str, refs: list[str]):
    containers = [
        row[0]
        for ref in refs
        for row in db.execute(
            "SELECT container FROM samples WHERE lab_reference = ?", (ref,)
        )
    ]
    if len(containers) != len(set(containers)):
        raise ResultsError(
            f"Work Order {number} holds {containers.count(1)} Samples, and"
            " compute_results computes one Sample's results; a result per"
            " Sample waits on #86"
        )


def samples_of(
    db: sqlite3.Connection, refs: list[str], weighings: dict[int, Weighing]
) -> list[Sample]:
    """The Work Order's Samples in container order, each with its weighing."""
    samples = []
    for ref in refs:
        found = db.execute(
            "SELECT samples.container, samples.lot, lots.product_code,"
            " lots.product_name FROM samples JOIN lots USING (lot)"
            " WHERE lab_reference = ?",
            (ref,),
        ).fetchone()
        if found is None:
            raise ResultsError(f"the carried database has no samples row for {ref}")
        container, lot, code, name = found
        if container not in weighings:
            raise ResultsError(f"{ref}: no weighing for container {container}")
        samples.append(Sample(ref, lot, code, name, weighings[container]))
    unweighed = sorted(set(weighings) - {s.weighing.container for s in samples})
    if unweighed:
        raise ResultsError(f"containers {unweighed} are weighed but on no Sample")
    return sorted(samples, key=lambda s: s.weighing.container)


def write_sheet(
    path: Path, number: str, samples: list[Sample], notebook: str | None = None
) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = SHEET
    ws["A1"] = TITLE
    ws["A2"], ws["B2"] = "Work Order", number
    ws["A3"], ws["B3"] = "Test", TEST
    if notebook is not None:
        ws["A4"], ws["B4"] = NOTEBOOK_LABEL, notebook
    for col, title in enumerate(COLUMNS, start=1):
        ws.cell(HEADER_ROW, col, title)
    first = HEADER_ROW + 1
    for row, sample in enumerate(samples, start=first):
        w = sample.weighing
        values = (
            w.container,
            sample.product_code,
            sample.product_name,
            STATUS,
            sample.lot,
            w.weight_of_20_g,
            w.weight_taken_g,
            f"=F{row}/20",
        )
        for col, value in enumerate(values, start=1):
            ws.cell(row, col, value)
        for col in (6, 7, 8):
            ws.cell(row, col).number_format = "0.0000"
    last = first + len(samples) - 1
    ws.cell(last + 1, 7, "Mean")
    ws.cell(last + 1, 8, f"=AVERAGE(H{first}:H{last})").number_format = "0.0000"
    wb.save(path)


def read_back(path: Path) -> list[list[object]]:
    return [list(row) for row in load_workbook(path).active.iter_rows(values_only=True)]


def compute_results(inputs: Path, outputs: Path) -> str:
    given = inputs_of(inputs)
    number, refs = read_work_order(given.work_order)
    weighings, notebook = read_weighings(given.weighings)

    with tempfile.TemporaryDirectory() as work:
        database = Path(work) / "lims.sqlite"
        shutil.copyfile(given.database, database)
        with closing(sqlite3.connect(database)) as db:
            (version,) = db.execute("PRAGMA user_version").fetchone()
            if version != SCHEMA_VERSION:
                raise ResultsError(
                    f"the carried database has schema version {version};"
                    f" this Script reads version {SCHEMA_VERSION}"
                )
            db.execute("PRAGMA foreign_keys = ON")
            refuse_several_samples(db, number, refs)
            samples = samples_of(db, refs, weighings)
            mean = sum(s.weighing.average_g for s in samples) / len(samples)
            db.executemany(
                "INSERT INTO results (lab_reference, test, value, unit,"
                " source_artifact) VALUES (?, ?, ?, ?, ?)",
                [
                    (s.lab_reference, test, value, UNIT, given.weighings_id)
                    for s in samples
                    for test, value in ((TEST, s.weighing.average_g), (MEAN_TEST, mean))
                ],
            )
            db.commit()
        shutil.copyfile(database, outputs / "lims.sqlite")

    write_sheet(outputs / "result_worksheet.xlsx", number, samples, notebook)
    summary = {
        "schema": "result_worksheet/1",
        "sheet": read_back(outputs / "result_worksheet.xlsx"),
    }
    (outputs / "result_worksheet.json").write_text(json.dumps(summary, indent=2) + "\n")
    manifest = {
        "result_worksheet.xlsx": {
            "artifact_type": "ResultWorksheet",
            "media_type": XLSX,
        },
        "lims.sqlite": {
            "artifact_type": "LimsDatabase",
            "media_type": "application/vnd.sqlite3",
        },
        "result_worksheet.json": {
            "artifact_type": "Other",
            "media_type": "application/json",
        },
    }
    (outputs / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return number


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--outputs", type=Path, required=True)
    args = parser.parse_args(argv)

    try:
        number = compute_results(args.inputs, args.outputs)
    except (ResultsError, KeyError, sqlite3.Error) as error:
        print(f"compute_results refused its inputs: {error!r}", file=sys.stderr)
        return 1
    print(f"wrote the Result Worksheet for Work Order {number}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
