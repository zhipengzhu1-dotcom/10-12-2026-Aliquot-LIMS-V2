import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { fromInvocation, parseTimeout, withLedger } from "../cli-support.js";
import {
	type CommandContext,
	type CommandTable,
	UsageError,
} from "../command.js";
import {
	buildImage,
	defaultImageTag,
	imageId,
	scriptsRoot,
} from "../sandbox/image.js";
import { STAGES, type Stage } from "./stages.js";
import {
	ensureRoster,
	ensureScript,
	runWorkflow,
	type WorkflowRun,
} from "./tracer.js";

const OPTIONS = {
	to: { type: "string" },
	timeout: { type: "string", default: "60000" },
} as const;

const OPTIONS_SYNOPSIS = "[--to <stage number>] [--timeout <ms>]";

type Options = { to?: string | undefined; timeout: string };

const listed = (types: readonly string[]) => types.join(",") || "none";

/** The stages up to `--to`, every stage without it. */
const stagesTo = (to: string | undefined): readonly Stage[] => {
	if (to === undefined) return STAGES;
	const last = Number(to);
	if (!/^\d+$/.test(to) || last < 1 || last > STAGES.length) {
		throw new UsageError(
			`--to ${to} is not a stage number from 1 to ${STAGES.length}`,
		);
	}
	return STAGES.slice(0, last);
};

const summary = (form: string, w: WorkflowRun): string => {
	const lines = [
		form,
		`  fixture   ${w.fixture} (SubmissionForm)`,
		...w.stages.flatMap((r) => [
			`  stage ${r.stage.number} ${r.stage.name}: ${r.task_id} ${r.state.tag}`,
			`    run       ${r.run.id} ${r.run.script.id} v${r.run.script.version}, exit ${r.run.exit_code}`,
			...(r.outputs.length === 0
				? ["    output    none"]
				: r.outputs.map(
						(o) =>
							`    output    ${o.id} ${o.artifact_type}${o.filename ? ` ${o.filename}` : ""}`,
					)),
			`    eval      ${r.eval_id} score ${r.evaluation.score.toFixed(3)}, ${r.evaluation.passed ? "passed" : "failed"}`,
			...r.evaluation.findings.map((f) => `    finding   ${f}`),
			...r.revisions.map(
				(d) =>
					`    revised   ${d.id} to version ${d.version}: ${d.revision_reason}`,
			),
		]),
	];
	return `${lines.join("\n")}\n`;
};

/**
 * Run the workflow on each Submission Form under one Ledger lock: build the
 * Sandbox image if Docker lacks it, seed the Org if it is empty, and
 * register or revise each stage's Script once. Returns how many Fixtures
 * ended with every stage's Task Done and how many did not.
 */
const runForms = async (
	forms: readonly string[],
	values: Options,
	ctx: CommandContext,
): Promise<{ done: number; failed: number }> => {
	const stages = stagesTo(values.to);
	const timeoutMs = parseTimeout(values.timeout);

	const tag = defaultImageTag();
	const image =
		imageId(tag) ??
		(await buildImage({ tag, onOutput: (chunk) => ctx.stderr.write(chunk) }))
			.id;

	return withLedger(ctx.home, true, async (ledger) => {
		ensureRoster(ledger, stages);
		const plan = stages.map((stage) => {
			const script = ensureScript({
				ledger,
				home: ctx.home,
				stage,
				source: join(scriptsRoot, stage.script),
				image,
			});
			return { stage, script: { id: script.id, version: script.version } };
		});
		let done = 0;
		for (const form of forms) {
			const result = await runWorkflow({
				ledger,
				home: ctx.home,
				formPath: form,
				plan,
				timeoutMs,
			});
			ctx.stdout.write(summary(basename(form), result));
			if (
				result.stages.length === plan.length &&
				result.stages.every((r) => r.state.tag === "Done")
			) {
				done++;
			}
		}
		return { done, failed: forms.length - done };
	});
};

export const workflowCommands: CommandTable = {
	stages: {
		describe:
			"List the toy workflow's stages: Script, input, carried and output Artifact types, and who works and reviews each",
		run: async (args, ctx) => {
			parseArgs({ args });
			for (const s of STAGES) {
				ctx.stdout.write(
					`${s.number} ${s.name}  script ${s.script}  inputs ${listed(s.inputs)}  carried ${listed(s.carried)}  outputs ${listed(s.outputs)}  worked by ${s.worked_by}  reviewed by ${s.reviewed_by}\n`,
				);
			}
			return 0;
		},
	},
	run: {
		args: `<submission form.docx> ${OPTIONS_SYNOPSIS}`,
		describe:
			"Store a Submission Form as a Fixture and run each stage on it as a Task, up to --to; exit 1 if a Task fails",
		run: async (args, ctx) => {
			const { values, positionals } = parseArgs({
				args,
				allowPositionals: true,
				options: OPTIONS,
			});
			if (positionals.length !== 1) {
				throw new UsageError("workflow run takes exactly one Submission Form");
			}
			const { failed } = await runForms(
				[fromInvocation(positionals[0] as string)],
				values,
				ctx,
			);
			return failed === 0 ? 0 : 1;
		},
	},
	"run-all": {
		args: `<fixtures dir> ${OPTIONS_SYNOPSIS}`,
		describe:
			"Run the workflow on every *.docx in a directory; exit 1 if any Task fails",
		run: async (args, ctx) => {
			const { values, positionals } = parseArgs({
				args,
				allowPositionals: true,
				options: OPTIONS,
			});
			if (positionals.length !== 1) {
				throw new UsageError("workflow run-all takes exactly one directory");
			}
			const dir = fromInvocation(positionals[0] as string);
			const forms = readdirSync(dir)
				.filter((name) => name.toLowerCase().endsWith(".docx"))
				.sort()
				.map((name) => join(dir, name));
			if (forms.length === 0)
				throw new Error(`${dir} holds no *.docx Fixtures`);
			const { done, failed } = await runForms(forms, values, ctx);
			ctx.stdout.write(
				`${forms.length} Fixture${forms.length === 1 ? "" : "s"}: ${done} Done, ${failed} Failed\n`,
			);
			return failed === 0 ? 0 : 1;
		},
	},
};
