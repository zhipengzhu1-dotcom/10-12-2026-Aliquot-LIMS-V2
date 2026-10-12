"""Tracer Script: copy every input Artifact to /outputs byte for byte.

Sandbox Script convention: run as
    python /script/main.py --inputs /inputs --outputs /outputs
with /inputs/manifest.json listing the inputs and each input at
/inputs/<artifact_id>/<filename>.
"""

import argparse
import json
import shutil
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--outputs", type=Path, required=True)
    args = parser.parse_args(argv)

    manifest = json.loads((args.inputs / "manifest.json").read_text())
    for entry in manifest:
        source = args.inputs / entry["artifact_id"] / entry["filename"]
        target = args.outputs / entry["filename"]
        if target.exists():
            print(f"two inputs share the filename {entry['filename']}", file=sys.stderr)
            return 1
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        print(f"copied {entry['filename']} ({source.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
