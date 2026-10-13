import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	actorText,
	parseActor,
	parseOrUsage,
	withLedger,
} from "../cli-support.js";
import {
	type CommandContext,
	type CommandTable,
	UsageError,
} from "../command.js";
import { AgentId, ArtifactId, RubricId, TaskId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import type { Recorded } from "../lifecycle-support.js";
import { type Task, TaskState, TatClass } from "../types/task.js";
import {
	assign,
	complete,
	escalate,
	fail,
	handOff,
	propose,
	start,
} from "./lifecycle.js";
import { TaskProjection, type TaskView } from "./projection.js";

const agentId = (text: string, what: string) =>
	parseOrUsage(AgentId, text, `${what} must be an Agent id like A-odile`);

const taskId = (text: string) =>
	parseOrUsage(TaskId, text, "the Task id must look like T-1");

const required = (value: string | undefined, flag: string): string => {
	if (value === undefined) throw new UsageError(`${flag} is required`);
	return value;
};

const expectPositionals = (
	positionals: string[],
	names: readonly string[],
	command: string,
) => {
	if (positionals.length !== names.length) {
		throw new UsageError(`task ${command} takes ${names.join(" ")}`);
	}
	return positionals;
};

const asOption = { as: { type: "string" } } as const;

const readView = (home: string): TaskView => {
	if (!existsSync(join(home, "ledger.sqlite"))) return TaskProjection.init;
	return withLedger(home, false, (ledger) => ledger.projections.tasks);
};

/** Run one lifecycle verb under the writer lock and return what it recorded. */
const recordUnderWriterLock = <R extends Recorded<"task", Task>>(
	ctx: CommandContext,
	verb: (ledger: Ledger) => R,
): R => withLedger(ctx.home, true, verb);

const stateText = (state: TaskState) => {
	const { tag, ...fields } = state;
	const details = Object.entries(fields).map(
		([key, value]) =>
			`${key} ${typeof value === "string" ? value : actorText(value)}`,
	);
	return details.length ? `${tag} (${details.join(", ")})` : tag;
};

const report = (ctx: CommandContext, task: Task) => {
	ctx.stdout.write(`${task.id} ${stateText(task.state)}\n`);
	return 0;
};

const STATE_ORDER = TaskState.options.map((o) => o.shape.tag.value);

const listLine = (task: Task) =>
	[
		`  ${task.id}`,
		task.title,
		`TAT ${task.tat_class}`,
		`priority ${task.priority}`,
		...("assignee" in task.state ? [`assignee ${task.state.assignee}`] : []),
	].join("  ");

const byNumber = (a: Task, b: Task) =>
	Number(a.id.slice(2)) - Number(b.id.slice(2));

export const taskCommands: CommandTable = {
	propose: {
		args: "--title <t> --goal <g> --tat <Regular|Rush1to2Days|Rush3to4Days> --priority <n> [--rubric <id>] [--input <artifact id>]... [--parent <task id>]",
		describe: "Propose a Task and print its id",
		run: async (args, ctx) => {
			const { values, positionals } = parseArgs({
				args,
				options: {
					title: { type: "string" },
					goal: { type: "string" },
					tat: { type: "string" },
					priority: { type: "string" },
					rubric: { type: "string" },
					input: { type: "string", multiple: true },
					parent: { type: "string" },
					...asOption,
				},
			});
			expectPositionals(positionals, [], "propose");
			const title = required(values.title, "--title");
			const goal = required(values.goal, "--goal");
			const tat_class = parseOrUsage(
				TatClass,
				required(values.tat, "--tat"),
				`--tat must be ${TatClass.options.slice(0, -1).join(", ")} or ${TatClass.options.at(-1)}`,
			);
			const priorityText = required(values.priority, "--priority");
			if (!/^-?\d+$/.test(priorityText)) {
				throw new UsageError(
					`--priority must be an integer, not ${JSON.stringify(priorityText)}`,
				);
			}
			const priority = Number(priorityText);
			const inputs = (values.input ?? []).map((text) =>
				parseOrUsage(
					ArtifactId,
					text,
					"--input must be an Artifact id (64 hex)",
				),
			);
			const rubric_id =
				values.rubric === undefined
					? undefined
					: parseOrUsage(RubricId, values.rubric, "--rubric must not be empty");
			const parent_task =
				values.parent === undefined ? undefined : taskId(values.parent);
			const actor = parseActor(values.as);
			const { task } = recordUnderWriterLock(ctx, (ledger) =>
				propose(ledger, {
					actor,
					title,
					goal,
					inputs,
					priority,
					tat_class,
					...(rubric_id && { rubric_id }),
					...(parent_task && { parent_task }),
				}),
			);
			ctx.stdout.write(`${task.id}\n`);
			return 0;
		},
	},
	assign: {
		args: "<task id> <agent id>",
		describe: "Assign a Proposed or Assigned Task to an Agent",
		run: async (args, ctx) => {
			const { values, positionals } = parseArgs({
				args,
				options: asOption,
				allowPositionals: true,
			});
			const [id, agent] = expectPositionals(
				positionals,
				["<task id>", "<agent id>"],
				"assign",
			);
			const task_id = taskId(id as string);
			const assignee = agentId(agent as string, "the assignee");
			const actor = parseActor(values.as);
			return report(
				ctx,
				recordUnderWriterLock(ctx, (ledger) =>
					assign(ledger, { actor, task_id, assignee }),
				).task,
			);
		},
	},
	start: {
		args: "<task id>",
		describe: "Start an Assigned Task",
		run: async (args, ctx) => {
			const { values, positionals } = parseArgs({
				args,
				options: asOption,
				allowPositionals: true,
			});
			const [id] = expectPositionals(positionals, ["<task id>"], "start");
			const task_id = taskId(id as string);
			const actor = parseActor(values.as);
			return report(
				ctx,
				recordUnderWriterLock(ctx, (ledger) =>
					start(ledger, { actor, task_id }),
				).task,
			);
		},
	},
	handoff: {
		args: "<task id> <agent id> --reason <text>",
		describe: "Hand an InProgress Task off to another Agent",
		run: async (args, ctx) => {
			const { values, positionals } = parseArgs({
				args,
				options: { reason: { type: "string" }, ...asOption },
				allowPositionals: true,
			});
			const [id, toText] = expectPositionals(
				positionals,
				["<task id>", "<agent id>"],
				"handoff",
			);
			const task_id = taskId(id as string);
			const to = agentId(toText as string, "the new assignee");
			const reason = required(values.reason, "--reason");
			const actor = parseActor(values.as);
			return report(
				ctx,
				recordUnderWriterLock(ctx, (ledger) =>
					handOff(ledger, { actor, task_id, to, reason }),
				).task,
			);
		},
	},
	complete: {
		args: "<task id> [--reviewer <Operator|agent id>] [--output <artifact id>]...",
		describe:
			"Complete an InProgress Task, for Review when the Trust tier samples it, or close one UnderReview",
		run: async (args, ctx) => {
			const { values, positionals } = parseArgs({
				args,
				options: {
					reviewer: { type: "string" },
					output: { type: "string", multiple: true },
					...asOption,
				},
				allowPositionals: true,
			});
			const [id] = expectPositionals(positionals, ["<task id>"], "complete");
			const task_id = taskId(id as string);
			const reviewer =
				values.reviewer === undefined
					? undefined
					: parseActor(values.reviewer, "--reviewer");
			const outputs = (values.output ?? []).map((text) =>
				parseOrUsage(
					ArtifactId,
					text,
					"--output must be an Artifact id (64 hex)",
				),
			);
			const actor = parseActor(values.as);
			const { task, review } = recordUnderWriterLock(ctx, (ledger) =>
				complete(ledger, { actor, task_id, outputs, reviewer }),
			);
			report(ctx, task);
			if (reviewer !== undefined && review.tag === "Skipped") {
				ctx.stdout.write(
					`Review skipped: ${task_id} was ${review.reason}, so the reviewer ${actorText(reviewer)} is unused\n`,
				);
			}
			return 0;
		},
	},
	fail: {
		args: "<task id> --reason <text>",
		describe: "Fail a live Task",
		run: async (args, ctx) => {
			const { values, positionals } = parseArgs({
				args,
				options: { reason: { type: "string" }, ...asOption },
				allowPositionals: true,
			});
			const [id] = expectPositionals(positionals, ["<task id>"], "fail");
			const task_id = taskId(id as string);
			const reason = required(values.reason, "--reason");
			const actor = parseActor(values.as);
			return report(
				ctx,
				recordUnderWriterLock(ctx, (ledger) =>
					fail(ledger, { actor, task_id, reason }),
				).task,
			);
		},
	},
	escalate: {
		args: "<task id> --to <Operator|agent id> --reason <text>",
		describe: "Escalate a live Task to the Operator or another Agent",
		run: async (args, ctx) => {
			const { values, positionals } = parseArgs({
				args,
				options: {
					to: { type: "string" },
					reason: { type: "string" },
					...asOption,
				},
				allowPositionals: true,
			});
			const [id] = expectPositionals(positionals, ["<task id>"], "escalate");
			const task_id = taskId(id as string);
			const to = parseActor(required(values.to, "--to"), "--to");
			const reason = required(values.reason, "--reason");
			const actor = parseActor(values.as);
			return report(
				ctx,
				recordUnderWriterLock(ctx, (ledger) =>
					escalate(ledger, { actor, task_id, to, reason }),
				).task,
			);
		},
	},
	list: {
		describe: "List Tasks grouped by state",
		run: async (args, ctx) => {
			parseArgs({ args });
			const tasks = [...readView(ctx.home).tasks.values()];
			if (tasks.length === 0) {
				ctx.stdout.write("No Tasks\n");
				return 0;
			}
			const lines = STATE_ORDER.flatMap((tag) => {
				const group = tasks.filter((t) => t.state.tag === tag).sort(byNumber);
				return group.length
					? [`${tag} (${group.length})`, ...group.map(listLine)]
					: [];
			});
			ctx.stdout.write(`${lines.join("\n")}\n`);
			return 0;
		},
	},
};
