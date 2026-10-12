"""`synth --seed N --out DIR`: write one invented record as the four lab documents."""

import argparse
import json
from pathlib import Path

from synth.receiving_log import write_receiving_log
from synth.record import invent_record
from synth.report_of_analysis import write_report_of_analysis
from synth.result_worksheet import write_result_worksheet
from synth.submission_form import write_submission_form


def generate(seed: int, out: Path) -> None:
    record = invent_record(seed)
    out.mkdir(parents=True, exist_ok=True)
    write_submission_form(record, out / "submission_form.docx")
    write_receiving_log(record, out / "receiving_log.xlsx")
    write_result_worksheet(record, out / "result_worksheet.xlsx")
    write_report_of_analysis(record, out / "report_of_analysis.xlsx")
    manifest = json.dumps(record.manifest(), indent=2, sort_keys=True) + "\n"
    (out / "manifest.json").write_text(manifest, encoding="utf-8")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="synth", description="Write one synthetic set of lab documents."
    )
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    generate(args.seed, args.out)
