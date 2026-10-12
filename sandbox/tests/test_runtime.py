import sys
import tomllib
from pathlib import Path

PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


def test_interpreter_meets_requires_python():
    requires = tomllib.loads(PYPROJECT.read_text())["project"]["requires-python"]
    assert requires == ">=3.13"
    assert sys.version_info >= (3, 13)
