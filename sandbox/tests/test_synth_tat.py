import pytest

from synth.tat import TatClass, tat_class


def test_the_glossary_tat_codes_name_the_three_tat_classes():
    assert tat_class("1") == "Regular"
    assert tat_class("2") == "Rush1to2Days"
    assert tat_class("3") == "Rush3to4Days"
    assert {str(c) for c in TatClass} == {"Regular", "Rush1to2Days", "Rush3to4Days"}


@pytest.mark.parametrize("code", ["", "0", "4", "R", "rush"])
def test_any_other_code_is_invalid(code):
    with pytest.raises(ValueError, match="invalid TAT code"):
        tat_class(code)


def test_the_manifest_tat_class_matches_its_code(manifest):
    assert manifest["tat_class"] == tat_class(manifest["tat_code"])
