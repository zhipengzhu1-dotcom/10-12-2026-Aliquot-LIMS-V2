"""ADR-0009: no real lab data in the generated documents or in the Sandbox source.

The forbidden terms (the lab's and Clients' names, the real Lot prefixes) stay
out of the repository too: the test reads them from ALIQUOT_FORBIDDEN_TERMS, a
comma-separated list, and skips when it is unset, unless CI is set: in CI an
unset secret fails the test, so the check cannot go quietly missing.
"""

import html
import os
import zipfile
from pathlib import Path

import pytest

SANDBOX = Path(__file__).resolve().parents[1]
SKIP_DIRS = {".venv", "__pycache__", ".pytest_cache", ".ruff_cache"}


def forbidden_terms() -> list[str]:
    raw = os.environ.get("ALIQUOT_FORBIDDEN_TERMS", "")
    terms = [t.strip().lower() for t in raw.split(",") if t.strip()]
    if not terms:
        if os.environ.get("CI"):
            pytest.fail("set the ALIQUOT_FORBIDDEN_TERMS repository secret (ADR-0009)")
        pytest.skip(
            "ALIQUOT_FORBIDDEN_TERMS is unset: set it to a comma-separated list of "
            "real lab terms to check the generator output and source for them"
        )
    return terms


def generated_texts(out: Path):
    for path in sorted(out.iterdir()):
        if zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as z:
                for name in z.namelist():
                    text = z.read(name).decode("utf-8", errors="replace")
                    yield f"{path.name}:{name}", html.unescape(text)
        else:
            yield path.name, path.read_text(encoding="utf-8")


def source_texts():
    for path in sorted(SANDBOX.rglob("*")):
        rel = path.relative_to(SANDBOX)
        if path.is_file() and not SKIP_DIRS.intersection(rel.parts):
            yield str(rel), path.read_text(encoding="utf-8", errors="replace")


def hits(texts, terms):
    return [(where, t) for where, text in texts for t in terms if t in text.lower()]


def test_generated_documents_carry_no_forbidden_term(generated):
    assert hits(generated_texts(generated), forbidden_terms()) == []


def test_sandbox_source_carries_no_forbidden_term():
    assert hits(source_texts(), forbidden_terms()) == []


def test_the_generator_never_references_the_confidential_folder():
    package = SANDBOX / "synth"
    offenders = [
        str(p.relative_to(SANDBOX))
        for p in package.rglob("*.py")
        if "Templates" in p.read_text(encoding="utf-8")
    ]
    assert offenders == []
