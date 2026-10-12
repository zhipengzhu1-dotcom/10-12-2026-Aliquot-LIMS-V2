"""A fresh openpyxl workbook with fixed metadata, saved reproducibly."""

from pathlib import Path
from typing import IO
from zipfile import ZIP_DEFLATED, ZipFile

from openpyxl import Workbook
from openpyxl.writer.excel import ExcelWriter

from synth.lab import LAB_NAME
from synth.record import Record
from synth.reproducible import save_reproducibly


def new_workbook(record: Record) -> Workbook:
    wb = Workbook()
    wb.properties.creator = LAB_NAME
    wb.properties.lastModifiedBy = LAB_NAME
    wb.properties.created = record.document_time
    wb.properties.modified = record.document_time
    return wb


def save_workbook(wb: Workbook, record: Record, path: Path) -> None:
    # Workbook.save stamps properties.modified with the wall clock; ExcelWriter
    # writes the properties as set.
    def save(fh: IO[bytes]) -> None:
        ExcelWriter(wb, ZipFile(fh, "w", ZIP_DEFLATED)).save()

    save_reproducibly(save, path, record.document_time)
