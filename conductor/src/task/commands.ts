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
import type { EventBody, NewEvent } from "../events.js";
import { AgentId, ArtifactId, RubricId, TaskId } from "../ids.js";
import { fold } from "../reduce.js";
import type { Actor } from "../types/actor.js";
import { type Task, TaskState, TatClass } from "../types/task.js";
import { nextTaskId, TaskProjection, type TaskView } from "./projection.js";

/** Rubric for Tasks proposed without `--rubric`: the five-dimension rubric. */
const DEFAULT_RUBRIC = RubricId.parse("default");

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
	return withLedger(home, false, (ledger) =>
		fold(ledger.events(), TaskProjection.reduce, TaskProjection.init),
	);
};

type TaskBody = Extract<EventBody, { payload: { task_id: TaskId } }>;

/**
 * Append one Task Event built from the current Tasks, under the writer lock,
 * and return the Task as it stands afterwards.
 */
const record = (
	ctx: CommandContext,
	actor: Actor,
	build: (view: TaskView) => TaskBody,
): Task =>
	withLedger(ctx.home, true, (ledger) => {
		const view = fold(ledger.all(), TaskProjection.reduce, TaskProjection.init);
		const body = build(view);
		const newEvent: NewEvent = {
			actor,
			task_id: body.payload.task_id,
			...body,
		};
		const event = ledger.append(newEvent);
		const task = TaskProjection.reduce(view, event).tasks.get(
			body.payload.task_id,
		);
		if (!task) throw new Error(`${body.payload.task_id} vanished`);
		return task;
	});

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
					? DEFAULT_RUBRIC
					: parseOrUsage(RubricId, values.rubric, "--rubric must not be empty");
			const parent_task =
				values.parent === undefined ? undefined : taskId(values.parent);
			const task = record(ctx, parseActor(values.as), (view) => ({
				kind: "TaskProposed",
				payload: {
					task_id: nextTaskId(view),
					title,
					goal,
					inputs,
					rubric_id,
					priority,
					tat_class,
					...(parent_task && { parent_task }),
				},
			}));
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
			return report(
				ctx,
				record(ctx, parseActor(values.as), () => ({
					kind: "TaskAssigned",
					payload: { task_id, assignee },
				})),
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
			return report(
				ctx,
				record(ctx, parseActor(values.as), () => ({
					kind: "TaskStarted",
					payload: { task_id },
				})),
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
			return report(
				ctx,
				record(ctx, parseActor(values.as), (view) => {
					const state = view.tasks.get(task_id)?.state;
					// A Task with no assignee is not InProgress, so the guard refuses
					// it on its state before `from` matters.
					const from = state && "assignee" in state ? state.assignee : to;
					return {
						kind: "TaskHandedOff",
						payload: { task_id, from, to, reason },
					};
				}),
			);
		},
	},
	complete: {
		args: "<task id> (--review-required --reviewer <Operator|agent id> | --skip-review --reason <text> | --reviewed) [--output <artifact id>]...",
		describe:
			"Complete an InProgress Task for Review or with Review skipped, or close one UnderReview",
		run: async (args, ctx) => {
			const { values, positionals } = parseArgs({
				args,
				options: {
					"review-required": { type: "boolean" },
					reviewer: { type: "string" },
					"skip-review": { type: "boolean" },
					reason: { type: "string" },
					reviewed: { type: "boolean" },
					output: { type: "string", multiple: true },
					...asOption,
				},
				allowPositionals: true,
			});
			const [id] = expectPositionals(positionals, ["<task id>"], "complete");
			const task_id = taskId(id as string);
			const modes = [
				values["review-required"] && "--review-required",
				values["skip-review"] && "--skip-review",
				values.reviewed && "--reviewed",
			].filter(Boolean);
			if (modes.length !== 1) {
				throw new UsageError(
					"task complete takes exactly one of --review-required, --skip-review, --reviewed",
				);
			}
			const review = values["review-required"]
				? {
						tag: "Required" as const,
						reviewer: parseActor(
							required(values.reviewer, "--reviewer"),
							"--reviewer",
						),
					}
				: values["skip-review"]
					? {
							tag: "Skipped" as const,
							reason: required(values.reason, "--reason"),
						}
					: { tag: "Reviewed" as const };
			const outputs = (values.output ?? []).map((text) =>
				parseOrUsage(
					ArtifactId,
					text,
					"--output must be an Artifact id (64 hex)",
				),
			);
			return report(
				ctx,
				record(ctx, parseActor(values.as), () => ({
					kind: "TaskCompleted",
					payload: { task_id, outputs, review },
				})),
			);
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
			return report(
				ctx,
				record(ctx, parseActor(values.as), () => ({
					kind: "TaskFailed",
					payload: { task_id, reason },
				})),
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
			return report(
				ctx,
				record(ctx, parseActor(values.as), () => ({
					kind: "TaskEscalated",
					payload: { task_id, to, reason },
				})),
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
