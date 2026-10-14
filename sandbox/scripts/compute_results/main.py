"""Stage 4 Script: write the Result Worksheet for a Work Order from the weighings.

Sandbox Script convention: run as
    python /script/main.py --inputs /inputs --outputs /outputs
with /inputs/manifest.json listing the inputs and each input at
/inputs/<artifact_id>/<filename>. The inputs must hold exactly one
`WorkOrder` (the sheet `create_work_order` writes), exactly one `Other`,
the weighings, and exactly one `LimsDatabase`, the toy LIMS database
version the stage carries, whose `samples` rows give each Lab Reference's
container number and Lot.

The weighings are one JSON array with one entry per container of the Work
Order's Lot, `{"container": n, ...}`, as the synthetic generator writes
them in `weighings.json`. A container whose Sample the Work Order plans
for Average capsule weight gives `"weight_of_20_g": g, "weight_taken_g": g`.
One planned for Nitrosamine impurities gives the analyst's preparation and
readings:

    "nitrosamines": {"weight_taken_mg": mg, "final_volume_ml": mL,
      "dilution": d, "max_daily_dose_mg": mg (optional),
      "readings": {"<analyte>": {"concentration_ng_ml": c,
                                 "reporting_limit_ng_ml": rl}, ...}}

with one reading per analyte the Work Order names. Weighings read from the
Operator's results Message (`parse_results_message`) also give each entry
the same `"notebook_reference"`; the Fixture's give none.

The nitrosamine arithmetic mirrors the analyst worksheet
(`fixtures/real-layout/analyst-worksheet.xlsx`, one row per Sample), with the
weight taken standing in for its API taken `J`:

    Conc. (mg/mL)     F = C / D * E   weight taken / VF * dilution   (M = J/K*L)
    Content (ppm)     I = G / F       measured ng/mL / Conc., ng/mg  (N/M)
    Intake (ng/day)   K = I * J       content * max daily dose       (Q = N*P/M)

A ppm is a ng per mg, so a limit in ng/g is judged against the content
times 1000. Worked example: 250 mg taken to 5 mL undiluted is 50 mg/mL; a
reading of 1.5 ng/mL is 0.03 ppm, and with a maximum daily dose of
1500 mg/day an intake of 45 ng/day.

Each analyte's judgement, `judgement()`: no limit, `NO_LIMIT`; an
`unread:` limit, `LIMIT_UNREAD`; a reading below its reporting limit passes
any other limit; a limit in ng/day without a daily dose, `NO_DAILY_DOSE`;
otherwise `PASS` when the result in the limit's unit is at most the limit,
else `FAIL`.

Outputs, typed in `/outputs/manifest.json`:

- `result_worksheet.xlsx` (`ResultWorksheet`): the layout of
  `sandbox/synth/result_worksheet.py`. Rows 1 to 3 are the header block
  (title, Work Order, the Tests), and row 4 holds "Notebook Reference" and
  the weighings' notebook reference when they name one. When the Work
  Order plans Average capsule weight, row 5 holds `COLUMNS`; then one row
  per container in container order, the weighings typed in columns F and G
  and the average weight in column H as the formula `=F<row>/20`; then a
  Mean row with "Mean" in column G and `=AVERAGE(H<first>:H<last>)` in
  column H. When it plans Nitrosamine impurities, a row of
  `NITROSAMINE_COLUMNS` follows, after a blank row when the other block is
  there, and one row per container and analyte in Work Order order: the
  readings typed, Conc., Content and Intake as the formulas above (Intake
  blank without a daily dose), the Work Order's limit, and the judgement.
- `lims.sqlite` (`LimsDatabase`): the carried database with `results` rows,
  each with the weighings' Artifact id as `source_artifact`. For Average
  capsule weight, two per Sample with unit `g`: `TEST` holds its
  container's average weight, and `MEAN_TEST` the mean of the Work Order's
  averages. For Nitrosamine impurities, per analyte, `<NITROSAMINE_TEST>:
  <analyte>` with the content in ppm and, with a daily dose, `..., intake`
  in ng/day. Python computes each, the same arithmetic the formulas do.
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
NITROSAMINE_TEST = "Nitrosamine impurities"
UNIT = "g"
CONTENT_UNIT, INTAKE_UNIT = "ppm", "ng/day"
TITLES = {TEST: "Average Capsule Weight", NITROSAMINE_TEST: "Nitrosamine Impurities"}
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
NITROSAMINE_COLUMNS = (
    "#",
    "Analyte",
    "Wt Taken (mg)",
    "VF (mL)",
    "Dilution",
    "Conc. (mg/mL)",
    "Measured (ng/mL)",
    "Reporting Limit (ng/mL)",
    "Content (ppm)",
    "Max Daily Dose (mg/day)",
    "Intake (ng/day)",
    "Limit",
    "Judgement",
)
PASS, FAIL = "Pass", "Fail"
NO_LIMIT, LIMIT_UNREAD, NO_DAILY_DOSE = "No limit", "Limit unread", "No daily dose"
UNREAD = "unread: "
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
class Reading:
    concentration_ng_ml: float
    reporting_limit_ng_ml: float

    @property
    def below_reporting_limit(self) -> bool:
        return self.concentration_ng_ml < self.reporting_limit_ng_ml


@dataclass(frozen=True)
class Preparation:
    """One container's nitrosamine sample preparation and its readings."""

    weight_taken_mg: float
    final_volume_ml: float
    dilution: float
    max_daily_dose_mg: float | None
    readings: dict[str, Reading]

    @property
    def concentration_mg_ml(self) -> float:
        return self.weight_taken_mg / self.final_volume_ml * self.dilution

    def content_ppm(self, analyte: str) -> float:
        return self.readings[analyte].concentration_ng_ml / self.concentration_mg_ml

    def intake_ng_day(self, analyte: str) -> float | None:
        dose = self.max_daily_dose_mg
        return None if dose is None else self.content_ppm(analyte) * dose


@dataclass(frozen=True)
class Planned:
    lab_reference: str
    test: str
    analyte: str
    limit: str


@dataclass(frozen=True)
class Sample:
    lab_reference: str
    container: int
    lot: str
    product_code: str
    product_name: str


@dataclass(frozen=True)
class Weighings:
    capsules: dict[int, Weighing]
    preparations: dict[int, Preparation]
    notebook: str | None


@dataclass(frozen=True)
class Inputs:
    work_order: Path
    weighings: Path
    weighings_id: str
    database: Path


def judgement(
    limit: str, content_ppm: float, intake_ng_day: float | None, below_rl: bool
) -> str:
    if not limit:
        return NO_LIMIT
    if limit.startswith(UNREAD):
        return LIMIT_UNREAD
    if below_rl:
        return PASS
    number, unit = limit.split(" ")
    found = {"ppm": content_ppm, "ng/g": content_ppm * 1000, "ng/day": intake_ng_day}
    if unit not in found:
        raise ResultsError(f"the limit {limit!r} has no unit this Script judges")
    if found[unit] is None:
        return NO_DAILY_DOSE
    return PASS if found[unit] <= float(number) else FAIL


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


def read_work_order(path: Path) -> tuple[str, list[Planned]]:
    """The Work Order number and its rows of a Test this Script computes."""
    rows = list(load_workbook(path).active.iter_rows(values_only=True))
    header = {row[0]: row[1] for row in rows if row and row[0] is not None}
    number = header.get("Work Order")
    if not number:
        raise ResultsError("the Work Order's header block has no Work Order number")
    starts = [
        i for i, row in enumerate(rows) if tuple(row[:2]) == ("Lab Reference", "Test")
    ]
    if not starts:
        raise ResultsError("the Work Order has no 'Lab Reference', 'Test' row")
    columns = list(rows[starts[0]])

    def at(row: tuple, name: str) -> str:
        found = row[columns.index(name)] if name in columns else None
        return "" if found is None else str(found)

    planned = []
    for row in rows[starts[0] + 1 :]:
        ref, test = str(row[0]), at(row, "Test")
        if test not in TITLES:
            raise ResultsError(
                f"{ref}: compute_results computes {' and '.join(map(repr, TITLES))},"
                f" not {test!r}"
            )
        planned.append(Planned(ref, test, at(row, "Analyte"), at(row, "Limit")))
    if not planned:
        raise ResultsError(f"Work Order {number} lists no Sample")
    return str(number), planned


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


def number(entry: dict, key: str, where: object, optional: bool = False):
    value = entry.get(key)
    if optional and value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ResultsError(f"weighing {where!r}: {key} is not a number")
    return float(value)


def preparation_of(container: int, entry: dict) -> Preparation:
    where = f"container {container} nitrosamines"
    readings = entry.get("readings")
    if not isinstance(readings, dict) or not all(
        isinstance(r, dict) for r in readings.values()
    ):
        raise ResultsError(f"{where}: readings is not an object of readings")
    return Preparation(
        number(entry, "weight_taken_mg", where),
        number(entry, "final_volume_ml", where),
        number(entry, "dilution", where),
        number(entry, "max_daily_dose_mg", where, optional=True),
        {
            analyte: Reading(
                number(r, "concentration_ng_ml", f"{where} {analyte}"),
                number(r, "reporting_limit_ng_ml", f"{where} {analyte}"),
            )
            for analyte, r in readings.items()
        },
    )


def read_weighings(path: Path) -> Weighings:
    """Each container's weighing and nitrosamine preparation, by container
    number, and their notebook reference."""
    try:
        entries = json.loads(path.read_text())
    except json.JSONDecodeError as error:
        raise ResultsError(f"the weighings are not JSON: {error}") from error
    if not isinstance(entries, list) or not all(isinstance(e, dict) for e in entries):
        raise ResultsError("the weighings are not a JSON array of objects")

    capsules: dict[int, Weighing] = {}
    preparations: dict[int, Preparation] = {}
    seen: set[int] = set()
    for entry in entries:
        container = entry.get("container")
        if isinstance(container, bool) or not isinstance(container, int):
            raise ResultsError(f"weighing {entry!r}: container is not a whole number")
        if container in seen:
            raise ResultsError(f"container {container} is weighed twice")
        seen.add(container)
        if "weight_of_20_g" in entry or "weight_taken_g" in entry:
            capsules[container] = Weighing(
                container,
                number(entry, "weight_of_20_g", entry),
                number(entry, "weight_taken_g", entry),
            )
        if "nitrosamines" in entry:
            nitrosamines = entry["nitrosamines"]
            if not isinstance(nitrosamines, dict):
                raise ResultsError(
                    f"container {container}: nitrosamines is not an object"
                )
            preparations[container] = preparation_of(container, nitrosamines)
    return Weighings(capsules, preparations, notebook_reference(entries))


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


def samples_of(db: sqlite3.Connection, refs: list[str]) -> dict[str, Sample]:
    """Each Lab Reference's Sample, in container order."""
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
        samples.append(Sample(ref, *found))
    return {s.lab_reference: s for s in sorted(samples, key=lambda s: s.container)}


def check_covered(test: str, given: dict, samples: list[Sample], what: str) -> None:
    for sample in samples:
        if sample.container not in given:
            raise ResultsError(
                f"{sample.lab_reference}: no {what} for container {sample.container}"
            )
    extra = sorted(set(given) - {s.container for s in samples})
    if extra:
        raise ResultsError(f"containers {extra} have {what} but no {test} Sample")


@dataclass(frozen=True)
class NitrosamineRow:
    sample: Sample
    analyte: str
    limit: str
    preparation: Preparation

    @property
    def reading(self) -> Reading:
        return self.preparation.readings[self.analyte]

    @property
    def judgement(self) -> str:
        return judgement(
            self.limit,
            self.preparation.content_ppm(self.analyte),
            self.preparation.intake_ng_day(self.analyte),
            self.reading.below_reporting_limit,
        )


def nitrosamine_rows(
    planned: list[Planned], samples: dict[str, Sample], weighings: Weighings
) -> list[NitrosamineRow]:
    rows = [
        NitrosamineRow(
            samples[p.lab_reference],
            p.analyte,
            p.limit,
            weighings.preparations[samples[p.lab_reference].container],
        )
        for p in planned
        if p.test == NITROSAMINE_TEST
    ]
    for row in rows:
        if row.analyte not in row.preparation.readings:
            raise ResultsError(
                f"{row.sample.lab_reference}: no reading for {row.analyte!r}"
            )
    for container, preparation in weighings.preparations.items():
        named = {r.analyte for r in rows if r.sample.container == container}
        extra = sorted(set(preparation.readings) - named)
        if extra:
            raise ResultsError(
                f"container {container} has readings for {extra}, which the Work"
                " Order does not name"
            )
    return sorted(rows, key=lambda r: r.sample.container)


def write_sheet(
    path: Path,
    number: str,
    tests: list[str],
    weighed: list[tuple[Sample, Weighing]],
    nitrosamines: list[NitrosamineRow],
    notebook: str | None = None,
) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = SHEET
    ws["A1"] = "Result Worksheet: " + " and ".join(TITLES[t] for t in tests)
    ws["A2"], ws["B2"] = "Work Order", number
    ws["A3"], ws["B3"] = "Test", ", ".join(tests)
    if notebook is not None:
        ws["A4"], ws["B4"] = NOTEBOOK_LABEL, notebook
    header = HEADER_ROW
    if weighed:
        for col, title in enumerate(COLUMNS, start=1):
            ws.cell(header, col, title)
        first = header + 1
        for row, (sample, w) in enumerate(weighed, start=first):
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
        last = first + len(weighed) - 1
        ws.cell(last + 1, 7, "Mean")
        ws.cell(last + 1, 8, f"=AVERAGE(H{first}:H{last})").number_format = "0.0000"
        header = last + 3
    if nitrosamines:
        for col, title in enumerate(NITROSAMINE_COLUMNS, start=1):
            ws.cell(header, col, title)
        for row, n in enumerate(nitrosamines, start=header + 1):
            prep, dosed = n.preparation, n.preparation.max_daily_dose_mg is not None
            values = (
                n.sample.container,
                n.analyte,
                prep.weight_taken_mg,
                prep.final_volume_ml,
                prep.dilution,
                f"=C{row}/D{row}*E{row}",
                n.reading.concentration_ng_ml,
                n.reading.reporting_limit_ng_ml,
                f"=G{row}/F{row}",
                prep.max_daily_dose_mg,
                f"=I{row}*J{row}" if dosed else None,
                n.limit or None,
                n.judgement,
            )
            for col, value in enumerate(values, start=1):
                ws.cell(row, col, value)
    wb.save(path)


def read_back(path: Path) -> list[list[object]]:
    return [list(row) for row in load_workbook(path).active.iter_rows(values_only=True)]


def compute_results(inputs: Path, outputs: Path) -> str:
    given = inputs_of(inputs)
    number, planned = read_work_order(given.work_order)
    weighings = read_weighings(given.weighings)
    refs = list(dict.fromkeys(p.lab_reference for p in planned))
    tests = [t for t in TITLES if any(p.test == t for p in planned)]

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
            samples = samples_of(db, refs)

            def planned_for(test: str) -> list[Sample]:
                named = {p.lab_reference for p in planned if p.test == test}
                return [s for ref, s in samples.items() if ref in named]

            check_covered(TEST, weighings.capsules, planned_for(TEST), "weighing")
            check_covered(
                NITROSAMINE_TEST,
                weighings.preparations,
                planned_for(NITROSAMINE_TEST),
                "nitrosamine readings",
            )
            weighed = [(s, weighings.capsules[s.container]) for s in planned_for(TEST)]
            nitrosamines = nitrosamine_rows(planned, samples, weighings)

            rows = []
            if weighed:
                mean = sum(w.average_g for _, w in weighed) / len(weighed)
                rows += [
                    (s.lab_reference, test, value, UNIT)
                    for s, w in weighed
                    for test, value in ((TEST, w.average_g), (MEAN_TEST, mean))
                ]
            for n in nitrosamines:
                name = f"{NITROSAMINE_TEST}: {n.analyte}"
                ref = n.sample.lab_reference
                rows.append(
                    (ref, name, n.preparation.content_ppm(n.analyte), CONTENT_UNIT)
                )
                intake = n.preparation.intake_ng_day(n.analyte)
                if intake is not None:
                    rows.append((ref, f"{name}, intake", intake, INTAKE_UNIT))
            db.executemany(
                "INSERT INTO results (lab_reference, test, value, unit,"
                " source_artifact) VALUES (?, ?, ?, ?, ?)",
                [(*row, given.weighings_id) for row in rows],
            )
            db.commit()
        shutil.copyfile(database, outputs / "lims.sqlite")

    write_sheet(
        outputs / "result_worksheet.xlsx",
        number,
        tests,
        weighed,
        nitrosamines,
        weighings.notebook,
    )
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
