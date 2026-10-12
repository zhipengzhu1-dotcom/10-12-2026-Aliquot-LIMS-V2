import type { Event, PayloadOf } from "../events.js";
import { type GateId, nextId, TaskId } from "../ids.js";
import type { Projection } from "../reduce.js";
import type { Actor } from "../types/actor.js";
import type { Task, TaskState } from "../types/task.js";

export type TaskView = { readonly tasks: ReadonlyMap<TaskId, Task> };

/** Why an Event cannot move a Task. Returned, never thrown. */
export class TransitionError {
	constructor(readonly message: string) {}
}

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

/** The Task state machine: every legal move, keyed by the name refusals use. */
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
	"TaskCompleted (review Required)": rule(
		["InProgress"],
		(s, reviewer: Actor) => ({
			tag: "UnderReview",
			assignee: s.assignee,
			reviewer,
		}),
	),
	"TaskCompleted (review Skipped)": rule(["InProgress"], () => ({
		tag: "Done",
	})),
	"TaskCompleted (review Reviewed)": rule(["UnderReview"], () => ({
		tag: "Done",
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

const fire = <F extends Tag, P>(
	name: string,
	subject: string,
	r: Rule<F, P>,
	state: TaskState,
	input: P,
): TaskState | TransitionError => {
	const refuse = (reason: string) =>
		new TransitionError(`${name} refused: ${subject} ${reason}`);
	if (!isIn(r.from, state)) {
		return refuse(`is ${state.tag}, expected ${orList(r.from)}`);
	}
	const next = r.to(state, input);
	return typeof next === "string" ? refuse(next) : next;
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
): TaskState | TransitionError => {
	const subject = taskIdOf(event) ?? "the Task";
	const go = <F extends Tag, P>(name: string, r: Rule<F, P>, input: P) =>
		fire(name, subject, r, state, input);
	switch (event.kind) {
		case "TaskAssigned":
			return go(event.kind, RULES.TaskAssigned, event.payload);
		case "TaskStarted":
			return go(event.kind, RULES.TaskStarted, undefined);
		case "TaskHandedOff":
			return go(event.kind, RULES.TaskHandedOff, event.payload);
		case "TaskCompleted": {
			const review = event.payload.review;
			switch (review.tag) {
				case "Required":
					return go(
						"TaskCompleted (review Required)",
						RULES["TaskCompleted (review Required)"],
						review.reviewer,
					);
				case "Skipped":
					return go(
						"TaskCompleted (review Skipped)",
						RULES["TaskCompleted (review Skipped)"],
						undefined,
					);
				case "Reviewed":
					return go(
						"TaskCompleted (review Reviewed)",
						RULES["TaskCompleted (review Reviewed)"],
						undefined,
					);
			}
			break;
		}
		case "TaskFailed":
			return go(event.kind, RULES.TaskFailed, event.payload);
		case "TaskEscalated":
			return go(event.kind, RULES.TaskEscalated, event.payload);
		case "GateRequested":
			return go(event.kind, RULES.GateRequested, event.payload.gate_id);
		case "GateDecided":
			return go(event.kind, RULES.GateDecided, event.payload.gate_id);
	}
	return new TransitionError(
		`${event.kind} refused: ${subject} is ${state.tag}, and ${event.kind} does not move a Task`,
	);
};

const withTask = (view: TaskView, task: Task): TaskView => {
	const tasks = new Map(view.tasks);
	tasks.set(task.id, task);
	return { tasks };
};

const move = (view: TaskView, task: Task, event: Event) => {
	const state = transition(task.state, event);
	if (state instanceof TransitionError) return state;
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
): TaskView | TransitionError => {
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
			return new TransitionError(
				`TaskProposed refused: ${id} already exists and is ${task.state.tag}`,
			);
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
		return new TransitionError(`${event.kind} refused: ${id} does not exist`);
	}
	return move(view, task, event);
};

/** Tasks from the Ledger. Events the state machine refuses change nothing. */
export const TaskProjection: Projection<TaskView> = {
	init: { tasks: new Map() },
	reduce: (view, event) => {
		const next = applyTaskEvent(view, event);
		return next instanceof TransitionError ? view : next;
	},
};

/** The id after the highest `T-<n>` in the view: `T-1` for an empty one. */
export const nextTaskId = (view: TaskView): TaskId =>
	TaskId.parse(nextId("T", view.tasks.keys()));
