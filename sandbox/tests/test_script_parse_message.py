"""parse_message on Messages, run the way the Sandbox runs it but without Docker."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "sandbox" / "scripts" / "parse_message" / "main.py"
MESSAGE_ID = "d" * 64
REPORT_TO = (
    "Report to: Acme Nutrition; Contact: Dana Reyes; Address: 12 Harbor Road;"
    " City: Portland, OR 97201"
)
READABLE = (
    "Received 3 bottles of Vitamin C 500 mg capsules, Lot 2403A, Product Code VC500,"
    " Product Type 60 ct HDPE bottle, finished product, from Acme Nutrition,"
    f" regular TAT. {REPORT_TO}"
)
# Every value the Report of Analysis needs, and no Sample Type or TAT.
SPARE = (
    "Got 2 jars of Zinc 30 mg, Lot 77B, Product Code ZN10, Product Type 90 ct jar,"
    f" from Acme, rush please. {REPORT_TO}"
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
        "report_to": {
            **blank,
            "company": "Acme Nutrition",
            "contact": "Dana Reyes",
            "address": "12 Harbor Road",
            "city": "Portland, OR 97201",
        },
        "sample": {
            "no": "1",
            "sample_description": "Vitamin C 500 mg capsules",
            "sample_type": "FP",
            "tat_code": "1",
            "tat_class": "Regular",
            "lot": "2403A",
            "product_code": "VC500",
            "product_type": "60 ct HDPE bottle",
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


@pytest.mark.parametrize(
    ("stated", "instead", "missing"),
    [
        ("Product Type 60 ct HDPE bottle, ", "", "Product Type"),
        ("Report to: Acme Nutrition;", "Report to:", "Report To company"),
        ("Contact: Dana Reyes; ", "", "Report To contact"),
        ("Address: 12 Harbor Road; ", "", "Report To address"),
        ("; City: Portland, OR 97201", "", "Report To city"),
        (REPORT_TO, "", "Report To company and no Report To contact"),
        ("from Acme Nutrition, ", "", "Client"),
        ("3 bottles of Vitamin C 500 mg capsules", "", "product"),
    ],
)
def test_refuses_a_message_without_a_value_the_report_needs(
    tmp_path, stated, instead, missing
):
    body = READABLE.replace(stated, instead)
    assert body != READABLE

    result, outputs = run(tmp_path, body)

    assert result.returncode == 1
    assert f"names no {missing}" in result.stderr
    assert list(outputs.iterdir()) == []


def test_names_every_value_it_lacks(tmp_path):
    body = READABLE.replace("Product Type 60 ct HDPE bottle, ", "").replace(
        f" {REPORT_TO}", ""
    )

    result, outputs = run(tmp_path, body)

    assert result.returncode == 1
    assert (
        "the Message names no Product Type and no Report To company and no"
        " Report To contact and no Report To address and no Report To city"
    ) in result.stderr
    assert list(outputs.iterdir()) == []


def test_reads_the_report_to_partys_phone_and_email_and_ignores_its_labels_elsewhere(
    tmp_path,
):
    body = (
        "Received 3 bottles of Contact Lens Solution, Lot 2403A, Product Code VC500,"
        " Product Type 60 ct HDPE bottle, from Acme Nutrition. Report to Acme Co.,"
        " Contact Dana Reyes, Address 12 City Road, City Tarrowfield, PA 19999,"
        " Phone (201) 555-0142, Email dana.reyes@acme.example"
    )

    result, outputs = run(tmp_path, body)

    assert result.returncode == 0, result.stderr
    record = json.loads((outputs / "submission_record.json").read_text())
    assert record["report_to"] == {
        "company": "Acme Co.",
        "contact": "Dana Reyes",
        "address": "12 City Road",
        "city": "Tarrowfield, PA 19999",
        "phone": "(201) 555-0142",
        "email": "dana.reyes@acme.example",
    }
    assert record["sample"]["sample_description"] == "Contact Lens Solution"


def test_refuses_a_report_to_value_stated_twice(tmp_path):
    result, outputs = run(tmp_path, f"{READABLE}; City: Salem")

    assert result.returncode == 1
    assert "names 2 Report To city values: Portland, OR 97201, Salem" in result.stderr
    assert list(outputs.iterdir()) == []


def test_leaves_a_value_the_message_does_not_state_blank(tmp_path):
    result, outputs = run(tmp_path, SPARE)

    assert result.returncode == 0, result.stderr
    record = json.loads((outputs / "submission_record.json").read_text())
    assert record["sample"]["tat_code"] == "", "a bare 'rush' names no TAT code"
    assert record["sample"]["sample_type"] == ""
    assert record["report_to"]["phone"] == ""
    assert record["report_to"]["email"] == ""
    assert record["submitted_by"]["contact"] == ""


@pytest.mark.parametrize(
    ("phrase", "code", "tat_class"),
    [
        ("rush 1-2 days", "2", "Rush1to2Days"),
        ("rush 3 to 4 days", "3", "Rush3to4Days"),
        ("TAT code 2", "2", "Rush1to2Days"),
    ],
)
def test_reads_the_rush_tat_codes(tmp_path, phrase, code, tat_class):
    result, outputs = run(
        tmp_path, SPARE.replace("rush please", f"raw material, {phrase}")
    )

    assert result.returncode == 0, result.stderr
    sample = json.loads((outputs / "submission_record.json").read_text())["sample"]
    assert (sample["tat_code"], sample["tat_class"], sample["sample_type"]) == (
        code,
        tat_class,
        "RM",
    )
