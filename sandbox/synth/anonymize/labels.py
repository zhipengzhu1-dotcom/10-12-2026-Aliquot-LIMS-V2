"""What the scrub keeps: the allowlist (ADR-0009).

A text is kept only when it is a label the blank form prints, a unit, a sheet
name of a generic kind, or a value that carries no identity. Everything else
is replaced. A label that names the lab, a Client or a product is not a label
here: it is replaced like any value. Labels compare with runs of whitespace
collapsed to one space.
"""

import re

LABELS = frozenset(
    {
        # The Submission Form.
        "SAMPLE SUBMISSION FORM (General)",
        "Turnaround Time (TAT): Regular: 5-7 business days. The turnaround time "
        "starts the day after receiving sample.",
        "Rush Service Charges: 1-2 Days: 2XRegular, 3-4 days:1.5XRegular",
        "All samples will be discarded after 30 days unless instructed otherwise.",
        "Date submitted:",
        "Submitted By:",
        "PO#:",
        "COMPANY NAME & ADDRESS",
        "BILL TO ADDRESS (if different)",
        "SEND REPORTS TO",
        "Attn",
        "Phone #",
        "Email ID",
        "☐ PHARMACEUTICALS ☐ COSMETICS ☐ NUTRACEUTICALS ☐ OTHER",
        "☐METHOD VALIDATION REQUIRED ☐ HAZARDOUS ☐ MSDS INCLUDED",
        "No.",
        "SAMPLE DESCRIPTION",
        "TYPE",
        "FP/IP/RM/R&D",
        "Stab. Condition",
        "*TAT #",
        "LOT NUMBER",
        "PRODUCT CODE",
        "(If any)",
        "TESTS REQUESTED",
        "LIMITS",
        "* TAT# (Required Turnaround Time #): 1=Regular, 2=1-2 days, 3=3-4 days",
        "Date Sample(s) received:",
        "Time received:",
        "Received By:",
        "Comments:",
        "Page 1 of 2",
        "Page 2 of 2",
        "Page",
        "of",
        # The Reports of Analysis.
        "REPORT OF ANALYSIS",
        "Product:",
        "Lot Number:",
        "Product Code:",
        "Product Type:",
        "Document Revision:",
        "Date Received:",
        "Time Received:",
        "Book Reference:",
        "Test",
        "Test Method",
        "Daily Dose",
        "Specification",
        "Result",
        "Prepared by",
        "Signature",
        "Date",
        "Authorized by",
        "Report in PPM",
        "N/A",
        "TBD",
        # The Receiving Log.
        "SAMPLE RECEIVING LOG-GENERAL",
        "DATE",
        "PRODUCT NAME",
        "LOT#",
        "CLIENT",
        "EXP DATE",
        "QTY RECD",
        "RECD BY",
        "SENT BY",
        "REPORT DATE",
        "BOOK REF#",
        "COMMENTS",
        "INVOICE STATUS",
        "INVOICE #",
        "#",
        "PO#",
        "Revision #",
        "Product Code",
        "Rec. DATE",
        "Rec. Time",
        "Sent",
        "Completed",
        "Drafting",
        "Initial",
        "Initial-1",
        "Initial-2",
        "Initial-3",
        "Control",
        "FP",
        "RM",
        "IP",
        # The analyst worksheet.
        "Code",
        "Name",
        "Status",
        "Lot#",
        "wt of 20 capsules (mg)",
        "Wt Taken (mg)",
        "Average Wt (mg)",
        "VF (mL)",
        "Dilution",
        "Conc. (mg/mL)",
        "Recovery (ng/mL)",
        "Daily dose Unit",
        "Daily amount (mg/day)",
    }
)

UNITS = frozenset(
    {
        "g",
        "mg",
        "ng",
        "mL",
        "ppm",
        "ng/day",
        "mg/day",
        "mg/mL",
        "ng/mL",
        "AM",
        "PM",
        "Units",
    }
)

SHEET_NAMES = frozenset({"Sheet1", "Actual Table", "Heavy Metals"})
_MONTHS = (
    "January|February|March|April|May|June|July|August|September|October|"
    "November|December"
)
_GENERIC_SHEET = re.compile(rf"\d{{4}}|(?:{_MONTHS}) \d{{1,2}}")

# Field codes Word computes on its own, as in the footer's page numbers.
_FIELD_CODE = re.compile(r"\s*(?:PAGE|NUMPAGES)(?:\s+\\\*\s+\w+)*\s*")
_SMALL_INTEGER = re.compile(r"\d{1,2}")
_NOTHING_TO_SAY = re.compile(r"[\W_]*")


def _collapsed(text: str) -> str:
    return " ".join(text.split())


def is_kept(text: str) -> bool:
    plain = _collapsed(text)
    return (
        plain in LABELS
        or plain in UNITS
        or _NOTHING_TO_SAY.fullmatch(plain) is not None
        or _SMALL_INTEGER.fullmatch(plain) is not None
    )


def is_unit(token: str) -> bool:
    return token in UNITS


def is_field_code(text: str) -> bool:
    return _FIELD_CODE.fullmatch(text) is not None


def is_generic_sheet_name(name: str) -> bool:
    return name in SHEET_NAMES or _GENERIC_SHEET.fullmatch(name) is not None
