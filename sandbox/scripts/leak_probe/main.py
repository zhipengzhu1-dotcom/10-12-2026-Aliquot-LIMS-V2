"""Test Script: report what an earlier Run left behind, then leave things behind.

Writes /outputs/seen.json: every entry it finds in /tmp, /dev/shm, /outputs
and /inputs, every process but itself and its parent, and whether it could
write to /inputs. Then it leaves a file in /tmp and /dev/shm, a directory
only it may open, and a detached process that outlives it, so the next Run
shows whether any of them survived.
"""

import json
import os
import sys
import time
from pathlib import Path


def entries(directory: str) -> list[str]:
    return sorted(
        str(path.relative_to(directory)) for path in Path(directory).rglob("*")
    )


def others() -> list[str]:
    mine = {os.getpid(), os.getppid()}
    found = []
    for entry in os.listdir("/proc"):
        if entry.isdigit() and int(entry) not in mine:
            try:
                found.append(Path(f"/proc/{entry}/cmdline").read_bytes().decode())
            except OSError:
                continue
    return sorted(found)


def writable(directory: str) -> bool:
    try:
        (Path(directory) / "planted").write_text("planted")
        return True
    except OSError:
        return False


def linger() -> None:
    if os.fork() == 0:
        os.setsid()
        if os.fork() == 0:
            while True:
                time.sleep(60)
        os._exit(0)


def main() -> int:
    seen = {
        "tmp": entries("/tmp"),
        "shm": entries("/dev/shm"),
        "outputs": entries("/outputs"),
        "inputs": entries("/inputs"),
        "processes": others(),
        "inputs_writable": writable("/inputs"),
    }
    (Path("/outputs") / "seen.json").write_text(json.dumps(seen, indent=2))
    Path("/tmp/left-in-tmp").write_text("left")
    Path("/dev/shm/left-in-shm").write_text("left")
    locked = Path("/tmp/locked")
    locked.mkdir()
    (locked / "secret").write_text("left")
    locked.chmod(0)
    sys.stdout.flush()
    linger()
    return 0


if __name__ == "__main__":
    sys.exit(main())
