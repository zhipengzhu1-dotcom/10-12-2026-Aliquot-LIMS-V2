"""The Receiving Log (xlsx): one yearly sheet plus one sheet for the day received.

Both sheets hold the column header in row 1 and one row per container below it.
"""

from pathlib import Path

from openpyxl.worksheet.worksheet import Worksheet

from synth.record import Record
from synth.workbook import new_workbook, save_workbook

COLUMNS = (
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
FIRST_ROW = 2


def yearly_sheet_name(record: Record) -> str:
    return str(record.received_on.year)


def daily_sheet_name(record: Record) -> str:
    return f"{record.received_on:%m-%d}"


def _fill(ws: Worksheet, record: Record) -> None:
    ws.append(COLUMNS)
    for container in record.containers:
        ws.append(
            (
                container.number,
                record.received_on,
                record.received_at,
                record.product_code,
                record.product_name,
                record.product_type,
                record.lot,
                record.client,
                record.expires_on,
                container.qty_received,
            )
        )
    for row in ws.iter_rows(min_row=FIRST_ROW):
        row[1].number_format = "mm/dd/yyyy"
        row[2].number_format = "hh:mm"
        row[8].number_format = "mm/dd/yyyy"


def write_receiving_log(record: Record, path: Path) -> None:
    wb = new_workbook(record)
    yearly = wb.active
    yearly.title = yearly_sheet_name(record)
    _fill(yearly, record)
    _fill(wb.create_sheet(daily_sheet_name(record)), record)
    save_workbook(wb, record, path)
