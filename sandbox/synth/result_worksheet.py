"""The Result Worksheet (xlsx) for average capsule weight.

A short header block, then the table: one row per container. Column F holds the
weight of 20 capsules and column H the average weight as the formula `=F<row>/20`.
A Mean row averages column H by formula.
"""

from pathlib import Path

from synth.record import Record
from synth.workbook import new_workbook, save_workbook

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
HEADER_ROW = 5
STATUS = "Complete"


def write_result_worksheet(record: Record, path: Path) -> None:
    wb = new_workbook(record)
    ws = wb.active
    ws.title = SHEET
    ws["A1"] = "Result Worksheet: Average Capsule Weight"
    ws["A2"], ws["B2"] = "Lab Reference", record.lab_reference
    ws["A3"], ws["B3"] = "Analyst", record.analyst

    for col, title in enumerate(COLUMNS, start=1):
        ws.cell(HEADER_ROW, col, title)
    row = HEADER_ROW
    for row, weighing in enumerate(record.weighings, start=HEADER_ROW + 1):
        values = (
            weighing.container,
            record.product_code,
            record.product_name,
            STATUS,
            record.lot,
            weighing.weight_of_20_capsules_g,
            weighing.weight_taken_g,
            f"=F{row}/20",
        )
        for col, value in enumerate(values, start=1):
            ws.cell(row, col, value)
        for col in (6, 7, 8):
            ws.cell(row, col).number_format = "0.0000"
    mean_row = row + 1
    ws.cell(mean_row, 7, "Mean")
    ws.cell(mean_row, 8, f"=AVERAGE(H{HEADER_ROW + 1}:H{row})").number_format = "0.0000"
    save_workbook(wb, record, path)
