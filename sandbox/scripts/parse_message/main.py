"""Read a Message reporting received Samples into a submission record.

Sandbox Script convention: run as
    python /script/main.py --inputs /inputs --outputs /outputs
with /inputs/manifest.json listing the inputs and each input at
/inputs/<artifact_id>/<filename>. The inputs must hold exactly one Message,
stored as `Other` JSON in the shape `store_message` writes:

    {"seq": 12, "room": "RM-lab", "said_by": "Operator",
     "ts": "2026-10-13T09:30:00.000Z", "body": "Received 3 bottles of ..."}

The body is free text. Each value is read by a labelled pattern, never
guessed:

- the Lot, after "Lot" (a value holding a digit, so "a lot of" is no Lot);
- the Product Code, after "Product Code";
- the Client, after "from", up to the next comma or full stop;
- the quantity and the product name, from "<n> bottles of <product>" (also
  containers, jars, vials, bags, boxes, tubs, packs, pouches or units);
- the Sample Type, from "finished product" (FP), "in-process" (IP),
  "raw material" (RM) or "R&D";
- the TAT code, from "regular TAT" (1), "rush 1-2 days" (2),
  "rush 3-4 days" (3) or "TAT code <n>";
- the Product Type, the product's pack configuration, after "Product Type",
  up to the next comma or full stop;
- the Report To party, after "Report to", to the end of its line: the
  company first, then each of "Contact", "Address", "City", "Phone" and
  "Email" it states, each label after a comma or semicolon and each value
  running to the next label. The party's labels are read only there, and
  every other value only outside it, so the party ends the Message or its
  line:

      ... regular TAT. Report to: Acme Nutrition; Contact: Dana Reyes;
      Address: 12 Harbor Road; City: Portland, OR 97201

A value the body does not state is "". The Script refuses (exit 1, the
reason on stderr, no outputs) a Message that names two different values for
one of them, or that does not name every value the Report of Analysis is
rendered from (`REQUIRED`): the Lot, the Product Code, the Client, the
product, the Product Type, and the Report To company, contact, address and
city. The refusal names every one missing, so the Director can ask for
them all at once; a Message that cannot reach a report never reaches stage 2.

Output `/outputs/submission_record.json`, typed `SubmissionRecord`, in the
`submission/2` shape `parse_submission` writes for stage 1, with the one
Sample the Message reports, so stage 2 reads it the same way. The receipt
is the Message: the date and time received are
its `ts` (UTC), and `received_by` is who said it. Nothing in a Message
gives the submission date, the Bill To party or the Submitted By party's
contact details, so those are "".
"""

import argparse
import json
import re
import sys
from pathlib import Path

SCHEMA = "submission/2"
PARTIES = ("submitted_by", "bill_to", "report_to")
PARTY_FIELDS = ("company", "contact", "address", "city", "phone", "email")

# Copied from sandbox/synth/tat.py: the container mounts only this directory.
TAT_CODES = {"1": "Regular", "2": "Rush1to2Days", "3": "Rush3to4Days"}

LOT = re.compile(r"\bLot\s*(?:#|No\.?|:)?\s*([A-Za-z0-9-]*\d[A-Za-z0-9-]*)", re.I)
PRODUCT_CODE = re.compile(
    r"\bProduct\s+Code\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9-]*)", re.I
)
CLIENT = re.compile(r"\bfrom\s+([^,.;\n]+)", re.I)
PRODUCT_TYPE = re.compile(r"\bProduct\s+Type\s*:?\s*([^,.;\n]+)", re.I)
REPORT_TO = re.compile(r"\bReport\s+to\b\s*:?[ \t]*([^\n]*)", re.I)
REPORT_TO_LABEL = re.compile(
    r"(?:^|[,;])\s*(Contact|Address|City|Phone|Email)\b\s*:?\s*", re.I
)
CONTAINERS = (
    r"(?:bottles?|containers?|jars?|vials?|bags?|box(?:es)?|tubs?|packs?"
    r"|pouch(?:es)?|units?)"
)
QUANTITY = re.compile(rf"\b(\d+)\s+{CONTAINERS}\s+of\s+([^,;\n]+)", re.I)
# A product name ends where the next labelled value begins.
NEXT_LABEL = re.compile(
    r"\s+(?:Lot|Product\s+(?:Code|Type)|from|Report\s+to)\b.*$", re.I | re.S
)
SAMPLE_TYPES = (
    (re.compile(r"\bfinished\s+products?\b", re.I), "FP"),
    (re.compile(r"\bin[-\s]process\b", re.I), "IP"),
    (re.compile(r"\braw\s+materials?\b", re.I), "RM"),
    (re.compile(r"\bR&D\b", re.I), "R&D"),
)
TATS = (
    (re.compile(r"\bregular\s+TAT\b", re.I), "1"),
    (
        re.compile(
            r"\brush\s+(?:in\s+)?1\s*(?:-|to)\s*2\s+(?:business\s+)?days?\b", re.I
        ),
        "2",
    ),
    (
        re.compile(
            r"\brush\s+(?:in\s+)?3\s*(?:-|to)\s*4\s+(?:business\s+)?days?\b", re.I
        ),
        "3",
    ),
    (re.compile(r"\bTAT\s+code\s+([123])\b", re.I), None),
)


class MessageError(Exception):
    """The inputs are not a Message this Script can read as received Samples."""


def one(label: str, values: list[str]) -> str:
    """The single value the body states for `label`, or "" when it states none."""
    distinct = sorted(set(values))
    if len(distinct) > 1:
        raise MessageError(
            f"the Message names {len(distinct)} {label}s: {', '.join(distinct)}"
        )
    return distinct[0] if distinct else ""


def matches(pattern: re.Pattern[str], body: str) -> list[str]:
    return [m.group(1).strip() for m in pattern.finditer(body)]


def sample_type(body: str) -> str:
    return one(
        "Sample Type", [code for pattern, code in SAMPLE_TYPES if pattern.search(body)]
    )


def tat_code(body: str) -> str:
    codes = []
    for pattern, code in TATS:
        for match in pattern.finditer(body):
            codes.append(code if code is not None else match.group(1))
    return one("TAT code", codes)


def report_to(body: str) -> tuple[str, dict[str, str]]:
    """The body without its Report To party, and the party it states."""
    blocks = list(REPORT_TO.finditer(body))
    if not blocks:
        return body, dict.fromkeys(PARTY_FIELDS, "")
    if len(blocks) > 1:
        raise MessageError(f"the Message names {len(blocks)} Report To parties")
    [block] = blocks
    text = block.group(1)
    labels = list(REPORT_TO_LABEL.finditer(text))
    stated: dict[str, list[str]] = {field: [] for field in PARTY_FIELDS}
    stated["company"].append(text[: labels[0].start() if labels else len(text)])
    ends = [label.start() for label in labels[1:]] + [len(text)]
    for label, end in zip(labels, ends, strict=True):
        stated[label.group(1).lower()].append(text[label.end() : end])
    party = {
        field: one(
            f"Report To {field} value",
            [v.strip(" \t,;") for v in values if v.strip(" \t,;")],
        )
        for field, values in stated.items()
    }
    return body[: block.start()] + body[block.end() :], party


# Every value the Report of Analysis is rendered from that a Message must
# give: (its name, its section of the record, its key there). `sample` is the
# record's one Sample.
REQUIRED = (
    ("Lot", "sample", "lot"),
    ("Product Code", "sample", "product_code"),
    ("Client", "submitted_by", "company"),
    ("product", "sample", "sample_description"),
    ("Product Type", "sample", "product_type"),
    ("Report To company", "report_to", "company"),
    ("Report To contact", "report_to", "contact"),
    ("Report To address", "report_to", "address"),
    ("Report To city", "report_to", "city"),
)


def parse(message: dict) -> dict:
    body, report_to_party = report_to(message["body"])
    lot = one("Lot", matches(LOT, body))
    product_code = one("Product Code", matches(PRODUCT_CODE, body))
    quantities = [
        (m.group(1), NEXT_LABEL.sub("", m.group(2)).strip())
        for m in QUANTITY.finditer(body)
    ]
    containers = one("quantity", [q for q, _ in quantities])
    product = one("product name", [p for _, p in quantities])
    code = tat_code(body)
    ts = message["ts"]

    parties = {party: dict.fromkeys(PARTY_FIELDS, "") for party in PARTIES}
    parties["submitted_by"]["company"] = one("Client", matches(CLIENT, body))
    parties["report_to"] = report_to_party
    sample = {
        "no": "1",
        "sample_description": product,
        "sample_type": sample_type(body),
        "tat_code": code,
        "tat_class": TAT_CODES.get(code, ""),
        "lot": lot,
        "product_code": product_code,
        "product_type": one("Product Type", matches(PRODUCT_TYPE, body)),
        "no_of_containers": containers,
    }
    sections = {**parties, "sample": sample}
    missing = [name for name, section, key in REQUIRED if not sections[section][key]]
    if missing:
        raise MessageError(f"the Message names no {' and no '.join(missing)}")
    return {
        "schema": SCHEMA,
        "date_submitted": "",
        **parties,
        "samples": [sample],
        "receipt": {
            "date_received": ts[:10],
            "time_received": ts[11:16],
            "received_by": message["said_by"],
        },
    }


def message_of(inputs: Path) -> dict:
    manifest = json.loads((inputs / "manifest.json").read_text())
    if len(manifest) != 1:
        raise MessageError(f"expected exactly one Message input, got {len(manifest)}")
    [entry] = manifest
    try:
        message = json.loads(
            (inputs / entry["artifact_id"] / entry["filename"]).read_text()
        )
    except json.JSONDecodeError as error:
        raise MessageError(f"the input is not JSON: {error}") from error
    keys = {"seq", "room", "said_by", "ts", "body"}
    if not isinstance(message, dict) or not keys <= message.keys():
        raise MessageError(
            f"the input is not a Message: it needs {', '.join(sorted(keys))}"
        )
    return message


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--outputs", type=Path, required=True)
    args = parser.parse_args(argv)

    try:
        message = message_of(args.inputs)
        record = parse(message)
    except MessageError as error:
        print(f"parse_message refused its input: {error}", file=sys.stderr)
        return 1

    (args.outputs / "submission_record.json").write_text(
        json.dumps(record, indent=2, sort_keys=True) + "\n"
    )
    (args.outputs / "manifest.json").write_text(
        json.dumps(
            {
                "submission_record.json": {
                    "artifact_type": "SubmissionRecord",
                    "media_type": "application/json",
                }
            },
            indent=2,
        )
        + "\n"
    )
    [sample] = record["samples"]
    print(
        f"parsed Message seq {message['seq']}: Lot {sample['lot']},"
        f" Product Code {sample['product_code']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
