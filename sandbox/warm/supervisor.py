"""The warm Sandbox's supervisor: PID 1 of a warm container (ADR-0020).

The Conductor starts it as
    docker run -i <the cold Run's flags> ... python /aliquot/supervisor.py
with the same /script, /inputs and /outputs mounts a cold Run has, and talks
to it in JSON lines over stdin and stdout. It answers {"ready": true} once,
then serves one request at a time:

- {"run": "<entrypoint>", "timeout_ms": <n>} runs
  `python /script/<entrypoint> --inputs /inputs --outputs /outputs` in /tmp,
  the cold Run's command, and answers {"exit_code", "timed_out", "stdout",
  "stderr"} with both streams base64. A Run past its time limit is killed.
- {"reset": true} empties every place a Run can write (/outputs, /tmp and
  /dev/shm) and answers {"reset": true}.

After every Run it kills every process but itself, so nothing a Script
started outlives its Run. As PID 1 it cannot be signalled from inside the
container. It exits when stdin closes, so a container whose Conductor is gone
stops, and `--rm` removes it.
"""

import base64
import ctypes
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
from pathlib import Path
from typing import IO

WRITABLE = (Path("/outputs"), Path("/tmp"), Path("/dev/shm"))
TIME_LIMIT_EXIT_CODE = 124
PR_SET_DUMPABLE = 4


def answer(message: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def reap() -> None:
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def others() -> list[int]:
    """Every live process in the container but this one."""
    me = os.getpid()
    live = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit() or int(entry) == me:
            continue
        try:
            stat = Path(f"/proc/{entry}/stat").read_text()
        except OSError:
            continue
        if stat.rsplit(")", 1)[1].split()[0] != "Z":
            live.append(int(entry))
    return live


def kill_others() -> None:
    # A process can fork while it is being killed, so sweep until none is left.
    while live := others():
        for pid in live:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        reap()
    reap()


def drain(stream: IO[bytes], into: list[bytes]) -> threading.Thread:
    def read() -> None:
        into.append(stream.read())

    thread = threading.Thread(target=read)
    thread.start()
    return thread


def run(entrypoint: str, timeout_ms: int) -> dict[str, object]:
    child = subprocess.Popen(
        [
            sys.executable,
            f"/script/{entrypoint}",
            "--inputs",
            "/inputs",
            "--outputs",
            "/outputs",
        ],
        cwd="/tmp",
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert child.stdout is not None and child.stderr is not None
    stdout: list[bytes] = []
    stderr: list[bytes] = []
    readers = [drain(child.stdout, stdout), drain(child.stderr, stderr)]
    timed_out = False
    try:
        code = child.wait(timeout=timeout_ms / 1000)
    except subprocess.TimeoutExpired:
        timed_out = True
        child.kill()
        child.wait()
        code = TIME_LIMIT_EXIT_CODE
    # A Script's leftover processes hold its pipes open; killing them ends the reads.
    kill_others()
    for reader in readers:
        reader.join()
    if code < 0:
        code = 128 - code
    return {
        "exit_code": code,
        "timed_out": timed_out,
        "stdout": base64.b64encode(b"".join(stdout)).decode("ascii"),
        "stderr": base64.b64encode(b"".join(stderr)).decode("ascii"),
    }


def empty(directory: Path) -> None:
    # A Script may have locked its own directories; it cannot lock them from us.
    for root, dirs, _ in os.walk(directory):
        for name in dirs:
            path = os.path.join(root, name)
            if not os.path.islink(path):
                os.chmod(path, 0o700)
    for entry in directory.iterdir():
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry, ignore_errors=True)
        else:
            entry.unlink(missing_ok=True)


def reset() -> None:
    kill_others()
    for directory in WRITABLE:
        empty(directory)


def undumpable() -> None:
    # A Script runs under this process's uid. Not dumpable, this process's
    # /proc/1 entries belong to root, so a Script cannot write to its pipes,
    # read its memory or ptrace it. An execve makes the Script dumpable again.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_DUMPABLE, 0) failed")


def main() -> None:
    undumpable()
    answer({"ready": True})
    for line in sys.stdin:
        request = json.loads(line)
        if "run" in request:
            answer(run(request["run"], request["timeout_ms"]))
        else:
            reset()
            answer({"reset": True})


if __name__ == "__main__":
    main()
