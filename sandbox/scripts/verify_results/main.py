"""Stage 5 Script: verify a Result Worksheet against the weighings.

Sandbox Script convention: run as
    python /script/main.py --inputs /inputs --outputs /outputs
with /inputs/manifest.json listing the inputs and each input at
/inputs/<artifact_id>/<filename>. The inputs must hold exactly one
`ResultWorksheet` (the sheet `compute_results` writes) and exactly one
`Other`, the weighings: one JSON array of `{"container": n,
"weight_of_20_g": g, "weight_taken_g": g}`, as the synthetic generator
writes them in `weighings.json`.

The worksheet's row of `COLUMNS` heads one row per container, `#` holding
the container number, then a Mean row with "Mean" in column G. The Script
recomputes each container row's Average Weight (g) by evaluating the cell
on the worksheet's own cells: a formula `=<cell>/<number>` or
`=AVERAGE(<cell>:<cell>)`, or a typed number as it stands. It compares
each with the weighing of the row's container divided by 20, and the Mean
row with the mean of the weighings' averages.

Output, typed in `/outputs/manifest.json`:

- `verification_record.json` (`VerificationRecord`):
  `{"schema": "verification_record/1", "worksheet": <artifact id>,
  "weighings": <artifact id>, "work_order": <number>, "tolerance_g": 0.0001,
  "rows": [{"row", "container", "formula", "recomputed_g", "weighing_g",
  "difference_g", "within_tolerance"}, ...], "mean": {"row", "formula",
  "recomputed_g", "weighing_g", "difference_g", "within_tolerance"},
  "missing_containers": [n, ...], "verdict": "pass" | "fail"}`.
  `formula` is null when the cell holds a typed value; `recomputed_g` is
  null when the cell is neither a number nor a formula this Script
  evaluates; `weighing_g` is null when no weighing has the row's container.
  `missing_containers` lists the weighed containers with no row. The
  verdict is `pass` when every row and the mean are within tolerance and
  every weighing has a row.

The Script refuses inputs it cannot read as a worksheet and weighings
(exit 1, the reason on stderr).
"""

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.utils import column_index_from_string
from openpyxl.worksheet.worksheet import Worksheet

TOLERANCE_G = 0.0001
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
CONTAINER, MEAN_LABEL, AVERAGE = 1, 7, 8
QUOTIENT = re.compile(r"=([A-Z]+)(\d+)/(\d+(?:\.\d+)?)")
AVERAGE_OF = re.compile(r"=AVERAGE\(([A-Z]+)(\d+):([A-Z]+)(\d+)\)")


class VerificationError(Exception):
    """The inputs are not a worksheet and weighings this Script can read."""


@dataclass(frozen=True)
class Inputs:
    worksheet: Path
    worksheet_id: str
    weighings: Path
    weighings_id: str


def inputs_of(inputs: Path) -> Inputs:
    manifest = json.loads((inputs / "manifest.json").read_text())

    def only(artifact_type: str) -> dict:
        found = [e for e in manifest if e["artifact_type"] == artifact_type]
        if len(found) != 1:
            raise VerificationError(
                f"expected exactly one {artifact_type} input, got {len(found)}"
            )
        return found[0]

    def path(entry: dict) -> Path:
        return inputs / entry["artifact_id"] / entry["filename"]

    worksheet, weighings = only("ResultWorksheet"), only("Other")
    return Inputs(
        path(worksheet),
        worksheet["artifact_id"],
        path(weighings),
        weighings["artifact_id"],
    )


def read_weighings(path: Path) -> dict[int, float]:
    """Each container's weight of 20 capsules, by container number."""
    try:
        entries = json.loads(path.read_text())
    except json.JSONDecodeError as error:
        raise VerificationError(f"the weighings are not JSON: {error}") from error
    if not isinstance(entries, list):
        raise VerificationError("the weighings are not a JSON array")
    weighings: dict[int, float] = {}
    for entry in entries:
        container = entry.get("container") if isinstance(entry, dict) else None
        weight = entry.get("weight_of_20_g") if isinstance(entry, dict) else None
        if not isinstance(container, int) or isinstance(container, bool):
            raise VerificationError(f"weighing {entry!r} has no whole container")
        if not isinstance(weight, int | float) or isinstance(weight, bool):
            raise VerificationError(f"weighing {entry!r} has no weight_of_20_g")
        if container in weighings:
            raise VerificationError(f"container {container} is weighed twice")
        weighings[container] = float(weight)
    return weighings


def value_of(ws: Worksheet, column: str, row: int, seen: frozenset = frozenset()):
    """The number a cell gives, evaluating the two formula shapes this
    Script knows on the worksheet's own cells, or None."""
    if (column, row) in seen:
        return None
    seen = seen | {(column, row)}
    cell = ws.cell(row, column_index_from_string(column)).value
    if isinstance(cell, bool):
        return None
    if isinstance(cell, int | float):
        return float(cell)
    if not isinstance(cell, str):
        return None
    if match := QUOTIENT.fullmatch(cell):
        col, at, divisor = match.groups()
        numerator = value_of(ws, col, int(at), seen)
        return None if numerator is None else numerator / float(divisor)
    if match := AVERAGE_OF.fullmatch(cell):
        first_col, first, last_col, last = match.groups()
        if first_col != last_col or int(first) > int(last):
            return None
        values = [
            value_of(ws, first_col, at, seen) for at in range(int(first), int(last) + 1)
        ]
        if any(v is None for v in values):
            return None
        return sum(values) / len(values)
    return None


def checked(row: int, formula, recomputed, weighing) -> dict:
    difference = (
        None if recomputed is None or weighing is None else recomputed - weighing
    )
    return {
        "row": row,
        "formula": formula,
        "recomputed_g": recomputed,
        "weighing_g": weighing,
        "difference_g": difference,
        "within_tolerance": difference is not None and abs(difference) <= TOLERANCE_G,
    }


def verify(worksheet: Path, weighings: dict[int, float]) -> dict:
    """The record's work order, rows, mean, missing containers and verdict."""
    ws = load_workbook(worksheet).active
    rows = range(1, ws.max_row + 1)

    def cells(row: int, count: int) -> tuple:
        return tuple(ws.cell(row, col).value for col in range(1, count + 1))

    header = next((r for r in rows if cells(r, len(COLUMNS)) == COLUMNS), None)
    if header is None:
        raise VerificationError(
            "the worksheet has no row of the Result Worksheet's columns"
        )
    mean_at = next(
        (r for r in rows if r > header and ws.cell(r, MEAN_LABEL).value == "Mean"),
        None,
    )
    if mean_at is None:
        raise VerificationError("the worksheet has no Mean row")
    number = next(
        (ws.cell(r, 2).value for r in rows if ws.cell(r, 1).value == "Work Order"),
        None,
    )

    def formula_at(row: int):
        cell = ws.cell(row, AVERAGE).value
        return cell if isinstance(cell, str) and cell.startswith("=") else None

    checks = []
    for row in range(header + 1, mean_at):
        container = ws.cell(row, CONTAINER).value
        weight = weighings.get(container) if isinstance(container, int) else None
        checks.append(
            {"container": container}
            | checked(
                row,
                formula_at(row),
                value_of(ws, "H", row),
                None if weight is None else weight / 20,
            )
        )
    on_sheet = {c["container"] for c in checks}
    missing = sorted(set(weighings) - on_sheet)
    averages = [w / 20 for w in weighings.values()]
    mean = checked(
        mean_at,
        formula_at(mean_at),
        value_of(ws, "H", mean_at),
        sum(averages) / len(averages) if averages else None,
    )
    passed = (
        bool(checks)
        and all(c["within_tolerance"] for c in checks)
        and mean["within_tolerance"]
        and not missing
    )
    return {
        "work_order": number,
        "rows": checks,
        "mean": mean,
        "missing_containers": missing,
        "verdict": "pass" if passed else "fail",
    }


def verify_results(inputs: Path, outputs: Path) -> dict:
    given = inputs_of(inputs)
    found = verify(given.worksheet, read_weighings(given.weighings))
    record = {
        "schema": "verification_record/1",
        "worksheet": given.worksheet_id,
        "weighings": given.weighings_id,
        "tolerance_g": TOLERANCE_G,
    } | found
    text = json.dumps(record, indent=2) + "\n"
    (outputs / "verification_record.json").write_text(text)
    manifest = {
        "verification_record.json": {
            "artifact_type": "VerificationRecord",
            "media_type": "application/json",
        }
    }
    (outputs / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return record


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--outputs", type=Path, required=True)
    args = parser.parse_args(argv)

    try:
        record = verify_results(args.inputs, args.outputs)
    except (VerificationError, KeyError) as error:
        print(f"verify_results refused its inputs: {error!r}", file=sys.stderr)
        return 1
    print(
        f"verified the Result Worksheet of Work Order {record['work_order']}:"
        f" {record['verdict']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
