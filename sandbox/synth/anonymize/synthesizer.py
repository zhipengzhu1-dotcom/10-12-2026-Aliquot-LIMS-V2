"""Synthetic values of the same shape as the real ones they replace.

Every value comes from one seeded generator, drawn in the order the scrub
meets the real values, never derived from a real value: a seed and a real
value must not be enough to recompute a synthetic one, or a short code could
be recovered by trying every candidate. A real value met twice gets the same
synthetic value both times, so a Lot that appears in the Receiving Log and in
a Report of Analysis still agrees across the Fixtures. That pairing lives in
memory for one run and is never written anywhere.
"""

import random
import re
from datetime import date, timedelta
from urllib.parse import quote, unquote

from synth.anonymize.labels import is_unit

_EXCEL_EPOCH = date(1899, 12, 30)
_SYNTHETIC_YEAR = (date(2026, 1, 1), date(2026, 12, 31))
_DATE = re.compile(r"(\d{1,2})([/-])(\d{1,2})\2(\d{2}|\d{4})")
_TIME = re.compile(r"(\d{1,2}):(\d{2})(\s*[AP]M)?")
_NUMBER_WITH_UNIT = re.compile(r"([<>]?)(\d+(?:\.\d+)?)([A-Za-z/%]+)")
_EDGE_PUNCTUATION = re.compile(r"(\W*)(.*?)(\W*)", re.S)
_SCHEME = re.compile(r"[a-z]+:(?:///?)?")
_EXTENSION = re.compile(r"\.[A-Za-z]{2,4}$")
_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_LOWER = "abcdefghijklmnopqrstuvwxyz"


class Synthesizer:
    def __init__(self, seed: int) -> None:
        self._rng = random.Random(seed)
        self._made: dict[tuple[str, str], str] = {}

    def text(self, real: str) -> str:
        return self._remembered("text", real, self._new_text)

    def number(self, real: str, *, is_date: bool) -> str:
        kind = "date" if is_date else "number"
        make = self._new_serial if is_date else self._new_number
        return self._remembered(kind, real, make)

    def path(self, real: str) -> str:
        return self._remembered("path", real, self._new_path)

    def _remembered(self, kind: str, real: str, make) -> str:
        key = (kind, real)
        if key not in self._made:
            self._made[key] = make(real)
        return self._made[key]

    def _new_text(self, real: str) -> str:
        if m := _DATE.fullmatch(real):
            return self._date_like(m)
        if m := _TIME.fullmatch(real):
            return self._time_like(m)
        return "".join(self._token(t) for t in re.split(r"(\s+)", real))

    def _token(self, token: str) -> str:
        lead, core, trail = _EDGE_PUNCTUATION.fullmatch(token).groups()
        if not core or is_unit(core):
            return token
        if m := _NUMBER_WITH_UNIT.fullmatch(core):
            sign, digits, unit = m.groups()
            if is_unit(unit):
                return f"{lead}{sign}{self._shaped(digits)}{unit}{trail}"
        return lead + self._shaped(core) + trail

    def _shaped(self, real: str) -> str:
        """Each letter and digit replaced by one of its class; the rest kept."""
        out = []
        previous_digit = False
        for ch in real:
            if ch.isdigit():
                lead = not previous_digit and ch != "0"
                out.append(str(self._rng.randint(1 if lead else 0, 9)))
            elif "A" <= ch <= "Z":
                out.append(self._rng.choice(_UPPER))
            elif ch.isalpha():
                out.append(self._rng.choice(_LOWER))
            else:
                out.append(ch)
            previous_digit = ch.isdigit()
        return "".join(out)

    def _some_day(self) -> date:
        first, last = _SYNTHETIC_YEAR
        return first + timedelta(days=self._rng.randint(0, (last - first).days))

    def _date_like(self, m: re.Match[str]) -> str:
        month, sep, day, year = m.groups()
        d = self._some_day()
        y = str(d.year) if len(year) == 4 else f"{d.year % 100:02d}"
        return f"{d.month:0{len(month)}d}{sep}{d.day:0{len(day)}d}{sep}{y}"

    def _time_like(self, m: re.Match[str]) -> str:
        hour, _, meridiem = m.groups()
        if meridiem:
            h = self._rng.randint(1, 12)
        else:
            h = self._rng.randint(0, 23)
        minute = self._rng.randint(0, 59)
        return f"{h:0{len(hour)}d}:{minute:02d}{meridiem or ''}"

    def _new_serial(self, real: str) -> str:
        """A day in the synthetic year, a time of day, or both, as the real one was."""
        value = float(real)
        day = (self._some_day() - _EXCEL_EPOCH).days if value >= 1 else 0
        if value % 1 == 0:
            return str(day)
        return repr(day + self._rng.randint(1, 1439) / 1440)

    def _new_number(self, real: str) -> str:
        """Same digits either side of the point, leading zeros and exponent."""
        mantissa, _, exponent = real.partition("E")
        out = []
        significant = False
        for ch in mantissa:
            if not ch.isdigit():
                out.append(ch)
            elif not significant and ch == "0":
                out.append(ch)
            else:
                out.append(str(self._rng.randint(0 if significant else 1, 9)))
                significant = True
        return "".join(out) + (f"E{exponent}" if exponent else "")

    def _new_path(self, real: str) -> str:
        scheme = _SCHEME.match(real)
        head = scheme.group(0) if scheme else ""
        parts = re.split(r"([/\\])", real[len(head) :])
        return head + "".join(self._segment(p) for p in parts)

    def _segment(self, segment: str) -> str:
        if segment in ("", "/", "\\", ".", "..") or re.fullmatch(r"[A-Za-z]:", segment):
            return segment
        plain = unquote(segment)
        ext = _EXTENSION.search(plain)
        stem = plain[: ext.start()] if ext else plain
        made = self._remembered("segment", stem, self._shaped) + (
            ext.group(0) if ext else ""
        )
        return quote(made, safe="@:()!,'") if plain != segment else made
