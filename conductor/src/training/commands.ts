import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
	actorText,
	fromInvocation,
	parseActor,
	parseOrUsage,
	readAll,
	withLedger,
} from "../cli-support.js";
import {
	type CommandContext,
	type CommandTable,
	UsageError,
} from "../command.js";
import { AgentId, SkillId, TaskId } from "../ids.js";
import { Refusal } from "../reduce.js";
import type { MemoryNote } from "../types/skill.js";
import { giveCoaching, publishSkill, recordMemoryNote } from "./lifecycle.js";
import {
	type Coaching,
	type Sequenced,
	skillVersion,
	TrainingProjection,
	type TrainingState,
} from "./projection.js";

const asOption = { as: { type: "string" } } as const;

const VersionText = z
	.string()
	.regex(/^\d+$/)
	.transform(Number)
	.pipe(z.number().int().positive());

const agentOf = (command: string, positionals: string[]): AgentId => {
	const what = `training ${command} takes one Agent id like A-odile`;
	const [text, ...extra] = positionals;
	if (text === undefined || extra.length > 0) throw new UsageError(what);
	return parseOrUsage(AgentId, text, what);
};

const skillIdOf = (command: string, positionals: string[]): SkillId => {
	const what = `training skill ${command} takes one Skill id`;
	const [text, ...extra] = positionals;
	if (text === undefined || extra.length > 0) throw new UsageError(what);
	return parseOrUsage(SkillId, text, what);
};

const taskIdOf = (text: string) =>
	parseOrUsage(TaskId, text, "--task must look like T-1");

/** The whole of stdin without its final newline, refused when empty. */
const stdinText = async (ctx: CommandContext, what: string) => {
	const text = (await readAll(ctx.stdin)).replace(/\n$/, "");
	if (text === "") throw new UsageError(`${what} is stdin and is empty`);
	return text;
};

const readTraining = (home: string): TrainingState =>
	existsSync(join(home, "ledger.sqlite"))
		? withLedger(home, false, (ledger) => ledger.projections.training)
		: TrainingProjection.init;

const noteLine = (note: Sequenced<MemoryNote>) =>
	`${note.seq}  Memory note on ${note.task_id} (applies to ${note.applies_to.join(", ")}): ${note.lesson}`;

const coachingLine = (coaching: Coaching) =>
	`${coaching.seq}  Coaching${coaching.task_id === undefined ? "" : ` on ${coaching.task_id}`}: ${coaching.note}`;

const publish = async (args: string[], ctx: CommandContext) => {
	const { values, positionals } = parseArgs({
		args,
		options: { title: { type: "string" }, ...asOption },
		allowPositionals: true,
	});
	const [idText, file, ...extra] = positionals;
	if (idText === undefined || extra.length > 0) {
		throw new UsageError(
			"training skill publish takes one Skill id and at most one file",
		);
	}
	const id = parseOrUsage(SkillId, idText, "the Skill id must not be empty");
	const title = values.title;
	if (title === undefined || title === "") {
		throw new UsageError("--title is required");
	}
	const actor = parseActor(values.as);
	const body_md =
		file === undefined || file === "-"
			? await readAll(ctx.stdin)
			: readFileSync(fromInvocation(file), "utf8");
	const { skill, seq } = withLedger(ctx.home, true, (ledger) =>
		publishSkill(ledger, { actor, id, title, body_md }),
	);
	ctx.stdout.write(
		`${seq}  Published ${skill.id} version ${skill.version}: ${skill.title}\n`,
	);
	return 0;
};

const show = async (args: string[], ctx: CommandContext) => {
	const { values, positionals } = parseArgs({
		args,
		options: { version: { type: "string" } },
		allowPositionals: true,
	});
	const id = skillIdOf("show", positionals);
	const version =
		values.version === undefined
			? undefined
			: parseOrUsage(
					VersionText,
					values.version,
					"--version must be a positive whole number",
				);
	const skill = skillVersion(readTraining(ctx.home), id, version);
	if (skill instanceof Refusal) {
		ctx.stderr.write(`${skill.reason}\n`);
		return 1;
	}
	ctx.stdout.write(
		`${skill.id} version ${skill.version}: ${skill.title}\nby ${actorText(skill.author)} at seq ${skill.seq}\n\n${skill.body_md.replace(/\n?$/, "\n")}`,
	);
	return 0;
};

const SKILL_COMMANDS: Readonly<
	Record<string, (args: string[], ctx: CommandContext) => Promise<number>>
> = { publish, show };

export const trainingCommands: CommandTable = {
	note: {
		args: "<agent id> --task <task id> --applies-to <a,b>",
		describe:
			"Note a Memory note as the Agent, on a Task it has been assigned; the Memory note is stdin",
		run: async (args, ctx) => {
			const { values, positionals } = parseArgs({
				args,
				options: {
					task: { type: "string" },
					"applies-to": { type: "string" },
				},
				allowPositionals: true,
			});
			const agent = agentOf("note", positionals);
			if (values.task === undefined) {
				throw new UsageError("--task is required");
			}
			const task_id = taskIdOf(values.task);
			const appliesTo = values["applies-to"];
			if (appliesTo === undefined) {
				throw new UsageError("--applies-to is required");
			}
			const applies_to = appliesTo
				.split(",")
				.map((what) => what.trim())
				.filter((what) => what !== "");
			const lesson = await stdinText(ctx, "the Memory note");
			const { seq } = withLedger(ctx.home, true, (ledger) =>
				recordMemoryNote(ledger, {
					actor: { tag: "Agent", id: agent },
					agent,
					task_id,
					lesson,
					applies_to,
				}),
			);
			ctx.stdout.write(`${seq}  ${agent} noted a Memory note on ${task_id}\n`);
			return 0;
		},
	},
	notes: {
		args: "<agent id>",
		describe: "Print an Agent's Memory notes and Coaching in seq order",
		run: async (args, ctx) => {
			const { positionals } = parseArgs({ args, allowPositionals: true });
			const agent = agentOf("notes", positionals);
			const training = readTraining(ctx.home);
			const lines = [
				...(training.notes.get(agent) ?? []).map((n) => ({
					seq: n.seq,
					line: noteLine(n),
				})),
				...(training.coaching.get(agent) ?? []).map((c) => ({
					seq: c.seq,
					line: coachingLine(c),
				})),
			]
				.sort((a, b) => a.seq - b.seq)
				.map(({ line }) => line);
			ctx.stdout.write(
				lines.length === 0
					? `No Memory notes or Coaching for ${agent}\n`
					: `${lines.join("\n")}\n`,
			);
			return 0;
		},
	},
	coach: {
		args: "<agent id> [--task <task id>]",
		describe:
			"Give an Agent Coaching as the Operator, on a Task when one is named; the Coaching is stdin",
		run: async (args, ctx) => {
			const { values, positionals } = parseArgs({
				args,
				options: { task: { type: "string" }, ...asOption },
				allowPositionals: true,
			});
			const agent_id = agentOf("coach", positionals);
			const task_id =
				values.task === undefined ? undefined : taskIdOf(values.task);
			const actor = parseActor(values.as);
			const note = await stdinText(ctx, "the Coaching");
			const { seq } = withLedger(ctx.home, true, (ledger) =>
				giveCoaching(ledger, { actor, agent_id, task_id, note }),
			);
			ctx.stdout.write(`${seq}  Coaching for ${agent_id}\n`);
			return 0;
		},
	},
	skill: {
		args: "publish <skill id> --title <t> [file] [--as <agent>] | show <skill id> [--version <n>]",
		describe:
			"Publish the next version of a Skill, the body from the file or stdin, or print the latest or named version",
		run: async ([verb, ...args], ctx) => {
			const run = verb === undefined ? undefined : SKILL_COMMANDS[verb];
			if (run === undefined) {
				throw new UsageError("training skill takes publish or show");
			}
			return run(args, ctx);
		},
	},
	skills: {
		describe: "List every Skill at its latest version",
		run: async (args, ctx) => {
			parseArgs({ args });
			const skills = [...readTraining(ctx.home).skills.values()].flatMap(
				(versions) => versions.slice(-1),
			);
			ctx.stdout.write(
				skills.length === 0
					? "No Skills\n"
					: `${skills
							.sort((a, b) => a.id.localeCompare(b.id))
							.map((s) => `${s.id}  version ${s.version}  ${s.title}`)
							.join("\n")}\n`,
			);
			return 0;
		},
	},
};
