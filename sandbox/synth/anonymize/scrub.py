"""Scrub one Office document part by part.

The parts are rewritten as text, never parsed and serialized again: a
round trip through an XML library renames namespace prefixes, and Office
refuses a file whose `mc:Ignorable` names a prefix that no longer exists.
Every part name must match a row of `PARTS`; an unknown part stops the
scrub, so a kind of content nobody has looked at cannot pass through.
"""

import re
import struct
import zlib
from collections.abc import Callable
from dataclasses import dataclass
from html import unescape
from xml.sax.saxutils import escape

from synth.anonymize.labels import is_field_code, is_generic_sheet_name, is_kept
from synth.anonymize.synthesizer import Synthesizer


class UnknownContent(Exception):
    """A part, sheet name or record the allowlist has no rule for."""


@dataclass
class Scrub:
    synth: Synthesizer
    date_styles: frozenset[int] = frozenset()
    kept: int = 0
    replaced: int = 0

    def text(self, real: str) -> str:
        if is_kept(real):
            self.kept += 1
            return real
        self.replaced += 1
        return self.synth.text(real)

    def number(self, real: str, *, is_date: bool) -> str:
        if is_kept(real):
            self.kept += 1
            return real
        self.replaced += 1
        return self.synth.number(real, is_date=is_date)

    def path(self, real: str) -> str:
        self.replaced += 1
        return self.synth.path(real)


def _xml_text(scrub: Callable[[str], str]) -> Callable[[str], str]:
    """Apply a scrub to XML-escaped text and escape the result again."""
    return lambda raw: escape(scrub(unescape(raw)), {'"': "&quot;"})


# Text grouped by paragraph or shared string. A group whose whole text is a
# label is kept; otherwise each run is judged on its own.


def _grouped(xml: str, group: str, text_tag: str, s: Scrub) -> str:
    token = re.compile(
        rf"(?P<open><{group}(?=[\s>])[^>]*(?<!/)>)|(?P<close></{group}>)"
        rf"|(?P<head><{text_tag}(?=[\s>])[^>]*(?<!/)>)(?P<body>[^<]*)</{text_tag}>"
    )
    stack: list[list[re.Match[str]]] = []
    edits: list[tuple[int, int, str]] = []

    def judge(runs: list[re.Match[str]]) -> None:
        whole = unescape("".join(r.group("body") for r in runs))
        if runs and is_kept(whole):
            s.kept += len(runs)
            return
        for r in runs:
            edits.append(
                (r.start("body"), r.end("body"), _xml_text(s.text)(r.group("body")))
            )

    for m in token.finditer(xml):
        if m.group("open"):
            stack.append([])
        elif m.group("close"):
            if stack:
                judge(stack.pop())
        elif stack:
            stack[-1].append(m)
        else:
            judge([m])
    return _apply(xml, edits)


def _apply(text: str, edits: list[tuple[int, int, str]]) -> str:
    out, at = [], 0
    for start, end, new in sorted(edits):
        out.append(text[at:start])
        out.append(new)
        at = end
    out.append(text[at:])
    return "".join(out)


def _attributes(xml: str, names: str, scrub: Callable[[str], str]) -> str:
    return re.sub(
        rf'(\s(?:{names})=")([^"]*)(")',
        lambda m: m.group(1) + _xml_text(scrub)(m.group(2)) + m.group(3),
        xml,
    )


# Formulas keep their functions, references and operators. Number and
# string literals are values and are replaced.

_FORMULA_TOKEN = re.compile(
    r'(?P<string>"(?:[^"]|"")*")'
    r"|(?P<sheet>'(?:[^']|'')*'!)"
    r"|(?P<book>\[\d+\])"
    r"|(?P<rows>\$?\d+:\$?\d+)"
    r"|(?P<name>\$?[A-Za-z_][\w.]*\$?\d*)"
    r"|(?P<number>\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)"
    r"|(?P<other>.)",
    re.S,
)


def _sheet_name(name: str) -> str:
    if not is_generic_sheet_name(name):
        raise UnknownContent("a sheet name the allowlist does not hold")
    return name


def formula(text: str, s: Scrub) -> str:
    out = []
    for m in _FORMULA_TOKEN.finditer(text):
        kind, tok = m.lastgroup, m.group(0)
        if kind == "string":
            inner = tok[1:-1].replace('""', '"')
            out.append('"' + s.text(inner).replace('"', '""') + '"')
        elif kind == "number":
            out.append(s.number(tok, is_date=False))
        elif kind == "sheet":
            book = re.match(r"'(\[\d+\])?", tok)
            _sheet_name(tok[book.end() : -2].replace("''", "'"))
            out.append(tok)
        else:
            out.append(tok)
    return "".join(out)


def _formulas(xml: str, tag: str, s: Scrub) -> str:
    return re.sub(
        rf"(<{tag}(?:\s[^>]*)?>)([^<]*)(</{tag}>)",
        lambda m: (
            m.group(1) + _xml_text(lambda f: formula(f, s))(m.group(2)) + m.group(3)
        ),
        xml,
    )


_BUILTIN_DATE_FORMATS = frozenset(
    {*range(14, 23), *range(27, 37), 45, 46, 47, *range(50, 59)}
)


def date_styles(styles_xml: str) -> frozenset[int]:
    """The cell style indexes whose number format shows a date or a time."""
    custom = {
        int(m.group(1)): unescape(m.group(2))
        for m in re.finditer(
            r'<numFmt numFmtId="(\d+)" formatCode="([^"]*)"', styles_xml
        )
    }

    def is_date_format(fmt_id: int) -> bool:
        if fmt_id in _BUILTIN_DATE_FORMATS:
            return True
        code = re.sub(r'"[^"]*"|\[[^\]]*\]|\\.', "", custom.get(fmt_id, ""))
        return re.search(r"[dmyhs]", code, re.I) is not None

    xfs = re.search(r"<cellXfs[^>]*>(.*?)</cellXfs>", styles_xml, re.S)
    ids = re.findall(r'<xf [^>]*?numFmtId="(\d+)"', xfs.group(1)) if xfs else []
    return frozenset(i for i, fmt in enumerate(ids) if is_date_format(int(fmt)))


_CELL = re.compile(r"<c(?=[\s>/])([^>]*?)(?:/>|>(.*?)</c>)", re.S)


def _cell(m: re.Match[str], s: Scrub) -> str:
    attrs, body = m.group(1), m.group(2)
    if body is None:
        return m.group(0)
    kind = re.search(r'\bt="(\w+)"', attrs)
    kind = kind.group(1) if kind else "n"
    style = re.search(r'\bs="(\d+)"', attrs)
    is_date = style is not None and int(style.group(1)) in s.date_styles
    body = _formulas(body, "f", s)
    if kind == "inlineStr":
        body = _grouped(body, "is", "t", s)
    elif kind in ("str", "n"):

        def value(v: str) -> str:
            return s.text(v) if kind == "str" else s.number(v, is_date=is_date)

        body = re.sub(
            r"(<v>)([^<]*)(</v>)",
            lambda v: v.group(1) + _xml_text(value)(v.group(2)) + v.group(3),
            body,
        )
    return f"<c{attrs}>{body}</c>"


def _header_footer(text: str, s: Scrub) -> str:
    parts = re.split(r'(&"[^"]*"|&\d+|&.)', text)
    return "".join(p if p.startswith("&") or not p else s.text(p) for p in parts)


def sheet(xml: str, s: Scrub) -> str:
    xml = _CELL.sub(lambda m: _cell(m, s), xml)
    xml = re.sub(
        r"(<(?:odd|even|first)(?:Header|Footer)>)([^<]*)(<)",
        lambda m: (
            m.group(1)
            + _xml_text(lambda t: _header_footer(t, s))(m.group(2))
            + m.group(3)
        ),
        xml,
    )
    for tag in ("formula", "formula1", "formula2"):
        xml = _formulas(xml, tag, s)
    return _attributes(
        xml, "display|tooltip|prompt|error|promptTitle|errorTitle", s.text
    )


def shared_strings(xml: str, s: Scrub) -> str:
    return _grouped(xml, "si", "t", s)


def workbook(xml: str, s: Scrub) -> str:
    for m in re.finditer(r'<sheet name="([^"]*)"', xml):
        _sheet_name(unescape(m.group(1)))
    xml = _attributes(xml, "url", s.path)
    xml = _attributes(xml, "userName", s.text)
    return _formulas(xml, "definedName", s)


def external_link(xml: str, s: Scrub) -> str:
    for m in re.finditer(r'<sheetName val="([^"]*)"', xml):
        _sheet_name(unescape(m.group(1)))

    def cell(m: re.Match[str]) -> str:
        is_text = 't="str"' in m.group(1)

        def value(v: str) -> str:
            return s.text(v) if is_text else s.number(v, is_date=False)

        return m.group(1) + _xml_text(value)(m.group(2)) + m.group(3)

    return re.sub(r"(<cell [^>]*><v>)([^<]*)(</v>)", cell, xml)


def drawing(xml: str, s: Scrub) -> str:
    xml = _grouped(xml, "a:p", "a:t", s)
    return _attributes(xml, "descr|title", s.text)


def persons(xml: str, s: Scrub) -> str:
    return _attributes(xml, "displayName|userId", s.text)


def word(xml: str, s: Scrub) -> str:
    xml = _grouped(xml, "w:p", "w:t", s)
    xml = re.sub(
        r"(<w:instrText(?:\s[^>]*)?>)([^<]*)(</w:instrText>)",
        lambda m: (
            m.group(1)
            + (
                m.group(2)
                if is_field_code(unescape(m.group(2)))
                else _xml_text(s.text)(m.group(2))
            )
            + m.group(3)
        ),
        xml,
    )
    # The shape's legacy preview: a zipped copy Word rebuilds from the shape itself.
    xml = re.sub(r'\so:gfxdata="[^"]*"', "", xml)
    xml = _attributes(xml, "descr|title", s.text)
    return re.sub(
        r'(<w:(?:alias|tag) w:val=")([^"]*)(")',
        lambda m: m.group(1) + _xml_text(s.text)(m.group(2)) + m.group(3),
        xml,
    )


def relationships(xml: str, s: Scrub) -> str:
    def external(m: re.Match[str]) -> str:
        rel = m.group(0)
        if 'TargetMode="External"' not in rel:
            return rel
        return re.sub(
            r'(Target=")([^"]*)(")',
            lambda t: t.group(1) + _xml_text(s.path)(t.group(2)) + t.group(3),
            rel,
        )

    return re.sub(r"<Relationship [^>]*>", external, xml)


_PEOPLE_AND_TITLES = (
    "dc:creator|cp:lastModifiedBy|dc:title|dc:subject|dc:description"
    "|cp:keywords|cp:category|cp:contentStatus"
)
_WHEN = "cp:lastPrinted|dcterms:created|dcterms:modified"


def core_properties(xml: str, s: Scrub) -> str:
    xml = re.sub(rf"(<({_PEOPLE_AND_TITLES})(?:\s[^>]*)?>)[^<]*(</\2>)", r"\1\3", xml)
    return re.sub(
        rf"(<({_WHEN})(?:\s[^>]*)?>)[^<]*(</\2>)", r"\g<1>2026-01-01T00:00:00Z\3", xml
    )


def app_properties(xml: str, s: Scrub) -> str:
    return re.sub(r"(<(Company|Manager|HyperlinkBase)>)[^<]*(</\2>)", r"\1\3", xml)


def blank_png(data: bytes) -> bytes:
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise UnknownContent("an image that is not a PNG")
    width, height = struct.unpack(">II", data[16:24])

    def chunk(kind: bytes, body: bytes) -> bytes:
        return (
            struct.pack(">I", len(body))
            + kind
            + body
            + struct.pack(">I", zlib.crc32(kind + body))
        )

    rows = (b"\x00" + b"\xff" * width) * height
    header = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    return (
        data[:8]
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(rows, 9))
        + chunk(b"IEND", b"")
    )


def blank_emf(data: bytes) -> bytes:
    """The header record, its bounds kept and its description dropped, then EOF."""
    kind, size = struct.unpack("<II", data[:8])
    if kind != 1 or size < 88:
        raise UnknownContent("a thumbnail that is not an EMF")
    size = min(size, 108)
    header = bytearray(data[:size])
    eof = struct.pack("<IIIII", 14, 20, 0, 16, 20)
    struct.pack_into("<I", header, 4, size)
    struct.pack_into("<IIH", header, 48, size + len(eof), 2, 1)
    struct.pack_into("<III", header, 60, 0, 0, 0)
    if size >= 100:
        struct.pack_into("<III", header, 88, 0, 0, 0)
    return bytes(header) + eof


def blank_devmode(data: bytes) -> bytes:
    """A printer's settings without its name or its driver's private data."""
    (size,) = struct.unpack_from("<H", data, 68)
    out = bytearray(data[:size])
    out[0:64] = bytes(64)
    struct.pack_into("<H", out, 70, 0)
    return bytes(out)


Text = Callable[[str, Scrub], str]
PARTS: list[tuple[str, Text | Callable[[bytes], bytes] | None]] = [
    (r"\[Content_Types\]\.xml", None),
    (r"(?:.*/)?_rels/[^/]*\.rels", relationships),
    (r"docProps/core\.xml", core_properties),
    (r"docProps/app\.xml", app_properties),
    (r"docProps/thumbnail\.emf", blank_emf),
    (r"(?:xl|word)/media/[^/]+\.png", blank_png),
    (r"(?:xl|word)/theme/theme\d+\.xml", None),
    (r"xl/styles\.xml", None),
    (r"xl/calcChain\.xml", None),
    (r"xl/metadata\.xml", None),
    (r"xl/printerSettings/printerSettings\d+\.bin", blank_devmode),
    (r"xl/workbook\.xml", workbook),
    (r"xl/sharedStrings\.xml", shared_strings),
    (r"xl/worksheets/sheet\d+\.xml", sheet),
    (r"xl/externalLinks/externalLink\d+\.xml", external_link),
    (r"xl/drawings/drawing\d+\.xml", drawing),
    (r"xl/persons/person\.xml", persons),
    # An empty Power Query package and an empty bibliography in these templates.
    (r"customXml/item\d+\.xml", None),
    (r"customXml/itemProps\d+\.xml", None),
    (r"word/(?:styles|numbering|fontTable|webSettings|settings)\.xml", None),
    (r"word/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml", word),
]

BINARY = (blank_emf, blank_png, blank_devmode)


def rule_for(name: str):
    for pattern, rule in PARTS:
        if re.fullmatch(pattern, name):
            return rule
    raise UnknownContent(f"a part with no scrub rule: {name}")


def scrub_part(name: str, data: bytes, s: Scrub) -> bytes:
    rule = rule_for(name)
    if rule is None:
        return data
    if rule in BINARY:
        return rule(data)
    return rule(data.decode("utf-8"), s).encode("utf-8")
