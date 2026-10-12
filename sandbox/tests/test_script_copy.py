"""The copy Script, run the way the Sandbox runs it but without Docker."""

import json
import subprocess
import sys
from pathlib import Path

COPY = Path(__file__).resolve().parents[1] / "scripts" / "copy" / "main.py"

FORM = "a" * 64
LOG = "b" * 64


def stage(inputs: Path, entries: list[tuple[str, str, bytes]]) -> None:
    manifest = []
    for artifact_id, filename, data in entries:
        (inputs / artifact_id).mkdir(parents=True)
        (inputs / artifact_id / filename).write_bytes(data)
        manifest.append(
            {
                "artifact_id": artifact_id,
                "filename": filename,
                "artifact_type": "Other",
                "media_type": "application/octet-stream",
            }
        )
    (inputs / "manifest.json").write_text(json.dumps(manifest))


def run_copy(inputs: Path, outputs: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            "-I",
            str(COPY),
            "--inputs",
            str(inputs),
            "--outputs",
            str(outputs),
        ],
        capture_output=True,
        text=True,
        check=False,
    )


def test_copy_writes_every_input_byte_for_byte(tmp_path):
    inputs, outputs = tmp_path / "inputs", tmp_path / "outputs"
    outputs.mkdir()
    form = b"PK\x03\x04 not really a docx \x00\xff"
    log = b"container,qty\n1,3\n"
    stage(
        inputs, [(FORM, "submission_form.docx", form), (LOG, "receiving_log.csv", log)]
    )

    result = run_copy(inputs, outputs)

    assert result.returncode == 0, result.stderr
    assert sorted(p.name for p in outputs.iterdir()) == [
        "receiving_log.csv",
        "submission_form.docx",
    ]
    assert (outputs / "submission_form.docx").read_bytes() == form
    assert (outputs / "receiving_log.csv").read_bytes() == log
    assert "submission_form.docx" in result.stdout


def test_copy_with_no_inputs_writes_nothing(tmp_path):
    inputs, outputs = tmp_path / "inputs", tmp_path / "outputs"
    inputs.mkdir()
    outputs.mkdir()
    (inputs / "manifest.json").write_text("[]")

    result = run_copy(inputs, outputs)

    assert result.returncode == 0, result.stderr
    assert list(outputs.iterdir()) == []
