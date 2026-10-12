"""Save Office documents so the same record always gives the same bytes.

openpyxl and python-docx stamp every zip entry with the wall clock. Each document
is saved to memory, then rewritten entry by entry, in the same order, with one
fixed timestamp.
"""

import io
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import IO
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


def save_reproducibly(
    save: Callable[[IO[bytes]], None], path: Path, when: datetime
) -> None:
    raw = io.BytesIO()
    save(raw)
    fixed = io.BytesIO()
    with ZipFile(raw) as src, ZipFile(fixed, "w") as dst:
        for entry in src.infolist():
            info = ZipInfo(entry.filename, date_time=when.timetuple()[:6])
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            dst.writestr(info, src.read(entry.filename))
    path.write_bytes(fixed.getvalue())
