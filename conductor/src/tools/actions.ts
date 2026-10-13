import type { z } from "zod";
import type { AgentId, ArtifactId } from "../ids.js";
import type { OrgState } from "../org/projection.js";
import { ACTION_OF_ROSTER_TEXT } from "../org/seed.js";
import type { Projections } from "../projections.js";
import { assigneeOf } from "../task/projection.js";
import { type Action, isAction } from "../types/action.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import type { Stage } from "../workflow/stages.js";
import { stageOfScript } from "./run-script.js";
import { type AnyTool, TOOLS, type ToolName } from "./table.js";

type CallOf<T> = T extends AnyTool
	? { readonly name: T["name"]; readonly input: z.output<T["input"]> }
	: never;

/** One Tool call as the hook judges it: who calls which Tool on what input. */
export type ToolCall = CallOf<AnyTool> & {
	readonly agent: AgentId;
	readonly stages: readonly Stage[];
};

/**
 * One Action's predicate. A plain Action is every call of the Tools whose
 * row names it. A relational one covers some Tools and also reads the
 * Projections: `when` says why this call performs it, naming the ids, or
 * returns undefined when it does not.
 */
export type ActionRule = {
	readonly action: Action;
	readonly covers: readonly ToolName[];
	readonly when?: (
		call: ToolCall,
		projections: Projections,
	) => string | undefined;
};

export const performs = (
	rule: ActionRule,
	call: ToolCall,
	projections: Projections,
): string | undefined => {
	if (!rule.covers.includes(call.name)) return undefined;
	return rule.when === undefined
		? `${call.name} performs it`
		: rule.when(call, projections);
};

const plain = (action: Action): ActionRule => ({
	action,
	covers: TOOLS.filter((t) => t.action === action).map((t) => t.name),
});

/**
 * The last stage whose input types the Artifacts cover: the stage a Task on
 * them works. Each stage takes an output of an earlier one, so no earlier
 * stage's Task covers a later stage's inputs, while stage 6's covers stage
 * 3's (#59).
 */
export const stageOfInputs = (
	stages: readonly Stage[],
	projections: Projections,
	inputs: readonly ArtifactId[],
): Stage | undefined => {
	const types = new Set(
		inputs.map((id) => projections.artifacts.artifacts.get(id)?.artifact_type),
	);
	return stages
		.filter((s) => s.inputs.length > 0 && s.inputs.every((t) => types.has(t)))
		.at(-1);
};

/** The stage a call works on: its Script's, its Task's, or its proposal's inputs'. */
const stageOfCall = (
	call: ToolCall,
	projections: Projections,
): Stage | undefined => {
	switch (call.name) {
		case "run_script":
			return stageOfScript(call.stages, call.input.script);
		case "propose_task":
			return stageOfInputs(call.stages, projections, call.input.inputs);
		case "assign_task":
		case "start_task":
		case "complete_task": {
			const task = projections.tasks.tasks.get(call.input.task_id);
			return task && stageOfInputs(call.stages, projections, task.inputs);
		}
		default:
			return undefined;
	}
};

const stageText = (stage: Stage) => `stage ${stage.number} ${stage.name}`;

/**
 * Who an Agent reports to. The Specialists report to every live Supervisor
 * as one pool, as the Org tree draws them.
 */
const supervisorsOf = (org: OrgState, id: AgentId): readonly AgentId[] => {
	const definition = org.agents.get(id)?.definition;
	if (definition?.role === "Specialist") {
		return [...org.agents.values()]
			.filter((a) => !a.retired && a.definition.role === "Supervisor")
			.map((a) => a.definition.id);
	}
	return definition?.supervisor_id === undefined
		? []
		: [definition.supervisor_id];
};

/**
 * `assignee` is on `agent`'s team: the Agent itself, an Agent that reports
 * to it, or one that reports to a Supervisor it reports to.
 */
const onTeam = (org: OrgState, agent: AgentId, assignee: AgentId) => {
	const theirs = supervisorsOf(org, assignee);
	return (
		agent === assignee ||
		theirs.includes(agent) ||
		supervisorsOf(org, agent).some((s) => theirs.includes(s))
	);
};

const RESULTS = 4;
const VERIFICATION = 5;
const REPORT = 6;

/** The Action table: one predicate per Action, in the order the hook checks them. */
export const ACTIONS: readonly ActionRule[] = [
	plain("RunScript"),
	plain("TouchArtifact"),
	// No Tool decides a Gate, runs code outside the Sandbox, or writes to a
	// System of record: only the Operator decides Gates (ADR-0006), and
	// `run_script` runs in the Sandbox on the toy LIMS, which is not one.
	plain("DecideGate"),
	plain("RunOutsideSandbox"),
	plain("WriteSystemOfRecord"),
	{
		action: "AssignLabWork",
		covers: ["propose_task", "assign_task"],
		when: (call, projections) => {
			const stage = stageOfCall(call, projections);
			return stage && `${call.name} gives out ${stageText(stage)}'s work`;
		},
	},
	{
		action: "AcceptOwnProposal",
		covers: ["assign_task", "start_task"],
		when: (call, projections) => {
			if (call.name !== "assign_task" && call.name !== "start_task") return;
			const { task_id } = call.input;
			const proposer = projections.proposals.proposedBy.get(task_id);
			return proposer?.tag === "Agent" && proposer.id === call.agent
				? `${call.agent} proposed ${task_id}`
				: undefined;
		},
	},
	{
		action: "DoLabWork",
		covers: ["run_script", "complete_task"],
		when: (call, projections) => {
			const stage = stageOfCall(call, projections);
			return stage && `${call.name} works ${stageText(stage)}`;
		},
	},
	{
		action: "TouchResults",
		covers: ["run_script", "complete_task"],
		when: (call, projections) => {
			const stage = stageOfCall(call, projections);
			return stage && stage.number >= RESULTS && stage.number <= REPORT
				? `${call.name} works ${stageText(stage)}`
				: undefined;
		},
	},
	{
		action: "VerifyOwnTeamRun",
		covers: ["run_script"],
		when: (call, projections) => {
			if (call.name !== "run_script") return;
			const stage = stageOfCall(call, projections);
			if (stage?.number !== VERIFICATION) return;
			const { org, artifacts, runs, tasks } = projections;
			for (const id of call.input.inputs) {
				for (const { record } of artifacts.productions.get(id) ?? []) {
					if (record.produced_by.tag !== "Run") continue;
					const run = runs.runs.get(record.produced_by.id);
					const task = run?.task_id && tasks.tasks.get(run.task_id);
					const assignee = task ? assigneeOf(task) : undefined;
					if (assignee && onTeam(org, call.agent, assignee)) {
						return `run_script verifies Artifact ${id} of ${record.produced_by.id} on ${task?.id}, worked by ${assignee} of ${call.agent}'s team`;
					}
				}
			}
			return undefined;
		},
	},
];

/**
 * The Actions a Charter forbids. A definition recorded before the vocabulary
 * holds the roster's phrases, read through the seed's table; any other text
 * names no Action.
 */
export const charterActions = (
	definition: AgentDefinition,
): ReadonlySet<Action> =>
	new Set(
		definition.charter.forbidden.flatMap((entry) => {
			if (isAction(entry)) return [entry];
			const roster: Readonly<Record<string, Action>> = ACTION_OF_ROSTER_TEXT;
			const action = Object.hasOwn(roster, entry) ? roster[entry] : undefined;
			return action === undefined ? [] : [action];
		}),
	);
