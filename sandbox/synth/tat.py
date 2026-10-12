"""TAT codes as printed on the Submission Form, and the TatClass each one names.

The glossary codes TAT on the Submission Form as 1 (regular), 2 (rush in 1 to 2
days) and 3 (rush in 3 to 4 days). `parse_submission` imports or copies this table.
"""

from enum import StrEnum


class TatClass(StrEnum):
    REGULAR = "Regular"
    RUSH_1_TO_2_DAYS = "Rush1to2Days"
    RUSH_3_TO_4_DAYS = "Rush3to4Days"


TAT_CODES: dict[str, TatClass] = {
    "1": TatClass.REGULAR,
    "2": TatClass.RUSH_1_TO_2_DAYS,
    "3": TatClass.RUSH_3_TO_4_DAYS,
}


def tat_class(code: str) -> TatClass:
    """Return the TatClass for a Submission Form TAT code, or raise ValueError."""
    try:
        return TAT_CODES[code.strip()]
    except KeyError:
        raise ValueError(
            f"invalid TAT code {code!r}; valid codes are {sorted(TAT_CODES)}"
        ) from None
