"""parse_message on Messages, run the way the Sandbox runs it but without Docker."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "sandbox" / "scripts" / "parse_message" / "main.py"
MESSAGE_ID = "d" * 64
READABLE = (
    "Received 3 bottles of Vitamin C 500 mg capsules, Lot 2403A, Product Code VC500,"
    " finished product, from Acme Nutrition, regular TAT"
)


def stage(inputs: Path, body: str) -> None:
    message = {
        "seq": 12,
        "room": "RM-lab",
        "said_by": "Operator",
        "ts": "2026-10-13T09:30:00.000Z",
        "body": body,
    }
    (inputs / MESSAGE_ID).mkdir(parents=True)
    (inputs / MESSAGE_ID / "message-12.json").write_text(json.dumps(message))
    manifest = [
        {
            "artifact_id": MESSAGE_ID,
            "filename": "message-12.json",
            "artifact_type": "Other",
            "media_type": "application/json",
        }
    ]
    (inputs / "manifest.json").write_text(json.dumps(manifest))


def run(tmp_path: Path, body: str) -> tuple[subprocess.CompletedProcess[str], Path]:
    inputs, outputs = tmp_path / "inputs", tmp_path / "outputs"
    outputs.mkdir()
    stage(inputs, body)
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--inputs",
            str(inputs),
            "--outputs",
            str(outputs),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    return result, outputs


def test_reads_every_value_the_message_states(tmp_path):
    result, outputs = run(tmp_path, READABLE)

    assert result.returncode == 0, result.stderr
    blank = dict.fromkeys(
        ("company", "contact", "address", "city", "phone", "email"), ""
    )
    assert json.loads((outputs / "submission_record.json").read_text()) == {
        "schema": "submission/1",
        "date_submitted": "",
        "submitted_by": {**blank, "company": "Acme Nutrition"},
        "bill_to": blank,
        "report_to": blank,
        "sample": {
            "no": "1",
            "sample_description": "Vitamin C 500 mg capsules",
            "sample_type": "FP",
            "tat_code": "1",
            "tat_class": "Regular",
            "lot": "2403A",
            "product_code": "VC500",
            "product_type": "",
            "no_of_containers": "3",
        },
        "receipt": {
            "date_received": "2026-10-13",
            "time_received": "09:30",
            "received_by": "Operator",
        },
    }
    assert json.loads((outputs / "manifest.json").read_text()) == {
        "submission_record.json": {
            "artifact_type": "SubmissionRecord",
            "media_type": "application/json",
        }
    }


@pytest.mark.parametrize(
    ("body", "reason"),
    [
        ("Received some samples from Acme", "names no Lot and no Product Code"),
        (
            "Received 3 bottles of Vitamin C, Product Code VC500, from Acme",
            "names no Lot",
        ),
        (
            "Received 3 bottles of Vitamin C, Lot 2403A, from Acme",
            "names no Product Code",
        ),
        ("Received a lot of bottles, Product Code VC500", "names no Lot"),
        ("Lot 2403A and Lot 2403B, Product Code VC500", "names 2 Lots: 2403A, 2403B"),
    ],
)
def test_refuses_a_message_without_one_lot_and_one_product_code(tmp_path, body, reason):
    result, outputs = run(tmp_path, body)

    assert result.returncode == 1
    assert reason in result.stderr
    assert list(outputs.iterdir()) == []


def test_leaves_a_value_the_message_does_not_state_blank(tmp_path):
    result, outputs = run(tmp_path, "Got Lot 77B, Product Code ZN10, rush please")

    assert result.returncode == 0, result.stderr
    record = json.loads((outputs / "submission_record.json").read_text())
    assert record["sample"]["tat_code"] == "", "a bare 'rush' names no TAT code"
    assert record["sample"]["sample_type"] == ""
    assert record["sample"]["no_of_containers"] == ""
    assert record["submitted_by"]["company"] == ""


@pytest.mark.parametrize(
    ("phrase", "code", "tat_class"),
    [
        ("rush 1-2 days", "2", "Rush1to2Days"),
        ("rush 3 to 4 days", "3", "Rush3to4Days"),
        ("TAT code 2", "2", "Rush1to2Days"),
    ],
)
def test_reads_the_rush_tat_codes(tmp_path, phrase, code, tat_class):
    result, outputs = run(tmp_path, f"Lot 9Z, Product Code P1, raw material, {phrase}")

    assert result.returncode == 0, result.stderr
    sample = json.loads((outputs / "submission_record.json").read_text())["sample"]
    assert (sample["tat_code"], sample["tat_class"], sample["sample_type"]) == (
        code,
        tat_class,
        "RM",
    )
