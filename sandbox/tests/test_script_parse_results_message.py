"""parse_results_message on results Messages, run the way the Sandbox runs it
but without Docker."""

import json
import subprocess
import sys
from pathlib import Path

import pytest
from openpyxl import Workbook

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "sandbox" / "scripts" / "parse_results_message" / "main.py"
MESSAGE_ID = "d" * 64
WORK_ORDER_ID = "e" * 64
RESULTS = (
    "Lab Ref 26-0412, notebook NB-07 p.31."
    " Container 1: 10.246 g for 20 capsules, 10.246 g taken."
    " Container 2: 10.198 g for 20 capsules, 10.198 g taken."
    " Container 3: 10.302 g for 20 capsules, 10.302 g taken."
)


def work_order(path: Path, samples: int) -> None:
    """A Work Order in the layout create_work_order writes, for Lot 2403A."""
    wb = Workbook()
    ws = wb.active
    for label, value in (
        ("Work Order", "WO-2026-0001"),
        ("Client", "Acme Nutrition"),
        ("Lot", "2403A"),
        ("Product Code", "VC500"),
    ):
        ws.append((label, value))
    ws.append(())
    ws.append(("Lab Reference", "Test"))
    for n in range(1, samples + 1):
        ws.append((f"LR-2026-{n:04d}", "Average capsule weight"))
    wb.save(path)


def run(
    tmp_path: Path, body: str, samples: int = 3
) -> tuple[subprocess.CompletedProcess[str], Path]:
    inputs, outputs = tmp_path / "inputs", tmp_path / "outputs"
    outputs.mkdir()
    message = {
        "seq": 31,
        "room": "RM-lab",
        "said_by": "Operator",
        "ts": "2026-10-13T11:02:00.000Z",
        "body": body,
    }
    (inputs / MESSAGE_ID).mkdir(parents=True)
    (inputs / MESSAGE_ID / "message-31.json").write_text(json.dumps(message))
    (inputs / WORK_ORDER_ID).mkdir()
    work_order(inputs / WORK_ORDER_ID / "work_order.xlsx", samples)
    manifest = [
        {
            "artifact_id": MESSAGE_ID,
            "filename": "message-31.json",
            "artifact_type": "Other",
            "media_type": "application/json",
        },
        {
            "artifact_id": WORK_ORDER_ID,
            "filename": "work_order.xlsx",
            "artifact_type": "WorkOrder",
            "media_type": "application/octet-stream",
        },
    ]
    (inputs / "manifest.json").write_text(json.dumps(manifest))
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


def test_writes_each_containers_weighings_with_the_notebook_reference(tmp_path):
    result, outputs = run(tmp_path, RESULTS)

    assert result.returncode == 0, result.stderr
    assert json.loads((outputs / "weighings.json").read_text()) == [
        {
            "container": n,
            "weight_of_20_g": weight,
            "weight_taken_g": weight,
            "notebook_reference": "NB-07 p.31",
        }
        for n, weight in ((1, 10.246), (2, 10.198), (3, 10.302))
    ]
    assert json.loads((outputs / "manifest.json").read_text()) == {
        "weighings.json": {"artifact_type": "Other", "media_type": "application/json"}
    }


def test_reads_a_lot_that_is_the_work_orders(tmp_path):
    result, _ = run(tmp_path, RESULTS.replace("Lab Ref 26-0412", "Lot 2403A"))

    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    ("body", "samples", "reason"),
    [
        (
            RESULTS.replace(" notebook NB-07 p.31.", ""),
            3,
            "the Message names no notebook reference",
        ),
        (
            RESULTS,
            4,
            "the Message weighs 3 containers, and Lot 2403A's Work Order has 4 Samples",
        ),
        (
            RESULTS.replace("10.198 g for 20 capsules, ", ""),
            3,
            "container 2 has no single weight of 20 capsules",
        ),
        (
            RESULTS.replace(", 10.302 g taken", ""),
            3,
            "container 3 has no single weight taken",
        ),
        (
            RESULTS.replace("Container 3", "Container 2"),
            3,
            "the Message names container 2 twice",
        ),
        (
            RESULTS.replace("Lab Ref 26-0412", "Lot 2403B"),
            3,
            "the Message names Lot 2403B, and the Work Order is for Lot 2403A",
        ),
    ],
    ids=[
        "no notebook reference",
        "a container count other than the Lot's",
        "a container without its weight of 20 capsules",
        "a container without its weight taken",
        "a container named twice",
        "another Lot",
    ],
)
def test_refuses_and_writes_nothing(tmp_path, body, samples, reason):
    result, outputs = run(tmp_path, body, samples)

    assert result.returncode == 1
    assert reason in result.stderr
    assert list(outputs.iterdir()) == []
