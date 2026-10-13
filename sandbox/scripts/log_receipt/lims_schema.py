"""The toy LIMS database: the schema of its five tables, the one place they live.

The database is one sqlite file, `lims.sqlite`, stored as a `LimsDatabase`
Artifact. A stage never edits a stored version: it copies the latest one it
carries, writes rows, and outputs the next version. `log_receipt` creates the
database when the Ledger holds none, so this module sits in its directory (a
Script sees only its own directory); later stages find the tables in the
database they carry.

Every row's `source_artifact` is the Artifact id of the document that
produced the row, so a Lineage query can start from a row. Dates are ISO 8601
text (YYYY-MM-DD), times HH:MM.
"""

import sqlite3

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE lots (
    lot TEXT PRIMARY KEY,
    product_code TEXT NOT NULL,
    product_name TEXT NOT NULL,
    product_type TEXT NOT NULL,
    client TEXT NOT NULL,
    exp_date TEXT,
    source_artifact TEXT NOT NULL
) STRICT;

CREATE TABLE samples (
    lab_reference TEXT PRIMARY KEY,
    lot TEXT NOT NULL REFERENCES lots (lot),
    container INTEGER NOT NULL,
    qty_received INTEGER NOT NULL,
    sample_type TEXT NOT NULL,
    tat_code TEXT NOT NULL,
    tat_class TEXT NOT NULL,
    date_submitted TEXT NOT NULL,
    date_received TEXT NOT NULL,
    time_received TEXT NOT NULL,
    received_by TEXT NOT NULL,
    submitted_by_company TEXT NOT NULL,
    submitted_by_contact TEXT NOT NULL,
    submitted_by_address TEXT NOT NULL,
    submitted_by_city TEXT NOT NULL,
    submitted_by_phone TEXT NOT NULL,
    submitted_by_email TEXT NOT NULL,
    bill_to_company TEXT NOT NULL,
    bill_to_contact TEXT NOT NULL,
    bill_to_address TEXT NOT NULL,
    bill_to_city TEXT NOT NULL,
    bill_to_phone TEXT NOT NULL,
    bill_to_email TEXT NOT NULL,
    report_to_company TEXT NOT NULL,
    report_to_contact TEXT NOT NULL,
    report_to_address TEXT NOT NULL,
    report_to_city TEXT NOT NULL,
    report_to_phone TEXT NOT NULL,
    report_to_email TEXT NOT NULL,
    source_artifact TEXT NOT NULL
) STRICT;

CREATE TABLE work_orders (
    work_order TEXT NOT NULL,
    lab_reference TEXT NOT NULL REFERENCES samples (lab_reference),
    test TEXT NOT NULL,
    due_date TEXT NOT NULL,
    source_artifact TEXT NOT NULL,
    PRIMARY KEY (work_order, lab_reference, test)
) STRICT;

CREATE TABLE results (
    lab_reference TEXT NOT NULL REFERENCES samples (lab_reference),
    test TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT NOT NULL,
    source_artifact TEXT NOT NULL,
    PRIMARY KEY (lab_reference, test)
) STRICT;

CREATE TABLE reports (
    lab_reference TEXT PRIMARY KEY REFERENCES samples (lab_reference),
    issued_date TEXT NOT NULL,
    document_revision TEXT NOT NULL,
    source_artifact TEXT NOT NULL
) STRICT;
"""


def create_schema(db: sqlite3.Connection) -> None:
    """Create the five tables in an empty database."""
    db.executescript(SCHEMA)
    db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
