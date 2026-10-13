"""parse_submission on every committed Fixture, run the way the Sandbox runs it
but without Docker."""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "sandbox" / "scripts" / "parse_submission" / "main.py"
FIXTURES = sorted((ROOT / "fixtures").glob("*.docx"))

FORM_ID = "c" * 64
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def stage(inputs: Path, form: Path) -> None:
    (inputs / FORM_ID).mkdir(parents=True)
    shutil.copyfile(form, inputs / FORM_ID / form.name)
    manifest = [
        {
            "artifact_id": FORM_ID,
            "filename": form.name,
            "artifact_type": "SubmissionForm",
            "media_type": DOCX,
        }
    ]
    (inputs / "manifest.json").write_text(json.dumps(manifest))


def run_script(inputs: Path, outputs: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
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


def test_there_is_at_least_one_fixture():
    assert FIXTURES, "fixtures/ holds no Submission Form docx"


@pytest.mark.parametrize("form", FIXTURES, ids=lambda p: p.name)
def test_parse_submission_writes_the_expected_record(form, tmp_path):
    inputs, outputs = tmp_path / "inputs", tmp_path / "outputs"
    outputs.mkdir()
    stage(inputs, form)

    result = run_script(inputs, outputs)

    assert result.returncode == 0, result.stderr
    expected = json.loads(form.with_suffix(".expected.json").read_text())
    assert json.loads((outputs / "submission.json").read_text()) == expected
    assert json.loads((outputs / "manifest.json").read_text()) == {
        "submission.json": {
            "artifact_type": "SubmissionRecord",
            "media_type": "application/json",
        }
    }
    assert sorted(p.name for p in outputs.iterdir()) == [
        "manifest.json",
        "submission.json",
    ]


def test_parse_submission_refuses_inputs_without_a_docx(tmp_path):
    inputs, outputs = tmp_path / "inputs", tmp_path / "outputs"
    inputs.mkdir()
    outputs.mkdir()
    (inputs / "manifest.json").write_text("[]")

    result = run_script(inputs, outputs)

    assert result.returncode == 1
    assert "exactly one Submission Form" in result.stderr
    assert list(outputs.iterdir()) == []
