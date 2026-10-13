import type { Event, PayloadOf } from "../events.js";
import { type AgentId, type GateId, nextId, TaskId } from "../ids.js";
import { type Projection, Refusal } from "../reduce.js";
import type { Actor } from "../types/actor.js";
import type { Task, TaskState } from "../types/task.js";

export type TaskView = { readonly tasks: ReadonlyMap<TaskId, Task> };

type Tag = TaskState["tag"];
type StateOf<T extends Tag> = Extract<TaskState, { tag: T }>;

/** States a Task can leave. Done, Failed and Escalated have no way out. */
export const LIVE_TAGS = [
	"Proposed",
	"Assigned",
	"InProgress",
	"UnderReview",
	"Blocked",
] as const satisfies readonly Tag[];

/** The next state, or a reason that completes "<task> ...". */
type Rule<F extends Tag, P> = {
	readonly from: readonly F[];
	readonly to: (state: StateOf<F>, input: P) => TaskState | string;
};

const rule = <F extends Tag, P>(
	from: readonly F[],
	to: (state: StateOf<F>, input: P) => TaskState | string,
): Rule<F, P> => ({ from, to });

const isIn = <F extends Tag>(
	from: readonly F[],
	state: TaskState,
): state is StateOf<F> => (from as readonly Tag[]).includes(state.tag);

/** The Task state machine: every legal move. */
const RULES = {
	TaskAssigned: rule(
		["Proposed", "Assigned"],
		(_, p: PayloadOf<"TaskAssigned">) => ({
			tag: "Assigned",
			assignee: p.assignee,
		}),
	),
	TaskStarted: rule(["Assigned"], (s) => ({
		tag: "InProgress",
		assignee: s.assignee,
	})),
	TaskHandedOff: rule(["InProgress"], (s, p: PayloadOf<"TaskHandedOff">) =>
		p.from === s.assignee
			? { tag: "Assigned", assignee: p.to }
			: `is assigned to ${s.assignee}, not ${p.from}`,
	),
	CompletedForReview: rule(["InProgress"], (s, reviewer: Actor) => ({
		tag: "UnderReview",
		assignee: s.assignee,
		reviewer,
	})),
	CompletedSkippingReview: rule(["InProgress"], (s) => ({
		tag: "Done",
		assignee: s.assignee,
	})),
	CompletedAfterReview: rule(["UnderReview"], (s) => ({
		tag: "Done",
		assignee: s.assignee,
	})),
	TaskFailed: rule(LIVE_TAGS, (_, p: PayloadOf<"TaskFailed">) => ({
		tag: "Failed",
		reason: p.reason,
	})),
	TaskEscalated: rule(LIVE_TAGS, (_, p: PayloadOf<"TaskEscalated">) => ({
		tag: "Escalated",
		to: p.to,
	})),
	GateRequested: rule(["InProgress"], (s, gate: GateId) => ({
		tag: "Blocked",
		assignee: s.assignee,
		gate,
	})),
	GateDecided: rule(["Blocked"], (s, gate: GateId) =>
		gate === s.gate
			? { tag: "InProgress", assignee: s.assignee }
			: `is blocked on ${s.gate}, not ${gate}`,
	),
};

const orList = (tags: readonly string[]) =>
	tags.length <= 1
		? tags.join("")
		: `${tags.slice(0, -1).join(", ")} or ${tags.at(-1)}`;

/**
 * The next state, or why `subject` cannot move: its state, or the rule's own
 * reason. `context` ends a refusal that the state alone would not explain.
 */
const fire = <F extends Tag, P>(
	subject: string,
	r: Rule<F, P>,
	state: TaskState,
	input: P,
	context: string,
): TaskState | Refusal => {
	if (!isIn(r.from, state)) {
		return new Refusal(
			`${subject} is ${state.tag}, expected ${orList(r.from)}${context}`,
		);
	}
	const next = r.to(state, input);
	return typeof next === "string" ? new Refusal(`${subject} ${next}`) : next;
};

/** The Task an Event speaks about, if any. */
export const taskIdOf = (event: Event): TaskId | undefined => {
	switch (event.kind) {
		case "TaskProposed":
		case "TaskAssigned":
		case "TaskStarted":
		case "TaskHandedOff":
		case "TaskCompleted":
		case "TaskFailed":
		case "TaskEscalated":
			return event.payload.task_id;
		case "GateRequested":
			return event.task_id;
		default:
			return undefined;
	}
};

/**
 * Move one Task's state by one Event. Events that do not move Tasks, and
 * TaskProposed (which creates a Task rather than moving one), are refused.
 */
export const transition = (
	state: TaskState,
	event: Event,
): TaskState | Refusal => {
	const subject = taskIdOf(event) ?? "the Task";
	const go = <F extends Tag, P>(r: Rule<F, P>, input: P, context = "") =>
		fire(subject, r, state, input, context);
	switch (event.kind) {
		case "TaskAssigned":
			return go(RULES.TaskAssigned, event.payload);
		case "TaskStarted":
			return go(RULES.TaskStarted, undefined);
		case "TaskHandedOff":
			return go(RULES.TaskHandedOff, event.payload);
		case "TaskCompleted": {
			const review = event.payload.review;
			const context = ` for review ${review.tag}`;
			switch (review.tag) {
				case "Required":
					return go(RULES.CompletedForReview, review.reviewer, context);
				case "Skipped":
					return go(RULES.CompletedSkippingReview, undefined, context);
				case "Reviewed":
					return go(RULES.CompletedAfterReview, undefined, context);
			}
			break;
		}
		case "TaskFailed":
			return go(RULES.TaskFailed, event.payload);
		case "TaskEscalated":
			return go(RULES.TaskEscalated, event.payload);
		case "GateRequested":
			return go(RULES.GateRequested, event.payload.gate_id);
		case "GateDecided":
			return go(RULES.GateDecided, event.payload.gate_id);
	}
	return new Refusal(
		`${subject} is ${state.tag}, and ${event.kind} does not move a Task`,
	);
};

const withTask = (view: TaskView, task: Task): TaskView => {
	const tasks = new Map(view.tasks);
	tasks.set(task.id, task);
	return { tasks };
};

const move = (view: TaskView, task: Task, event: Event) => {
	const state = transition(task.state, event);
	if (state instanceof Refusal) return state;
	const outputs =
		event.kind === "TaskCompleted"
			? [...task.outputs, ...event.payload.outputs]
			: task.outputs;
	return withTask(view, { ...task, state, outputs });
};

/**
 * Apply one Event to every Task it touches, or say why the Task state machine
 * cannot accept it. Events that touch no Task leave the view as it is.
 */
export const applyTaskEvent = (
	view: TaskView,
	event: Event,
): TaskView | Refusal => {
	if (event.kind === "GateDecided") {
		const blocked = [...view.tasks.values()].find(
			(t) =>
				t.state.tag === "Blocked" && t.state.gate === event.payload.gate_id,
		);
		return blocked ? move(view, blocked, event) : view;
	}
	const id = taskIdOf(event);
	if (id === undefined) return view;
	const task = view.tasks.get(id);
	if (event.kind === "TaskProposed") {
		if (task) {
			return new Refusal(`${id} already exists and is ${task.state.tag}`);
		}
		const { task_id, ...fields } = event.payload;
		return withTask(view, {
			id: task_id,
			...fields,
			outputs: [],
			state: { tag: "Proposed" },
		});
	}
	if (!task) {
		return new Refusal(`${id} does not exist`);
	}
	return move(view, task, event);
};

/** Tasks from the Ledger, moved by the Task state machine. */
export const TaskProjection: Projection<TaskView> = {
	init: { tasks: new Map() },
	reduce: applyTaskEvent,
};

/** The Agent a Task is assigned to, or was when it was done. */
export const assigneeOf = (task: Task | undefined): AgentId | undefined =>
	task !== undefined && "assignee" in task.state
		? task.state.assignee
		: undefined;

/** The id after the highest `T-<n>` in the view: `T-1` for an empty one. */
export const nextTaskId = (view: TaskView): TaskId =>
	TaskId.parse(nextId("T", view.tasks.keys()));
