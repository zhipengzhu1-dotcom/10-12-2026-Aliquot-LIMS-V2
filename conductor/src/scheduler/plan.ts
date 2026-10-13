import { sha256Hex } from "../hash.js";
import type { AgentId, ArtifactId, TaskId } from "../ids.js";
import type { Projections } from "../projections.js";
import { roomsOf } from "../room/projection.js";
import { assigneeRefusal } from "../task/guards.js";
import { LIVE_TAGS } from "../task/projection.js";
import { startRefusal } from "../turn/guards.js";
import { type TurnRecord, tokensInWindow } from "../turn/projection.js";
import type { Role } from "../types/agent-definition.js";
import type { TrustTier } from "../types/merit.js";
import type { Task } from "../types/task.js";
import { trustOf } from "../vitality/trust.js";
import { FIVE_HOURS_MS } from "../vitality/vitality.js";
import { verifierRefusal } from "../workflow/guards.js";
import { STAGES, type Stage } from "../workflow/stages.js";

/** What `aliquot serve` sets for the Scheduler. */
export type SchedulerOptions = {
	/** How often a Tick runs, and how long a Proposed Task waits for an assignee before the Conductor assigns it. */
	readonly tickMs: number;
	/** How often the Steward and the Auditor get a Turn with nothing else to do. */
	readonly dutyMs: number;
	/** The most Turns open at once. */
	readonly concurrency: number;
	/** The society's tokens per 5-hour window. */
	readonly energyBudgetTokens: number;
};

/** One decision of a Tick, in the order the Tick applies it. */
export type Decision =
	| {
			readonly tag: "Assign";
			readonly task_id: TaskId;
			readonly agent: AgentId;
			readonly why: string;
	  }
	| {
			readonly tag: "NoAssignee";
			readonly task_id: TaskId;
			readonly why: string;
	  }
	| { readonly tag: "Start"; readonly agent: AgentId; readonly why: string }
	| { readonly tag: "Skip"; readonly agent: AgentId; readonly why: string }
	| { readonly tag: "Idle"; readonly why: string };

/** The allocation weight of each Trust tier (docs/design/vitality-and-merit.md). */
export const ALLOCATION_WEIGHT: Readonly<Record<TrustTier, number>> = {
	Probation: 1,
	Trusted: 2,
	Senior: 3,
	Mentor: 3,
};

/** Weights are whole numbers: the tier's weight times 1 - load, in hundredths. */
const WEIGHT_SCALE = 100;

/** Above this share of the Energy budget, only an Agent holding a rush Task gets a Turn. */
export const RUSH_ONLY_SHARE = 0.8;

/** The roles whose Agents get a Turn every `--duty` with nothing else to do. */
const STANDING_DUTY: readonly Role[] = ["Steward", "Auditor"];

/** The Task states in which an Agent holds a Task: it counts toward its load. */
const HELD = ["Assigned", "InProgress", "Blocked"] as const;

const byId = (a: { id: string }, b: { id: string }) =>
	a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * The stage a Task works: the first stage whose input types its inputs
 * cover, as the Tool hook reads a stage from a Task.
 */
const stageOf = (
	projections: Projections,
	inputs: readonly ArtifactId[],
): Stage | undefined => {
	const types = new Set(
		inputs.map((id) => projections.artifacts.artifacts.get(id)?.artifact_type),
	);
	return STAGES.find(
		(s) => s.inputs.length > 0 && s.inputs.every((t) => types.has(t)),
	);
};

/** A stage's Task goes to the role of the Agent that works the stage; any other Task to a Specialist. */
const roleFor = (projections: Projections, task: Task): Role => {
	const stage = stageOf(projections, task.inputs);
	const stageRole =
		stage && projections.org.agents.get(stage.worked_by)?.definition.role;
	return stageRole ?? "Specialist";
};

/** `hash(task_id) mod total`, from the same hash the Review sample reads. */
export const pickOf = (task_id: TaskId, total: number): number =>
	Number.parseInt(sha256Hex(task_id).slice(0, 8), 16) % total;

type Candidate = {
	readonly id: AgentId;
	readonly role: Role;
	readonly capacity: number;
	readonly tier: TrustTier;
};

/**
 * What one Tick does, from the Ledger as it stands at `now`, and nothing
 * else: the same Projections, time and options give the same decisions.
 * `proposedAt` holds when each Proposed Task was proposed.
 */
export const plan = (
	projections: Projections,
	now: Date,
	options: SchedulerOptions,
	proposedAt: ReadonlyMap<TaskId, Date>,
): Decision[] => {
	const { org, tasks } = projections;
	const live: Candidate[] = [...org.agents.values()]
		.filter((a) => !a.retired)
		.map(({ definition: d }) => ({
			id: d.id,
			role: d.role,
			capacity: d.capacity,
			tier: trustOf(projections.trust, d.id).tier,
		}))
		.sort(byId);

	const held = new Map<AgentId, TaskId[]>();
	for (const task of tasks.tasks.values()) {
		const { state } = task;
		if (
			(HELD as readonly string[]).includes(state.tag) &&
			"assignee" in state
		) {
			held.set(state.assignee, [...(held.get(state.assignee) ?? []), task.id]);
		}
	}

	const decisions: Decision[] = [];
	for (const task of tasks.tasks.values()) {
		if (task.state.tag !== "Proposed") continue;
		const at = proposedAt.get(task.id);
		if (at === undefined || now.getTime() - at.getTime() < options.tickMs) {
			continue;
		}
		decisions.push(assignment(projections, task, live, held));
	}

	decisions.push(...turnDecisions(projections, now, options, live, held));
	return decisions;
};

/**
 * The weighted pick among the Agents of the Task's role that may take it:
 * each weighs its tier's allocation weight times 1 - load, and
 * `hash(task_id) mod total` lands on one of them, in id order.
 */
const assignment = (
	projections: Projections,
	task: Task,
	live: readonly Candidate[],
	held: Map<AgentId, TaskId[]>,
): Decision => {
	const role = roleFor(projections, task);
	const passed: string[] = [];
	const weighed: { readonly id: AgentId; readonly weight: number }[] = [];
	for (const agent of live.filter((a) => a.role === role)) {
		const refusal =
			(projections.org.agents.get(agent.id)?.paused
				? { reason: `${agent.id} is paused` }
				: undefined) ??
			assigneeRefusal(projections, agent.id) ??
			verifierRefusal(projections, task, agent.id);
		const load = (held.get(agent.id)?.length ?? 0) / agent.capacity;
		const weight = Math.round(
			ALLOCATION_WEIGHT[agent.tier] * Math.max(0, 1 - load) * WEIGHT_SCALE,
		);
		if (refusal !== undefined) passed.push(refusal.reason);
		else if (weight === 0) passed.push(`${agent.id} is at capacity`);
		else weighed.push({ id: agent.id, weight });
	}
	const skipped =
		passed.length === 0 ? "" : `; passed over: ${passed.join("; ")}`;
	const total = weighed.reduce((sum, w) => sum + w.weight, 0);
	if (total === 0) {
		return {
			tag: "NoAssignee",
			task_id: task.id,
			why: `${task.id}: no ${role} may take it${skipped}`,
		};
	}
	const pick = pickOf(task.id, total);
	let below = 0;
	const chosen =
		weighed.find((w) => {
			below += w.weight;
			return pick < below;
		}) ?? weighed[weighed.length - 1];
	if (chosen === undefined) throw new Error("a positive total has a weight");
	held.set(chosen.id, [...(held.get(chosen.id) ?? []), task.id]);
	return {
		tag: "Assign",
		task_id: task.id,
		agent: chosen.id,
		why: `${task.id}: pick ${pick} of ${total} over ${weighed.map((w) => `${w.id} ${w.weight}`).join(", ")}${skipped}`,
	};
};

const lastTurnOf = (
	projections: Projections,
	agent: AgentId,
): TurnRecord | undefined =>
	[...projections.turns.turns.values()]
		.filter((t) => t.started.agent === agent)
		.at(-1);

/** Why an Agent has something to do this Tick, or nothing when it has not. */
const workFor = (
	projections: Projections,
	now: Date,
	options: SchedulerOptions,
	agent: Candidate,
	held: ReadonlyMap<AgentId, readonly TaskId[]>,
): string[] => {
	const { tasks, rooms, gates, artifacts } = projections;
	const last = lastTurnOf(projections, agent.id);
	// From the last Turn's start, as its prompt was built then: what arrived
	// during that Turn is new to the Agent.
	const since = last?.seq ?? 0;
	const reasons: string[] = [];

	// A Task assigned this Tick is still Proposed in the Projections.
	const working = (held.get(agent.id) ?? []).filter(
		(id) => tasks.tasks.get(id)?.state.tag !== "Blocked",
	);
	if (working.length > 0) reasons.push(`holds ${working.join(", ")}`);

	const self = { tag: "Agent", id: agent.id } as const;
	const myRooms = new Set(
		roomsOf(rooms, projections.org, self).map((r) => r.id),
	);
	const messages = rooms.messages.filter(
		(m) =>
			m.seq > since &&
			myRooms.has(m.room_id) &&
			!(m.actor.tag === "Agent" && m.actor.id === agent.id),
	).length;
	if (messages > 0) {
		reasons.push(
			`${messages} new Message${messages === 1 ? "" : "s"} in its Rooms`,
		);
	}

	for (const [task_id, requests] of tasks.help) {
		const tag = tasks.tasks.get(task_id)?.state.tag;
		if (!(LIVE_TAGS as readonly string[]).includes(tag ?? "")) continue;
		for (const r of requests) {
			if (r.seq > since && r.to.tag === "Agent" && r.to.id === agent.id) {
				reasons.push(`a Help request from ${r.from} on ${task_id}`);
			}
		}
	}

	for (const gate of gates.gates.values()) {
		if (
			gate.requester.tag === "Agent" &&
			gate.requester.id === agent.id &&
			gate.decision !== undefined &&
			gate.decision.seq > since
		) {
			reasons.push(`${gate.id} decided`);
		}
	}

	if (agent.role === "Director") {
		const proposed = new Set(
			[...tasks.tasks.values()].flatMap((t) => t.inputs),
		);
		const forms = [...artifacts.artifacts.values()].filter(
			(a) => a.artifact_type === "SubmissionForm" && !proposed.has(a.id),
		);
		if (forms.length > 0) {
			reasons.push(
				`${forms.length} Submission Form${forms.length === 1 ? "" : "s"} with no Task`,
			);
		}
	}

	if (STANDING_DUTY.includes(agent.role)) {
		if (last === undefined) reasons.push("standing duty, no Turn yet");
		else if (now.getTime() - Date.parse(last.at) >= options.dutyMs) {
			reasons.push(`standing duty, last Turn started ${last.at}`);
		}
	}
	return reasons;
};

/**
 * Turns for the Agents with something to do whose Turn may start, oldest
 * last Turn first, up to `concurrency` open at once. Over 80 percent of the
 * Energy budget, only an Agent holding a rush Task starts.
 */
const turnDecisions = (
	projections: Projections,
	now: Date,
	options: SchedulerOptions,
	live: readonly Candidate[],
	held: ReadonlyMap<AgentId, readonly TaskId[]>,
): Decision[] => {
	const decisions: Decision[] = [];
	const ready: { agent: Candidate; why: string; last: string }[] = [];
	for (const agent of live) {
		const reasons = workFor(projections, now, options, agent, held);
		if (reasons.length === 0) continue;
		const why = reasons.join("; ");
		const refusal = startRefusal(projections, agent.id);
		if (refusal !== undefined) {
			decisions.push({
				tag: "Skip",
				agent: agent.id,
				why: `${refusal.reason}; ${why}`,
			});
			continue;
		}
		ready.push({
			agent,
			why,
			last: lastTurnOf(projections, agent.id)?.at ?? "",
		});
	}
	ready.sort((a, b) =>
		a.last === b.last ? byId(a.agent, b.agent) : a.last < b.last ? -1 : 1,
	);

	const used = tokensInWindow(
		projections.turns,
		"society",
		new Date(now.getTime() - FIVE_HOURS_MS),
		now,
	);
	const rushOnly = used > RUSH_ONLY_SHARE * options.energyBudgetTokens;
	let open = projections.turns.open.size;
	for (const { agent, why } of ready) {
		const rush = (held.get(agent.id) ?? []).filter(
			(id) =>
				(projections.tasks.tasks.get(id)?.tat_class ?? "Regular") !== "Regular",
		);
		if (rushOnly && rush.length === 0) {
			decisions.push({
				tag: "Skip",
				agent: agent.id,
				why: `the society used ${used} of ${options.energyBudgetTokens} tokens in 5 hours, over ${RUSH_ONLY_SHARE * 100} percent, and ${agent.id} holds no rush Task; ${why}`,
			});
		} else if (open >= options.concurrency) {
			decisions.push({
				tag: "Skip",
				agent: agent.id,
				why: `${open} Turns open, the most at once; ${why}`,
			});
		} else {
			open += 1;
			decisions.push({
				tag: "Start",
				agent: agent.id,
				why: rushOnly ? `${why}; rush ${rush.join(", ")}` : why,
			});
		}
	}
	if (decisions.length === 0) {
		decisions.push({ tag: "Idle", why: "no Agent has anything to do" });
	}
	return decisions;
};
