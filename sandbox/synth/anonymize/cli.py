"""`anonymize TEMPLATES --out DIR`: scrubbed copies of the lab's five templates.

Reads the real templates from the folder given (never from the repository,
ADR-0009), tells each one's kind from its content, and writes it under DIR
with the kind's synthetic file name. The real file names, which carry Lot
numbers and Product Codes, are never printed or written. It prints counts
only.
"""

import argparse
import io
import re
from datetime import datetime
from pathlib import Path
from zipfile import ZipFile

from synth.anonymize.scrub import Scrub, date_styles, scrub_part
from synth.anonymize.synthesizer import Synthesizer
from synth.reproducible import save_reproducibly

SEED = 75
WHEN = datetime(2026, 1, 1)


def _texts(z: ZipFile, part: str) -> str:
    return z.read(part).decode("utf-8") if part in z.namelist() else ""


def kind_of(path: Path) -> str:
    with ZipFile(path) as z:
        if path.suffix == ".docx":
            return "submission-form"
        strings = _texts(z, "xl/sharedStrings.xml")
        sheets = re.findall(r'<sheet name="([^"]*)"', _texts(z, "xl/workbook.xml"))
        if any(re.fullmatch(r"\d{4}", n) for n in sheets):
            return "receiving-log"
        if "wt of 20 capsules (mg)" in strings:
            return "analyst-worksheet"
        if "REPORT OF ANALYSIS" in strings:
            cells = strings + "".join(
                _texts(z, n) for n in z.namelist() if "worksheets/" in n
            )
            raw = re.search(r"<t>RM</t>|<v>RM</v>", cells)
            return f"report-of-analysis-{'raw-material' if raw else 'finished-product'}"
    raise SystemExit("a template of no known kind; nothing written")


KINDS = (
    "analyst-worksheet",
    "receiving-log",
    "report-of-analysis-finished-product",
    "report-of-analysis-raw-material",
    "submission-form",
)


def scrub_document(src: Path, dst: Path, scrub: Scrub) -> None:
    with ZipFile(src) as z:
        names = z.namelist()
        scrub.date_styles = (
            date_styles(z.read("xl/styles.xml").decode("utf-8"))
            if "xl/styles.xml" in names
            else frozenset()
        )
        parts = [(n, scrub_part(n, z.read(n), scrub)) for n in names]

    def save(out: io.BytesIO) -> None:
        with ZipFile(out, "w") as w:
            for name, data in parts:
                w.writestr(name, data)

    save_reproducibly(save, dst, WHEN)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="anonymize",
        description="Write scrubbed copies of the lab's templates in their layout.",
    )
    parser.add_argument("templates", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)

    found: dict[str, Path] = {}
    for path in sorted(args.templates.iterdir()):
        if path.suffix in (".docx", ".xlsx") and not path.name.startswith("~$"):
            kind = kind_of(path)
            if kind in found:
                raise SystemExit(f"two templates of kind {kind}; nothing written")
            found[kind] = path
    missing = [k for k in KINDS if k not in found]
    if missing:
        raise SystemExit(f"no template of kind {', '.join(missing)}; nothing written")

    args.out.mkdir(parents=True, exist_ok=True)
    scrub = Scrub(Synthesizer(SEED))
    for kind in KINDS:
        src = found[kind]
        dst = args.out / f"{kind}{src.suffix}"
        before = (scrub.kept, scrub.replaced)
        scrub_document(src, dst, scrub)
        print(
            f"{dst.name}: {scrub.replaced - before[1]} replaced, "
            f"{scrub.kept - before[0]} kept"
        )
