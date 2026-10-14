"""Test Script: try to reach the warm Sandbox's supervisor, PID 1.

It tries to write a forged answer to PID 1's stdout through /proc/1/fd/1
and to open /proc/1/mem, and writes /outputs/reached.json: for each, the
error that stopped it, or "reached" when nothing did.
"""

import json
import sys
from pathlib import Path

FORGED = {"exit_code": 0, "timed_out": False, "stdout": "", "stderr": ""}


def attempt(path: str, mode: str, payload: bytes | None) -> str:
    try:
        with open(path, mode) as target:
            if payload is not None:
                target.write(payload)
        return "reached"
    except OSError as error:
        return f"{type(error).__name__}: {error.strerror}"


def main() -> int:
    forged = (json.dumps(FORGED) + "\n").encode()
    reached = {
        "fd1": attempt("/proc/1/fd/1", "wb", forged),
        "mem": attempt("/proc/1/mem", "rb", None),
    }
    (Path("/outputs") / "reached.json").write_text(json.dumps(reached))
    return 0


if __name__ == "__main__":
    sys.exit(main())
