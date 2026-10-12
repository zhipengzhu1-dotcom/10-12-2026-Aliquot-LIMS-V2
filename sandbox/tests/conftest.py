import json
from pathlib import Path

import pytest

from synth.cli import main

SEEDS = [42, 7, 2026]


@pytest.fixture(scope="session", params=SEEDS, ids=lambda s: f"seed{s}")
def generated(request, tmp_path_factory) -> Path:
    out = tmp_path_factory.mktemp(f"synth-{request.param}")
    main(["--seed", str(request.param), "--out", str(out)])
    return out


@pytest.fixture
def manifest(generated) -> dict:
    return json.loads((generated / "manifest.json").read_text())
