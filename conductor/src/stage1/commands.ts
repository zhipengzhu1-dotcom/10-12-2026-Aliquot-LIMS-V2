import { readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	type CommandContext,
	type CommandTable,
	UsageError,
} from "../command.js";
import { AgentId } from "../ids.js";
import { openLedger } from "../ledger.js";
import {
	buildImage,
	defaultImageTag,
	imageId,
	scriptsRoot,
} from "../sandbox/image.js";
import {
	ensureOwner,
	ensureScript,
	runStage1,
	type Stage1Result,
} from "./tracer.js";

/** Relative paths mean relative to where the Operator typed the command. */
const fromInvocation = (path: string) =>
	resolve(process.env.INIT_CWD ?? process.cwd(), path);

const OPTIONS = {
	owner: { type: "string", default: "A-rin" },
	timeout: { type: "string", default: "60000" },
	"script-dir": { type: "string" },
} as const;

const OPTIONS_SYNOPSIS =
	"[--owner A-rin] [--timeout <ms>] [--script-dir <dir>]";

type Options = { owner: string; timeout: string; "script-dir"?: string };

const summary = (form: string, r: Stage1Result): string => {
	const lines = [
		`${form}: ${r.task_id} ${r.state.tag}`,
		`  fixture   ${r.fixture} (SubmissionForm)`,
		`  run       ${r.run.id} ${r.run.script.id} v${r.run.script.version}, exit ${r.run.exit_code}`,
		`  output    ${r.record ? `${r.record} submission.json` : "none"}`,
		`  eval      ${r.eval_id} score ${r.evaluation.score.toFixed(3)}, ${r.evaluation.passed ? "passed" : "failed"}`,
		...r.evaluation.findings.map((f) => `  finding   ${f}`),
	];
	return `${lines.join("\n")}\n`;
};

/**
 * Run stage 1 on each Submission Form under one Ledger lock: build the
 * Sandbox image if Docker lacks it, seed the Org if it is empty, and
 * register or revise `parse_submission` once. Returns how many Tasks ended
 * Done and how many did not.
 */
const runForms = async (
	forms: readonly string[],
	values: Options,
	ctx: CommandContext,
): Promise<{ done: number; failed: number }> => {
	const owner = AgentId.safeParse(values.owner);
	if (!owner.success) {
		throw new UsageError(
			`--owner ${values.owner} is not an Agent id (A-<slug>)`,
		);
	}
	const timeoutMs = Number(values.timeout);
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new UsageError(
			`--timeout ${values.timeout} is not a positive whole number of ms`,
		);
	}
	const source = values["script-dir"]
		? fromInvocation(values["script-dir"])
		: join(scriptsRoot, "parse_submission");

	const tag = defaultImageTag();
	const image =
		imageId(tag) ??
		(await buildImage({ tag, onOutput: (chunk) => ctx.stderr.write(chunk) }))
			.id;

	const ledger = openLedger({ home: ctx.home, writer: true });
	try {
		ensureOwner(ledger, owner.data);
		const script = ensureScript({
			ledger,
			home: ctx.home,
			source,
			owner: owner.data,
			image,
		});
		let done = 0;
		for (const form of forms) {
			const result = await runStage1({
				ledger,
				home: ctx.home,
				formPath: form,
				script: { id: script.id, version: script.version },
				owner: owner.data,
				timeoutMs,
			});
			ctx.stdout.write(summary(basename(form), result));
			if (result.state.tag === "Done") done++;
		}
		return { done, failed: forms.length - done };
	} finally {
		ledger.close();
	}
};

export const stage1Commands: CommandTable = {
	run: {
		args: `<submission form.docx> ${OPTIONS_SYNOPSIS}`,
		describe:
			"Store a Submission Form as a Fixture, run parse_submission on it for a new Task, evaluate the record, and complete or fail the Task",
		run: async (args, ctx) => {
			const { values, positionals } = parseArgs({
				args,
				allowPositionals: true,
				options: OPTIONS,
			});
			if (positionals.length !== 1) {
				throw new UsageError("stage1 run takes exactly one Submission Form");
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
			"Run stage 1 on every *.docx in a directory; exit 1 if any Task fails",
		run: async (args, ctx) => {
			const { values, positionals } = parseArgs({
				args,
				allowPositionals: true,
				options: OPTIONS,
			});
			if (positionals.length !== 1) {
				throw new UsageError("stage1 run-all takes exactly one directory");
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
