import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import {
	fromInvocation,
	parseOrUsage,
	parseTimeout,
	withLedger,
} from "../cli-support.js";
import { type CommandTable, UsageError } from "../command.js";
import { AgentId, ArtifactId, ScriptId, TaskId } from "../ids.js";
import { ArtifactType } from "../types/artifact.js";
import { openArtifacts } from "./artifacts.js";
import { buildImage, defaultImageTag, imageId, scriptsRoot } from "./image.js";
import { guessMediaType, runScript } from "./runner.js";
import { registerScript } from "./scripts.js";

const operator = { tag: "Operator" } as const;

const artifactTypes = (values: readonly string[] | undefined) =>
	(values ?? [])
		.flatMap((v) => v.split(","))
		.filter(Boolean)
		.map((v) =>
			parseOrUsage(
				ArtifactType,
				v,
				`an Artifact type must be one of ${ArtifactType.options.join(", ")}`,
			),
		);

export const sandboxCommands: CommandTable = {
	build: {
		args: "[--tag <tag>]",
		describe: "docker build sandbox/Dockerfile and print the image id",
		run: async (args, ctx) => {
			const { values } = parseArgs({
				args,
				options: { tag: { type: "string" } },
			});
			const image = await buildImage({
				tag: values.tag ?? defaultImageTag(),
				onOutput: (chunk) => ctx.stderr.write(chunk),
			});
			ctx.stdout.write(`sha256:${image.id} ${image.tag}\n`);
			return 0;
		},
	},
	register: {
		args: "--name <name> --owner <A-id> [--script-dir <dir>] [--input-types <T,...>] [--output-types <T,...>] [--entrypoint main.py] [--image <ref>]",
		describe:
			"Register a Script version (ScriptRegistered, or ScriptRevised for a known name) on the built image",
		run: async (args, ctx) => {
			const { values } = parseArgs({
				args,
				options: {
					name: { type: "string" },
					owner: { type: "string" },
					"script-dir": { type: "string" },
					"input-types": { type: "string", multiple: true },
					"output-types": { type: "string", multiple: true },
					entrypoint: { type: "string" },
					image: { type: "string" },
				},
			});
			if (!values.name || !values.owner) {
				throw new UsageError("sandbox register needs --name and --owner");
			}
			const image = values.image ?? defaultImageTag();
			const digest = imageId(image);
			if (!digest) {
				throw new Error(
					`Docker has no image ${image}; run \`aliquot sandbox build\` or pass --image`,
				);
			}
			const script = withLedger(ctx.home, true, (ledger) =>
				registerScript({
					ledger,
					home: ctx.home,
					actor: operator,
					name: values.name as string,
					scriptDir: values["script-dir"]
						? fromInvocation(values["script-dir"])
						: join(scriptsRoot, values.name as string),
					owner_agent: parseOrUsage(
						AgentId,
						values.owner,
						"--owner must be an Agent id like A-odile",
					),
					input_types: artifactTypes(values["input-types"]),
					output_types: artifactTypes(values["output-types"]),
					...(values.entrypoint ? { entrypoint: values.entrypoint } : {}),
					image_digest: digest,
				}),
			);
			ctx.stdout.write(`${JSON.stringify(script)}\n`);
			return 0;
		},
	},
	store: {
		args: "<file> [--type <ArtifactType>] [--media-type <type>]",
		describe:
			"Store a file as an Operator Artifact with no Lineage and print its id",
		run: async (args, ctx) => {
			const { values, positionals } = parseArgs({
				args,
				allowPositionals: true,
				options: {
					type: { type: "string" },
					"media-type": { type: "string" },
				},
			});
			if (positionals.length !== 1) {
				throw new UsageError("sandbox store takes exactly one file");
			}
			const path = fromInvocation(positionals[0] as string);
			const filename = basename(path);
			const [artifact_type = "Other"] = artifactTypes(
				values.type ? [values.type] : [],
			);
			const bytes = readFileSync(path);
			const { artifact } = withLedger(ctx.home, true, (ledger) =>
				openArtifacts({ ledger, home: ctx.home }).store(
					bytes,
					{
						artifact_type,
						media_type: values["media-type"] ?? guessMediaType(filename),
						produced_by: operator,
						lineage: [],
						filename,
					},
					{ actor: operator },
				),
			);
			ctx.stdout.write(`${artifact.id}\n`);
			return 0;
		},
	},
	run: {
		args: "<script name> [--input <artifact id>]... [--version <n>] [--task T-n] [--timeout <ms>]",
		describe:
			"Run a Script in the Sandbox on input Artifacts and print the Run as JSON",
		run: async (args, ctx) => {
			const { values, positionals } = parseArgs({
				args,
				allowPositionals: true,
				options: {
					input: { type: "string", multiple: true },
					version: { type: "string" },
					task: { type: "string" },
					timeout: { type: "string", default: "60000" },
				},
			});
			if (positionals.length !== 1) {
				throw new UsageError("sandbox run takes exactly one Script name");
			}
			const id = parseOrUsage(
				ScriptId,
				`S-${positionals[0]}`,
				"the Script id must be S- then lowercase letters, digits, _ or -",
			);
			const timeoutMs = parseTimeout(values.timeout);
			const inputs = (values.input ?? []).map((v) =>
				parseOrUsage(ArtifactId, v, "--input must be an Artifact id (64 hex)"),
			);
			const task_id = values.task
				? parseOrUsage(TaskId, values.task, "--task must look like T-1")
				: undefined;
			const run = await withLedger(ctx.home, true, (ledger) => {
				const versions = ledger.projections.scripts.scripts.get(id);
				const version = values.version
					? Number(values.version)
					: versions?.at(-1)?.version;
				if (version === undefined) throw new Error(`${id} is not registered`);
				return runScript({
					ledger,
					home: ctx.home,
					script: { id, version },
					inputs,
					actor: operator,
					task_id,
					timeoutMs,
				});
			});
			ctx.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
			return run.exit_code === 0 ? 0 : 1;
		},
	},
	runs: {
		describe: "List Runs with their Script version, exit code and outputs",
		run: async (args, ctx) => {
			parseArgs({ args });
			const runs = withLedger(
				ctx.home,
				false,
				(ledger) => ledger.projections.runs.runs,
			);
			for (const [id, { started, finished }] of runs) {
				const script = `${started.script.id} v${started.script.version}`;
				const status = finished
					? `exit ${finished.run.exit_code}, ${finished.run.duration_ms} ms, ${finished.run.outputs.length} outputs`
					: "no RunFinished";
				ctx.stdout.write(
					`${id}  ${script}  ${status}  inputs: ${started.inputs.join(", ") || "none"}\n`,
				);
			}
			return 0;
		},
	},
	artifacts: {
		describe:
			"List Artifacts with their type and every production (producer and Lineage)",
		run: async (args, ctx) => {
			parseArgs({ args });
			const { artifacts, productions } = withLedger(
				ctx.home,
				false,
				(ledger) => ledger.projections.artifacts,
			);
			for (const a of artifacts.values()) {
				const records = (productions.get(a.id) ?? []).map(({ record }) => {
					const producer =
						record.produced_by.tag === "Run"
							? `Run ${record.produced_by.id}`
							: "Operator";
					return `  produced by ${producer}; lineage: ${record.lineage.join(", ") || "none"}`;
				});
				ctx.stdout.write(
					[
						a.id,
						`  type ${a.artifact_type}, ${a.media_type}${a.filename ? `, ${a.filename}` : ""}`,
						...records,
						"",
					].join("\n"),
				);
			}
			return 0;
		},
	},
	cat: {
		args: "<artifact id>",
		describe: "Write an Artifact's bytes to stdout",
		run: async (args, ctx) => {
			const { positionals } = parseArgs({ args, allowPositionals: true });
			if (positionals.length !== 1) {
				throw new UsageError("sandbox cat takes exactly one Artifact id");
			}
			const id = parseOrUsage(
				ArtifactId,
				positionals[0],
				"sandbox cat takes an Artifact id (64 hex)",
			);
			const bytes = withLedger(ctx.home, false, (ledger) => {
				if (!ledger.projections.artifacts.artifacts.has(id)) {
					throw new Error(`Artifact ${id} is not stored`);
				}
				return openArtifacts({ ledger, home: ctx.home }).read(id);
			});
			ctx.stdout.write(bytes);
			return 0;
		},
	},
};
