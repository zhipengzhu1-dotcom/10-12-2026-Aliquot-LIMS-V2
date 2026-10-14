import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
	fromInvocation,
	parseTimeout,
	personOf,
	withLedger,
} from "../cli-support.js";
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
 * A Fixture the workflow is known not to finish yet, from
 * `<fixture stem>.known-gap.json` beside it: the stage that stops it, the
 * issue that will close the gap, and why.
 */
const KnownGap = z.object({
	stage: z.number().int().min(1),
	issue: z.number().int().min(1),
	reason: z.string().min(1),
});
type KnownGap = z.infer<typeof KnownGap>;

type Fixture = { readonly path: string; readonly gap?: KnownGap };

const gapFileOf = (form: string): string =>
	join(dirname(form), `${basename(form, extname(form))}.known-gap.json`);

const fixtureAt = (path: string): Fixture => {
	const gapFile = gapFileOf(path);
	if (!existsSync(gapFile)) return { path };
	return {
		path,
		gap: KnownGap.parse(JSON.parse(readFileSync(gapFile, "utf8"))),
	};
};

type Outcome =
	| { readonly tag: "Done" }
	| { readonly tag: "KnownGap"; readonly gap: KnownGap }
	| { readonly tag: "Failed"; readonly why?: string };

/**
 * Done when every stage's Task is Done. A known gap holds only while the run
 * stops at exactly its stage: stopping elsewhere fails, and so does finishing,
 * so a closed gap cannot stay listed.
 */
const outcomeOf = (
	fixture: Fixture,
	run: WorkflowRun,
	planned: number,
): Outcome => {
	const last = run.stages.at(-1);
	const finished =
		run.stages.length === planned &&
		run.stages.every((r) => r.state.tag === "Done");
	const { gap } = fixture;
	if (gap === undefined || gap.stage > planned) {
		return finished ? { tag: "Done" } : { tag: "Failed" };
	}
	if (finished) {
		return {
			tag: "Failed",
			why: `the known gap at stage ${gap.stage} (#${gap.issue}) is closed: delete ${gapFileOf(fixture.path)}`,
		};
	}
	if (last?.stage.number !== gap.stage) {
		return {
			tag: "Failed",
			why: `stopped at stage ${last?.stage.number ?? "none"}, not at the known gap's stage ${gap.stage} (#${gap.issue})`,
		};
	}
	return { tag: "KnownGap", gap };
};

const outcomeLine = (o: Outcome): string => {
	switch (o.tag) {
		case "Done":
			return "";
		case "KnownGap":
			return `  known gap stage ${o.gap.stage}, #${o.gap.issue}: ${o.gap.reason}\n`;
		case "Failed":
			return o.why ? `  failed    ${o.why}\n` : "";
	}
};

type Tally = { done: number; gaps: number; failed: number };

/**
 * Run the workflow on each Submission Form under one Ledger lock: build the
 * Sandbox image if Docker lacks it, seed the Org if it is empty, and
 * register or revise each stage's Script once. Returns how many Fixtures
 * ended with every stage's Task Done, how many stopped at their known gap,
 * and how many failed.
 */
const runForms = async (
	fixtures: readonly Fixture[],
	values: Options,
	ctx: CommandContext,
	label: (path: string) => string = basename,
): Promise<Tally> => {
	const stages = stagesTo(values.to);
	const timeoutMs = parseTimeout(values.timeout);
	const operator = personOf(ctx);

	const tag = defaultImageTag();
	const image =
		imageId(tag) ??
		(await buildImage({ tag, onOutput: (chunk) => ctx.stderr.write(chunk) }))
			.id;

	return withLedger(ctx.home, true, async (ledger) => {
		ensureRoster(ledger, stages, operator);
		const plan = stages.map((stage) => {
			const script = ensureScript({
				ledger,
				home: ctx.home,
				stage,
				source: join(scriptsRoot, stage.script),
				image,
				operator,
			});
			return { stage, script: { id: script.id, version: script.version } };
		});
		const tally: Tally = { done: 0, gaps: 0, failed: 0 };
		for (const fixture of fixtures) {
			const result = await runWorkflow({
				ledger,
				home: ctx.home,
				formPath: fixture.path,
				plan,
				timeoutMs,
				operator,
			});
			const outcome = outcomeOf(fixture, result, plan.length);
			ctx.stdout.write(summary(label(fixture.path), result));
			ctx.stdout.write(outcomeLine(outcome));
			if (outcome.tag === "Done") tally.done++;
			else if (outcome.tag === "KnownGap") tally.gaps++;
			else tally.failed++;
		}
		return tally;
	});
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The Submission Forms under a directory, its own before its subdirectories',
 * each in name order, and every other Office file there, which no stage
 * starts from.
 */
const fixturesUnder = (
	dir: string,
): { forms: readonly string[]; others: readonly string[] } => {
	const files = (readdirSync(dir, { recursive: true }) as string[])
		.map((rel) => rel.split(sep).join("/"))
		.sort(
			(a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1),
		);
	const ofType = (ext: string) =>
		files.filter((rel) => rel.toLowerCase().endsWith(ext));
	return { forms: ofType(".docx"), others: ofType(".xlsx") };
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
				[{ path: fromInvocation(positionals[0] as string) }],
				values,
				ctx,
			);
			return failed === 0 ? 0 : 1;
		},
	},
	"run-all": {
		args: `<fixtures dir> ${OPTIONS_SYNOPSIS}`,
		describe:
			"Run the workflow on every *.docx under a directory; exit 1 if a Fixture fails, other than at its known gap",
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
			const { forms, others } = fixturesUnder(dir);
			if (forms.length === 0)
				throw new Error(`${dir} holds no *.docx Fixtures`);
			for (const rel of others) {
				ctx.stdout.write(
					`${rel}\n  skipped   no stage starts from a workbook; run-all starts from a Submission Form\n`,
				);
			}
			const { done, gaps, failed } = await runForms(
				forms.map((rel) => fixtureAt(join(dir, rel))),
				values,
				ctx,
				(path) => relative(dir, path).split(sep).join("/"),
			);
			const known = gaps === 0 ? "" : `, ${plural(gaps, "known gap")}`;
			const skipped =
				others.length === 0
					? ""
					: `; ${plural(others.length, "workbook")} skipped`;
			ctx.stdout.write(
				`${plural(forms.length, "Fixture")}: ${done} Done${known}, ${failed} Failed${skipped}\n`,
			);
			return failed === 0 ? 0 : 1;
		},
	},
};
