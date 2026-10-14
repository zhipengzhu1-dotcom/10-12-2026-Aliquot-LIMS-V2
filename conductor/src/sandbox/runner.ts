import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { constants, tmpdir } from "node:os";
import { dirname, extname, join, relative, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { ArtifactId, Seq, TaskId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import type { Actor } from "../types/actor.js";
import { ArtifactFilename, ArtifactType } from "../types/artifact.js";
import type { Run, ScriptRef } from "../types/script.js";
import { type ArtifactMeta, openArtifacts } from "./artifacts.js";
import {
	runDirs,
	SANDBOX_FLAGS,
	type Sandbox,
	scriptCommand,
	TIME_LIMIT_EXIT_CODE,
} from "./container.js";
import { imageId } from "./image.js";
import { finishRun, startRun } from "./lifecycle.js";
import { findScript, scriptDir } from "./scripts.js";

// The Conductor never loads Script code. A Run happens in a Sandbox
// container; the Script's directory only ever reaches it read-only.

/** Spawn `docker run`, and `docker kill` the container when time runs out. */
const runContainer = async (
	args: readonly string[],
	name: string,
	timeoutMs: number,
) => {
	const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

	let timedOut = false;
	let exited = false;
	const kill = async () => {
		timedOut = true;
		// The container may still be starting; retry until it is gone.
		for (let attempt = 0; attempt < 40 && !exited; attempt++) {
			const killed = await new Promise<boolean>((resolve) =>
				spawn("docker", ["kill", name], { stdio: "ignore" })
					.on("error", () => resolve(false))
					.on("close", (code) => resolve(code === 0)),
			);
			if (killed) return;
			await sleep(250);
		}
		if (!exited) child.kill("SIGKILL");
	};
	const timer = setTimeout(kill, timeoutMs);

	const code = await new Promise<number>((resolve) => {
		child.on("error", (error) => {
			stderr.push(
				Buffer.from(`[aliquot] could not start docker: ${error.message}\n`),
			);
			resolve(127);
		});
		child.on("close", (status, signal) => {
			resolve(status ?? 128 + (signal ? constants.signals[signal] : 0));
		});
	});
	exited = true;
	clearTimeout(timer);
	return {
		code: timedOut ? TIME_LIMIT_EXIT_CODE : code,
		timedOut,
		stdout: Buffer.concat(stdout),
		stderr: Buffer.concat(stderr),
	};
};

/**
 * The command line's Sandbox: every Run is a `docker run` of its own, in a
 * fresh temporary directory, with the Script's directory mounted read-only.
 */
const coldSandbox: Sandbox = {
	workspace: async (image, scriptDir) => {
		if (!imageId(image)) return undefined;
		const work = mkdtempSync(join(tmpdir(), "aliquot-run-"));
		const dirs = runDirs(work);
		return {
			...dirs,
			execute: async ({ run_id, entrypoint, timeoutMs }) => {
				const name = `aliquot-${run_id}-${randomUUID().slice(0, 8)}`;
				const exit = await runContainer(
					[
						"run",
						"--rm",
						"--name",
						name,
						...SANDBOX_FLAGS,
						"-v",
						`${scriptDir}:/script:ro`,
						"-v",
						`${dirs.inputs}:/inputs:ro`,
						"-v",
						`${dirs.outputs}:/outputs`,
						image,
						...scriptCommand(entrypoint),
					],
					name,
					timeoutMs,
				);
				return {
					code: exit.code,
					stdout: exit.stdout,
					stderr: exit.stderr,
					notes: exit.timedOut
						? [
								`${run_id} killed after the ${timeoutMs} ms time limit (docker kill ${name}); exit code ${TIME_LIMIT_EXIT_CODE}, the time-limit code`,
							]
						: [],
				};
			},
			release: async () => {
				// Best effort: on Linux a Script's subdirectories belong to uid 10001.
				try {
					rmSync(work, { recursive: true, force: true });
				} catch {}
			},
		};
	},
};

let sandbox: Sandbox = coldSandbox;

/**
 * Run every Script in `next` from now on, until the returned function puts
 * the previous Sandbox back. The command line keeps the cold Sandbox, a
 * container per Run; `aliquot serve` puts its warm Sandbox here, so every
 * Run the serve starts, by any path, is a warm Run.
 */
export const useSandbox = (next: Sandbox): (() => void) => {
	const previous = sandbox;
	sandbox = next;
	return () => {
		sandbox = previous;
	};
};

export type RunScriptOptions = {
	ledger: Ledger;
	home: string;
	script: ScriptRef;
	inputs: readonly ArtifactId[];
	actor: Actor;
	task_id?: TaskId | undefined;
	causation_id?: Seq | undefined;
	timeoutMs: number;
};

/** One entry of `/inputs/manifest.json`. */
export type InputManifestEntry = {
	artifact_id: ArtifactId;
	filename: string;
	artifact_type: ArtifactType;
	media_type: string;
};

/** `/outputs/manifest.json`, optional: types for the files a Script wrote. */
const OutputManifest = z.record(
	z.string(),
	z.strictObject({
		artifact_type: ArtifactType.optional(),
		media_type: z.string().min(1).optional(),
	}),
);

const MEDIA_TYPES: Readonly<Record<string, string>> = {
	".txt": "text/plain",
	".log": "text/plain",
	".md": "text/markdown",
	".csv": "text/csv",
	".json": "application/json",
	".xml": "application/xml",
	".html": "text/html",
	".pdf": "application/pdf",
	".docx":
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".sqlite": "application/vnd.sqlite3",
	".db": "application/vnd.sqlite3",
	".png": "image/png",
};

export const guessMediaType = (filename: string): string =>
	MEDIA_TYPES[extname(filename).toLowerCase()] ?? "application/octet-stream";

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

/** Every regular file under `dir`, as sorted relative POSIX paths. */
const listFiles = (dir: string, skipped: string[]): string[] =>
	readdirSync(dir, { recursive: true, withFileTypes: true })
		.flatMap((entry) => {
			const path = relative(dir, join(entry.parentPath, entry.name))
				.split(sep)
				.join("/");
			if (entry.isFile()) return [path];
			// A symlink could point anywhere on the Conductor's disk: never follow it.
			if (!entry.isDirectory()) skipped.push(`${path} (not a regular file)`);
			return [];
		})
		.sort();

/**
 * Run one Script version on input Artifacts in the Sandbox. The Sandbox
 * lifecycle records RunStarted, then ArtifactStored for stdout, stderr and
 * every file the Script left in `/outputs` (Lineage = the inputs, produced by
 * this Run; bytes the Ledger already holds get this Run's record as a further
 * production), then RunFinished. A Script killed at the time limit finishes
 * with exit code 124 and a closing line in its stderr Artifact saying so.
 */
export const runScript = async (options: RunScriptOptions): Promise<Run> => {
	const { ledger, home, actor, task_id } = options;
	const script = findScript(ledger.projections.scripts, options.script);
	if (!script) {
		throw new Error(
			`${options.script.id} v${options.script.version} is not registered`,
		);
	}
	const known = ledger.projections.artifacts.artifacts;
	const inputs = [...options.inputs];
	const lineage = unique(inputs);
	const staged = lineage.map((id) => {
		const artifact = known.get(id);
		if (!artifact) throw new Error(`input Artifact ${id} is not stored`);
		return artifact;
	});
	const ref: ScriptRef = { id: script.id, version: script.version };
	const image = `sha256:${script.image_digest}`;
	const workspace = await sandbox.workspace(image, scriptDir(home, script));
	if (!workspace) {
		throw new Error(
			`${script.id} v${script.version} needs image ${image}, which Docker does not have; rebuild it or revise the Script`,
		);
	}

	const artifacts = openArtifacts({ ledger, home });
	try {
		const { inputs: inputsDir, outputs: outputsDir } = workspace;
		const manifest: InputManifestEntry[] = staged.map((artifact) => {
			const filename = artifact.filename ?? artifact.id;
			const target = join(inputsDir, artifact.id, filename);
			mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
			copyFileSync(artifacts.path(artifact.id), target);
			chmodSync(target, 0o444);
			return {
				artifact_id: artifact.id,
				filename,
				artifact_type: artifact.artifact_type,
				media_type: artifact.media_type,
			};
		});
		writeFileSync(
			join(inputsDir, "manifest.json"),
			JSON.stringify(manifest, null, 2),
			{
				mode: 0o444,
			},
		);

		const { run_id: runId } = startRun(ledger, {
			actor,
			task_id,
			causation_id: options.causation_id,
			script: ref,
			inputs,
		});

		const startedAt = performance.now();
		const exit = await workspace.execute({
			run_id: runId,
			entrypoint: script.entrypoint,
			timeoutMs: options.timeoutMs,
		});
		const duration_ms = Math.round(performance.now() - startedAt);

		const notes = [...exit.notes];
		const files = listFiles(outputsDir, notes);
		let declared: z.infer<typeof OutputManifest> = {};
		if (files.includes("manifest.json")) {
			try {
				declared = OutputManifest.parse(
					JSON.parse(readFileSync(join(outputsDir, "manifest.json"), "utf8")),
				);
			} catch (error) {
				notes.push(
					`ignored /outputs/manifest.json: ${(error as Error).message}`,
				);
			}
		}

		const by = { actor };
		const produced: Omit<ArtifactMeta, "artifact_type" | "media_type"> = {
			produced_by: { tag: "Run", id: runId },
			lineage,
		};
		const outputs: ArtifactId[] = [];
		for (const filename of files) {
			if (filename === "manifest.json") continue;
			if (!ArtifactFilename.safeParse(filename).success) {
				notes.push(`skipped /outputs/${filename}: not a usable filename`);
				continue;
			}
			let bytes: Buffer;
			try {
				bytes = readFileSync(join(outputsDir, filename));
			} catch (error) {
				notes.push(`skipped /outputs/${filename}: ${(error as Error).message}`);
				continue;
			}
			const { artifact: stored } = artifacts.store(
				bytes,
				{
					...produced,
					artifact_type: declared[filename]?.artifact_type ?? "Other",
					media_type:
						declared[filename]?.media_type ?? guessMediaType(filename),
					filename,
				},
				by,
			);
			outputs.push(stored.id);
		}

		const log = (bytes: Buffer, filename: string) =>
			artifacts.store(
				bytes,
				{
					...produced,
					artifact_type: "Other",
					media_type: "text/plain",
					filename,
				},
				by,
			).artifact.id;
		const stderr = Buffer.concat([
			exit.stderr,
			Buffer.from(notes.map((note) => `[aliquot] ${note}\n`).join("")),
		]);
		const run: Run = {
			id: runId,
			script: ref,
			inputs,
			outputs: unique(outputs),
			exit_code: exit.code,
			stdout_ref: log(exit.stdout, "stdout.txt"),
			stderr_ref: log(stderr, "stderr.txt"),
			duration_ms,
		};
		return finishRun(ledger, { actor, run }).run;
	} finally {
		await workspace.release();
	}
};
