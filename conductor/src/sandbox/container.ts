import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RunId } from "../ids.js";

/**
 * The container's limits (ADR-0003). A cold Run's container and a warm
 * container both start with them, so a Run in either has the same limits.
 */
export const SANDBOX_FLAGS = [
	"--network",
	"none",
	"--cap-drop",
	"ALL",
	"--cpus",
	"1",
	"--memory",
	"512m",
	"--pids-limit",
	"256",
	"--read-only",
	"--tmpfs",
	"/tmp",
] as const;

/**
 * Exit code of a Run the Sandbox kills at its time limit: 124, the timeout
 * convention of coreutils `timeout`. Docker reports 137 (128 + SIGKILL) for
 * any killed container, so 137 keeps meaning an OOM kill or a kill from
 * outside the runner.
 */
export const TIME_LIMIT_EXIT_CODE = 124;

/** How a Run's Script ended; `notes` are the Sandbox's own lines for its stderr. */
export type Exit = {
	code: number;
	stdout: Buffer;
	stderr: Buffer;
	notes: string[];
};

/**
 * One Run's place in a Sandbox: host directories the container sees as
 * `/inputs` (read-only) and `/outputs`, which the runner fills and reads,
 * and the Script's run. `release` removes the Run's files; nothing the Run
 * wrote survives it.
 */
export type Workspace = {
	readonly inputs: string;
	readonly outputs: string;
	execute(run: {
		run_id: RunId;
		entrypoint: string;
		timeoutMs: number;
	}): Promise<Exit>;
	release(): Promise<void>;
};

/**
 * Where Runs happen. `workspace` gives a Run of the Script in `scriptDir`
 * on `image` its Workspace, or undefined when Docker does not have `image`.
 */
export type Sandbox = {
	workspace(image: string, scriptDir: string): Promise<Workspace | undefined>;
};

export const scriptCommand = (entrypoint: string) => [
	"python",
	`/script/${entrypoint}`,
	"--inputs",
	"/inputs",
	"--outputs",
	"/outputs",
];

/** A fresh `inputs/` and `outputs/` under `root`; uid 10001 must write `outputs/`. */
export const runDirs = (root: string) => {
	const inputs = join(root, "inputs");
	const outputs = join(root, "outputs");
	mkdirSync(inputs, { mode: 0o755 });
	mkdirSync(outputs);
	chmodSync(outputs, 0o777);
	return { inputs, outputs };
};
