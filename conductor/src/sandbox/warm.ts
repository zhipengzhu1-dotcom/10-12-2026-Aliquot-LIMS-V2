import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
	type Exit,
	runDirs,
	SANDBOX_FLAGS,
	type Sandbox,
	TIME_LIMIT_EXIT_CODE,
	type Workspace,
} from "./container.js";
import { imageId } from "./image.js";

/** `sandbox/warm/`: the supervisor every warm container runs as PID 1. */
const supervisorRoot = fileURLToPath(
	new URL("../../../sandbox/warm/", import.meta.url),
);

/** How long past a Run's time limit the supervisor may take to answer before its container is killed. */
const GRACE_MS = 10_000;

const Ready = z.strictObject({ ready: z.literal(true) });
const Finished = z.strictObject({
	exit_code: z.number().int(),
	timed_out: z.boolean(),
	stdout: z.string(),
	stderr: z.string(),
});
const Reset = z.strictObject({ reset: z.literal(true) });

type Stopped = { tag: "Stopped"; code: number };

/**
 * One warm container: `docker run -i` of the supervisor, with the cold Run's
 * flags and mounts. Its mounted directories live under `root` and are
 * emptied between Runs, never replaced: a bind mount holds the directory it
 * was given.
 */
type Container = {
	name: string;
	root: string;
	script: string;
	inputs: string;
	outputs: string;
	child: ChildProcessWithoutNullStreams;
	stopped: Promise<Stopped>;
	isStopped(): boolean;
	/** The supervisor's next answer, or how the container stopped first. */
	next(): Promise<unknown | Stopped>;
	stderr(): string;
};

const start = (image: string): Container => {
	const root = mkdtempSync(join(tmpdir(), "aliquot-warm-"));
	const script = join(root, "script");
	mkdirSync(script, { mode: 0o755 });
	const { inputs, outputs } = runDirs(root);
	const name = `aliquot-warm-${process.pid}-${randomUUID().slice(0, 8)}`;
	// Detached, so a Ctrl-C meant for the serve does not stop a Run in
	// flight: the serve stops its containers itself when it closes.
	const child = spawn(
		"docker",
		[
			"run",
			"-i",
			"--rm",
			"--name",
			name,
			"--label",
			"aliquot.warm=1",
			...SANDBOX_FLAGS,
			"-v",
			`${script}:/script:ro`,
			"-v",
			`${inputs}:/inputs:ro`,
			"-v",
			`${outputs}:/outputs`,
			"-v",
			`${supervisorRoot}:/aliquot:ro`,
			image,
			"python",
			"/aliquot/supervisor.py",
		],
		{ stdio: ["pipe", "pipe", "pipe"], detached: true },
	);
	const stderr: Buffer[] = [];
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
	let isStopped = false;
	const stopped = new Promise<Stopped>((resolve) => {
		child.on("error", () => {
			isStopped = true;
			resolve({ tag: "Stopped", code: 127 });
		});
		child.on("close", (status, signal) => {
			isStopped = true;
			resolve({
				tag: "Stopped",
				code: status ?? 128 + (signal ? constants.signals[signal] : 0),
			});
		});
	});
	// Writing to a container that has just stopped is not an error of its own.
	child.stdin.on("error", () => {});
	const lines = createInterface({ input: child.stdout })[
		Symbol.asyncIterator
	]();
	return {
		name,
		root,
		script,
		inputs,
		outputs,
		child,
		stopped,
		isStopped: () => isStopped,
		next: () =>
			Promise.race([
				lines
					.next()
					.then((line) =>
						line.done ? stopped : (JSON.parse(line.value) as unknown),
					),
				stopped,
			]),
		stderr: () => Buffer.concat(stderr).toString("utf8").slice(-2000),
	};
};

const isStopped = (answer: unknown): answer is Stopped =>
	(answer as Stopped | undefined)?.tag === "Stopped";

/** Remove every entry of `dir`, keeping `dir`. */
const empty = (dir: string) => {
	for (const entry of readdirSync(dir)) {
		rmSync(join(dir, entry), { recursive: true, force: true });
	}
};

/** Best effort: on Linux what a Script left behind belongs to uid 10001. */
const discard = (container: Container) => {
	try {
		rmSync(container.root, { recursive: true, force: true });
	} catch {}
};

const kill = (container: Container) =>
	new Promise<void>((resolve) =>
		spawn("docker", ["kill", container.name], { stdio: "ignore" })
			.on("error", () => resolve())
			.on("close", () => resolve()),
	);

/** One image's warm container, and the queue of Runs waiting for it. */
type Slot = { container?: Container | undefined; queue: Promise<void> };

export type WarmSandbox = Sandbox & {
	/** Stop every warm container and remove its files. */
	close(): Promise<void>;
};

/**
 * The serve's Sandbox: one warm container per image, started at its first
 * Run, holding one Run at a time. A Run has what a cold Run has: the same
 * flags (no network, the same limits), the same `/script`, `/inputs`
 * (read-only) and `/outputs`, and the same command. Between Runs the
 * supervisor kills every process a Run left and empties every place a Run
 * can write, and the Conductor empties `/script` and `/inputs`, so no Run
 * sees another's files. A container that stops is replaced at the next Run;
 * the Run it stopped under fails and says so.
 */
export const openWarmSandbox = (): WarmSandbox => {
	const slots = new Map<string, Slot>();
	let closed = false;

	const ready = async (image: string, slot: Slot) => {
		if (slot.container && !slot.container.isStopped()) return slot.container;
		if (slot.container) discard(slot.container);
		slot.container = undefined;
		if (!imageId(image)) return undefined;
		const container = start(image);
		const answer = await container.next();
		if (isStopped(answer) || !Ready.safeParse(answer).success) {
			await kill(container);
			discard(container);
			throw new Error(
				`the warm Sandbox for ${image} did not start (${JSON.stringify(answer)}): ${container.stderr()}`,
			);
		}
		slot.container = container;
		return container;
	};

	const send = (container: Container, request: object) =>
		container.child.stdin.write(`${JSON.stringify(request)}\n`);

	const workspace = (
		container: Container,
		scriptDir: string,
		release: () => void,
	): Workspace => ({
		inputs: container.inputs,
		outputs: container.outputs,
		execute: async ({ run_id, entrypoint, timeoutMs }): Promise<Exit> => {
			cpSync(scriptDir, container.script, { recursive: true });
			send(container, { run: entrypoint, timeout_ms: timeoutMs });
			const backstop = setTimeout(
				() => void kill(container),
				timeoutMs + GRACE_MS,
			);
			const answer = await container.next();
			clearTimeout(backstop);
			if (isStopped(answer)) {
				return {
					code: answer.code,
					stdout: Buffer.alloc(0),
					stderr: Buffer.alloc(0),
					notes: [
						`the warm Sandbox ${container.name} stopped during ${run_id} (docker exit ${answer.code}), so ${run_id} did not finish; the next Run starts a fresh one${container.stderr() ? `. Its last words: ${container.stderr().trim()}` : ""}`,
					],
				};
			}
			const finished = Finished.parse(answer);
			return {
				code: finished.exit_code,
				stdout: Buffer.from(finished.stdout, "base64"),
				stderr: Buffer.from(finished.stderr, "base64"),
				notes: finished.timed_out
					? [
							`${run_id} killed after the ${timeoutMs} ms time limit in the warm Sandbox ${container.name}; exit code ${TIME_LIMIT_EXIT_CODE}, the time-limit code`,
						]
					: [],
			};
		},
		release: async () => {
			try {
				if (!container.isStopped()) {
					send(container, { reset: true });
					const answer = await container.next();
					if (!isStopped(answer)) Reset.parse(answer);
				}
				if (container.isStopped()) {
					discard(container);
				} else {
					empty(container.script);
					empty(container.inputs);
				}
			} finally {
				release();
			}
		},
	});

	return {
		workspace: async (image, scriptDir) => {
			if (closed) throw new Error("the warm Sandbox is closed");
			const slot = slots.get(image) ?? { queue: Promise.resolve() };
			slots.set(image, slot);
			const turn = slot.queue;
			let release = () => {};
			slot.queue = new Promise<void>((resolve) => {
				release = resolve;
			});
			await turn;
			try {
				const container = await ready(image, slot);
				if (!container) {
					release();
					return undefined;
				}
				return workspace(container, scriptDir, release);
			} catch (error) {
				release();
				throw error;
			}
		},
		close: async () => {
			closed = true;
			await Promise.all(
				[...slots.values()].map(async (slot) => {
					await slot.queue;
					const container = slot.container;
					if (!container) return;
					container.child.stdin.end();
					const timer = setTimeout(() => void kill(container), 5_000);
					await container.stopped;
					clearTimeout(timer);
					discard(container);
				}),
			);
		},
	};
};
