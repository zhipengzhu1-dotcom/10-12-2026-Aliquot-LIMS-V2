import json
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
    "weighings.json",
]
FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"


def test_one_seed_writes_the_four_documents_the_manifest_and_the_weighings(
    tmp_path,
):
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


def test_the_weighings_are_the_manifests_weighings_one_entry_per_container(
    generated, manifest
):
    weighings = json.loads((generated / "weighings.json").read_text())
    assert weighings == [
        {
            "container": w["container"],
            "weight_of_20_g": w["weight_of_20_capsules_g"],
            "weight_taken_g": w["weight_taken_g"],
        }
        for w in manifest["weighings"]
    ]
    assert [w["container"] for w in weighings] == [
        c["number"] for c in manifest["containers"]
    ]


def test_each_fixtures_weighings_file_is_what_its_seed_writes(tmp_path):
    for seed in (1, 2):
        main(["--seed", str(seed), "--out", str(tmp_path / str(seed))])
        committed = FIXTURES / f"submission-form-seed{seed}.weighings.json"
        written = tmp_path / str(seed) / "weighings.json"
        assert committed.read_bytes() == written.read_bytes(), committed.name


def test_the_real_layout_fixture_is_what_seed_4_writes_into_the_blank(tmp_path):
    real_layout = FIXTURES / "real-layout"
    main(
        [
            "--seed",
            "4",
            "--out",
            str(tmp_path),
            "--real-layout",
            str(real_layout / "submission-form.docx"),
        ]
    )
    for written, committed in (
        ("submission_form_real_layout.docx", "submission-form-seed4.docx"),
        ("weighings.json", "submission-form-seed4.weighings.json"),
    ):
        assert (tmp_path / written).read_bytes() == (
            real_layout / committed
        ).read_bytes(), committed
