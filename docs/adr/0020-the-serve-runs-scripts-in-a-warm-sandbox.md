---
status: accepted
---

# The serve runs Scripts in a warm Sandbox

ADR-0003 gave each Run a container of its own. Starting one takes about 0.4 s, and the chat flow runs several Scripts while the Operator waits, so the owner asked for the result "instantly" (#79). `aliquot serve` now keeps one Sandbox container per image warm and runs each of its Runs in it. The command line still starts a container per Run.

A warm container starts with the cold Run's flags: `--network none`, `--cap-drop ALL`, the same CPU, memory and process limits, a read-only root and a tmpfs `/tmp`. It has the cold Run's mounts: `/script` and `/inputs` read-only and `/outputs` writable. Its PID 1 is a supervisor, `sandbox/warm/supervisor.py`, mounted read-only from the repository rather than baked into the image, so the image id a Script is registered on does not change. For each Run it starts the cold Run's command, `python /script/<entrypoint> --inputs /inputs --outputs /outputs` in `/tmp`, as a new interpreter, and kills it at the Run's time limit with exit code 124. A Run records the same Events, in the same order, with the same fields, and a warm Run of a Script on the same inputs writes the bytes a cold Run writes.

The container holds one Run at a time, and a Run of the same image waits for the one before it. Nothing a Run did survives it. When its Script ends, the supervisor kills every other process in the container. A Script cannot signal PID 1, so it cannot stop the supervisor or hide from it. Once the Conductor has read the Run's outputs, and before the next Run starts, the supervisor empties `/outputs`, `/tmp` and `/dev/shm`, the only places a Run can write, and the Conductor empties `/script` and `/inputs`. So no Run can read another's files, and each Run starts in a fresh working directory.

A container that stops while a Run is in flight fails that Run. Its `RunFinished` carries Docker's exit code, and its stderr Artifact names the container and says that the next Run starts a fresh one. The next Run of that image starts a new container. When the supervisor misses a Run's time limit by more than ten seconds, the Conductor kills the container. Containers are named `aliquot-warm-<serve pid>-<random>`, so one serve never collides with another. When the serve stops on SIGINT or SIGTERM it closes their stdin, and the supervisor exits. A serve killed outright closes that stdin too, by dying, so `--rm` removes a container that no serve holds.

## Considered Options

- `docker exec` into a warm container. Rejected because an exec costs most of what a new container costs on Docker Desktop, and the mounts are fixed when the container starts, so a Run's inputs cannot get a read-only mount of their own.
- Forking each Run from a supervisor that has already imported Python. Rejected because a Run would inherit the supervisor's interpreter state, so a warm Run could behave differently from a cold one. A new interpreter per Run costs about 20 ms once the image ships compiled stdlib bytecode, which it now does.
- Several Runs at once in one container. Rejected because Runs that share a container share its uid and its writable directories. Serializing Runs is what keeps one Run from reading another's files.

## Consequences

- Two Runs on the same image in the serve run one after the other. The Scheduler's Turns are mostly model time, so the queue is short.
- The image compiles its Python bytecode when it is built. The root filesystem is read-only at run time, so without this step every Run, warm or cold, compiled the stdlib modules it imported, about 35 ms for `argparse`, `json` and `re`. A new build has a new image id. Scripts already registered keep the image they name.
- A Run's `duration_ms` in the serve measures only the Script, because the container is already up. The same Run on the command line also counts the start of its container.
