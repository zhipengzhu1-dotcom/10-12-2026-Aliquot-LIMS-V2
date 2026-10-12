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
import {
	type ArtifactId,
	nextId,
	RunId,
	type Seq,
	type TaskId,
} from "../ids.js";
import type { Ledger } from "../ledger.js";
import type { Actor } from "../types/actor.js";
import { ArtifactFilename, ArtifactType } from "../types/artifact.js";
import type { Run, ScriptRef } from "../types/script.js";
import {
	type ArtifactMeta,
	openArtifacts,
	projectArtifacts,
} from "./artifacts.js";
import { imageId } from "./image.js";
import { projectRuns } from "./runs.js";
import { findScript, projectScripts, scriptDir } from "./scripts.js";

// The Conductor never loads Script code. A Run is one `docker run` child
// process; the Script's directory only ever reaches the container as a
// read-only bind mount.

/** The container's limits (ADR-0003). */
const SANDBOX_FLAGS = [
	"--rm",
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

/** Exit code of a container stopped by `docker kill` (128 + SIGKILL). */
export const KILLED_EXIT_CODE = 137;

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

type Exit = { code: number; timedOut: boolean; stdout: Buffer; stderr: Buffer };

/** Spawn `docker run`, and `docker kill` the container when time runs out. */
const runContainer = async (
	args: readonly string[],
	name: string,
	timeoutMs: number,
): Promise<Exit> => {
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
		code: timedOut ? KILLED_EXIT_CODE : code,
		timedOut,
		stdout: Buffer.concat(stdout),
		stderr: Buffer.concat(stderr),
	};
};

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
 * Run one Script version on input Artifacts in the Sandbox. Appends
 * RunStarted, then ArtifactStored for stdout, stderr and every file the
 * Script left in `/outputs` (Lineage = the inputs, produced by this Run; bytes
 * the Ledger already holds get this Run's record as a further production),
 * then RunFinished. A Script killed at the time limit finishes with exit code
 * 137 and a closing line in its stderr Artifact saying so.
 */
export const runScript = async (options: RunScriptOptions): Promise<Run> => {
	const { ledger, home, actor, task_id } = options;
	const script = findScript(projectScripts(ledger), options.script);
	if (!script) {
		throw new Error(
			`${options.script.id} v${options.script.version} is not registered`,
		);
	}
	const known = projectArtifacts(ledger).artifacts;
	const inputs = [...options.inputs];
	const lineage = unique(inputs);
	const staged = lineage.map((id) => {
		const artifact = known.get(id);
		if (!artifact) throw new Error(`input Artifact ${id} is not stored`);
		return artifact;
	});
	const ref: ScriptRef = { id: script.id, version: script.version };
	const image = `sha256:${script.image_digest}`;
	if (!imageId(image)) {
		throw new Error(
			`${script.id} v${script.version} needs image ${image}, which Docker does not have; rebuild it or revise the Script`,
		);
	}

	const artifacts = openArtifacts({ ledger, home });
	const runId = RunId.parse(nextId("R", projectRuns(ledger).runs.keys()));
	const work = mkdtempSync(join(tmpdir(), "aliquot-run-"));
	try {
		const inputsDir = join(work, "inputs");
		const outputsDir = join(work, "outputs");
		mkdirSync(inputsDir, { mode: 0o755 });
		mkdirSync(outputsDir);
		// The container runs as uid 10001; it must be able to write here.
		chmodSync(outputsDir, 0o777);
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

		const started = ledger.append({
			actor,
			task_id,
			causation_id: options.causation_id,
			kind: "RunStarted",
			payload: { run_id: runId, script: ref, inputs },
		});

		const name = `aliquot-${runId}-${randomUUID().slice(0, 8)}`;
		const startedAt = performance.now();
		const exit = await runContainer(
			[
				"run",
				"--name",
				name,
				...SANDBOX_FLAGS,
				"-v",
				`${scriptDir(home, script)}:/script:ro`,
				"-v",
				`${inputsDir}:/inputs:ro`,
				"-v",
				`${outputsDir}:/outputs`,
				image,
				"python",
				`/script/${script.entrypoint}`,
				"--inputs",
				"/inputs",
				"--outputs",
				"/outputs",
			],
			name,
			options.timeoutMs,
		);
		const duration_ms = Math.round(performance.now() - startedAt);

		const notes: string[] = [];
		if (exit.timedOut) {
			notes.push(
				`${runId} killed after the ${options.timeoutMs} ms time limit (docker kill ${name}); exit code ${KILLED_EXIT_CODE}`,
			);
		}
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

		const by = { actor, task_id, causation_id: started.seq };
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
			const stored = artifacts.store(
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
			).id;
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
		const finished = ledger.append({
			...by,
			kind: "RunFinished",
			payload: run,
		});
		if (finished.kind !== "RunFinished") throw new Error("unreachable");
		return finished.payload;
	} finally {
		// Best effort: on Linux a Script's subdirectories belong to uid 10001.
		try {
			rmSync(work, { recursive: true, force: true });
		} catch {}
	}
};
