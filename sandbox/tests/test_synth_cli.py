import subprocess
import sys
import time
from pathlib import Path

from synth.cli import main

DOCUMENTS = [
    "submission_form.docx",
    "receiving_log.xlsx",
    "result_worksheet.xlsx",
    "report_of_analysis.xlsx",
    "manifest.json",
]


def test_one_seed_writes_the_four_documents_and_the_manifest(tmp_path):
    main(["--seed", "42", "--out", str(tmp_path)])
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted(DOCUMENTS)


def test_the_same_seed_writes_byte_identical_files(tmp_path):
    first, second = tmp_path / "first", tmp_path / "second"
    main(["--seed", "42", "--out", str(first)])
    # Zip entries record wall-clock seconds unless the generator fixes them.
    time.sleep(2.1)
    main(["--seed", "42", "--out", str(second)])
    for name in DOCUMENTS:
        assert (first / name).read_bytes() == (second / name).read_bytes(), name


def test_different_seeds_write_different_records(tmp_path):
    main(["--seed", "1", "--out", str(tmp_path / "a")])
    main(["--seed", "2", "--out", str(tmp_path / "b")])
    a = (tmp_path / "a" / "manifest.json").read_bytes()
    b = (tmp_path / "b" / "manifest.json").read_bytes()
    assert a != b


def test_the_synth_console_script_is_installed(tmp_path):
    script = Path(sys.executable).parent / "synth"
    subprocess.run([str(script), "--seed", "7", "--out", str(tmp_path)], check=True)
    assert (tmp_path / "manifest.json").is_file()
