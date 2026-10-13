import { z } from "zod";
import { orRefuse } from "../append-guard.js";
import { requestGate } from "../gate/lifecycle.js";
import {
	AgentId,
	ArtifactId,
	RoomId,
	ScriptId,
	Seq,
	SkillId,
	TaskId,
} from "../ids.js";
import { revise } from "../org/lifecycle.js";
import { liveAgent } from "../org/projection.js";
import { open, say } from "../room/lifecycle.js";
import { history, RoomRefused } from "../room/projection.js";
import { openArtifacts, walkLineage } from "../sandbox/artifacts.js";
import {
	assign,
	block,
	complete,
	escalate,
	fail,
	handOff,
	propose,
	requestHelp,
	review,
	start,
} from "../task/lifecycle.js";
import { publishSkill, recordMemoryNote } from "../training/lifecycle.js";
import type { Action } from "../types/action.js";
import type { Actor } from "../types/actor.js";
import { AgentDefinition } from "../types/agent-definition.js";
import { ArtifactType } from "../types/artifact.js";
import { GateKind } from "../types/gate.js";
import { Score } from "../types/merit.js";
import { TaskState, TatClass } from "../types/task.js";
import { orderRest } from "../vitality/lifecycle.js";
import { storeMessage } from "./message.js";
import { runScriptAs, stageOfScript } from "./run-script.js";
import { asText, type Tool, type ToolContext, ToolRefused } from "./tool.js";

/** One row, typed by its input shape; the verb's result goes back as JSON text. */
const tool = <N extends string, S extends z.ZodRawShape>(row: {
	readonly name: N;
	readonly description: string;
	readonly input: S;
	readonly action?: Action;
	readonly call: (
		ctx: ToolContext,
		input: z.output<z.ZodObject<S, z.core.$strict>>,
		self: Actor,
	) => unknown;
}): Tool<N, S> => ({
	name: row.name,
	description: row.description,
	input: z.strictObject(row.input),
	action: row.action,
	call: async (ctx, input) =>
		asText(await row.call(ctx, input, { tag: "Agent", id: ctx.agent })),
});

/** `Operator` or an Agent id, as a Tool's input names an Actor. */
const ActorName = z.union([z.literal("Operator"), AgentId]);
const actorOf = (name: z.output<typeof ActorName>): Actor =>
	name === "Operator" ? { tag: "Operator" } : { tag: "Agent", id: name };

const artifactOf = (ctx: ToolContext, id: ArtifactId) => {
	const artifact = ctx.ledger.projections.artifacts.artifacts.get(id);
	if (artifact === undefined) {
		throw new ToolRefused(`Artifact ${id} is not in the Ledger`);
	}
	return artifact;
};

const TEXT_MEDIA = /^(text\/|application\/json)/;

/**
 * The Agent's Tools: each a Ledger-backed verb it calls as itself. The MCP
 * server of one Agent is built from this table (`sdk.ts`).
 */
export const TOOLS = [
	tool({
		name: "read_tasks",
		description:
			"List Tasks with their state, inputs, outputs and Help requests, filtered by assignee or state",
		input: {
			assignee: AgentId.optional(),
			state: z.enum(TaskState.options.map((o) => o.shape.tag.value)).optional(),
		},
		call: ({ ledger }, { assignee, state }) =>
			[...ledger.projections.tasks.tasks.values()].filter(
				(task) =>
					(state === undefined || task.state.tag === state) &&
					(assignee === undefined ||
						("assignee" in task.state && task.state.assignee === assignee)),
			),
	}),
	tool({
		name: "propose_task",
		description: "Propose a Task under the next free Task id",
		input: {
			title: z.string().min(1),
			goal: z.string(),
			tat_class: TatClass,
			priority: z.number().int(),
			inputs: z.array(ArtifactId).default([]),
			parent_task: TaskId.optional(),
		},
		call: ({ ledger }, { parent_task, ...fields }, actor) =>
			propose(ledger, {
				actor,
				...fields,
				...(parent_task === undefined ? {} : { parent_task }),
			}),
	}),
	tool({
		name: "assign_task",
		description: "Assign a Task to an Agent",
		input: { task_id: TaskId, assignee: AgentId },
		call: ({ ledger }, fields, actor) => assign(ledger, { actor, ...fields }),
	}),
	tool({
		name: "start_task",
		description: "Start a Task assigned to you",
		input: { task_id: TaskId },
		call: ({ ledger }, fields, actor) => start(ledger, { actor, ...fields }),
	}),
	tool({
		name: "complete_task",
		description:
			"Complete a Task with its output Artifacts; name a reviewer for when the Trust tier samples it for Review",
		input: {
			task_id: TaskId,
			outputs: z.array(ArtifactId).default([]),
			reviewer: ActorName.optional(),
		},
		call: ({ ledger }, { reviewer, ...fields }, actor) =>
			complete(ledger, {
				actor,
				...fields,
				reviewer: reviewer === undefined ? undefined : actorOf(reviewer),
			}),
	}),
	tool({
		name: "fail_task",
		description: "Fail a Task, with the reason",
		input: { task_id: TaskId, reason: z.string().min(1) },
		call: ({ ledger }, fields, actor) => fail(ledger, { actor, ...fields }),
	}),
	tool({
		name: "escalate_task",
		description:
			"Escalate a Task up the reporting line to an Agent or the Operator",
		input: { task_id: TaskId, to: ActorName, reason: z.string().min(1) },
		call: ({ ledger }, { to, ...fields }, actor) =>
			escalate(ledger, { actor, to: actorOf(to), ...fields }),
	}),
	tool({
		name: "hand_off",
		description: "Hand an InProgress Task off to another Agent",
		input: { task_id: TaskId, to: AgentId, reason: z.string().min(1) },
		call: ({ ledger }, fields, actor) => handOff(ledger, { actor, ...fields }),
	}),
	tool({
		name: "review_task",
		description:
			"Record your Review of a Task: 0 to 3 on quality, traceability, boundary adherence, collaboration and timeliness",
		input: {
			task_id: TaskId,
			quality: Score,
			traceability: Score,
			boundary_adherence: Score,
			collaboration: Score,
			timeliness: Score,
			note: z.string(),
		},
		call: ({ ledger }, fields, reviewer) =>
			review(ledger, { ...fields, reviewer }),
	}),
	tool({
		name: "request_help",
		description:
			"Request help on a Task assigned to you from an Agent or the Operator",
		input: { task_id: TaskId, to: ActorName, question: z.string().min(1) },
		call: ({ ledger }, { to, ...fields }, actor) =>
			requestHelp(ledger, { actor, to: actorOf(to), ...fields }),
	}),
	tool({
		name: "list_scripts",
		description:
			"List the registered Scripts: each one's id, latest version, input and output types, and the workflow stage it runs, if any",
		input: {},
		call: ({ ledger, stages }) =>
			[...ledger.projections.scripts.scripts.values()].flatMap((versions) => {
				const latest = versions.at(-1);
				if (latest === undefined) return [];
				const stage = stageOfScript(stages, latest.id);
				return [
					{
						id: latest.id,
						version: latest.version,
						input_types: latest.input_types,
						output_types: latest.output_types,
						stage:
							stage &&
							`stage ${stage.number} ${stage.name}, worked by ${stage.worked_by}`,
					},
				];
			}),
	}),
	tool({
		name: "run_script",
		description:
			"Run a Script version (the latest by default) in the Sandbox on input Artifacts; a workflow stage's Script needs the Task, and returns its Evaluation with the Run",
		input: {
			script: ScriptId,
			version: z.number().int().positive().optional(),
			inputs: z.array(ArtifactId),
			task_id: TaskId.optional(),
		},
		action: "RunScript",
		call: runScriptAs,
	}),
	tool({
		name: "read_artifact",
		description:
			"Read an Artifact's record, and its text when it is text or JSON",
		input: { artifact_id: ArtifactId },
		action: "TouchArtifact",
		call: (ctx, { artifact_id }) => {
			const artifact = artifactOf(ctx, artifact_id);
			const bytes = openArtifacts(ctx).read(artifact_id);
			return TEXT_MEDIA.test(artifact.media_type)
				? { artifact, text: bytes.toString("utf8") }
				: { artifact, bytes: bytes.length };
		},
	}),
	tool({
		name: "list_artifacts",
		description: "List the Artifacts in the Ledger, of one type if named",
		input: { artifact_type: ArtifactType.optional() },
		call: ({ ledger }, { artifact_type }) =>
			[...ledger.projections.artifacts.artifacts.values()].filter(
				(a) => artifact_type === undefined || a.artifact_type === artifact_type,
			),
	}),
	tool({
		name: "lineage",
		description:
			"Walk an Artifact's Lineage back to the Artifacts it was made from, each production with its depth",
		input: { artifact_id: ArtifactId },
		call: (ctx, { artifact_id }) => {
			artifactOf(ctx, artifact_id);
			return walkLineage(ctx.ledger.projections.artifacts, artifact_id).map(
				({ depth, production }) => ({ depth, ...production }),
			);
		},
	}),
	tool({
		name: "send_message",
		description:
			"Say a Message in a Room you belong to, as a reply when it names the Message it answers",
		input: {
			room_id: RoomId,
			body: z.string().min(1),
			reply_to: Seq.optional(),
		},
		call: ({ ledger }, fields, actor) => say(ledger, { actor, ...fields }),
	}),
	tool({
		name: "read_room",
		description: "Read every Message in a Room you belong to",
		input: { room_id: RoomId },
		call: ({ ledger }, { room_id }, actor) => {
			const { rooms, org } = ledger.projections;
			const messages = history(rooms, org, room_id, actor);
			if (messages instanceof RoomRefused) {
				throw new ToolRefused(messages.message);
			}
			return messages;
		},
	}),
	tool({
		name: "store_message",
		description:
			"Store the Operator's Message at a seq, in a Room you belong to, as an Other Artifact of its JSON (seq, room, said_by, ts, body), so a Script can run on it; storing it again returns the same Artifact",
		input: { seq: Seq },
		action: "TouchArtifact",
		call: (ctx, { seq }, actor) => storeMessage(ctx, actor, seq),
	}),
	tool({
		name: "open_room",
		description:
			"Open a Room that lists you and the Agents you name, about a Task if one is named",
		input: {
			room_id: RoomId,
			name: z.string().min(1),
			purpose: z.string(),
			agents: z.array(AgentId),
			task_id: TaskId.optional(),
		},
		call: (
			{ ledger, agent },
			{ room_id, agents, task_id, ...room },
			opened_by,
		) =>
			open(ledger, {
				id: room_id,
				...room,
				membership: {
					tag: "Listed",
					agents: [...new Set([agent, ...agents])],
				},
				opened_by,
				...(task_id === undefined ? {} : { task_id }),
			}),
	}),
	tool({
		name: "note_memory",
		description:
			"Note a Memory note on a Task you worked, to read before similar Tasks",
		input: {
			task_id: TaskId,
			lesson: z.string().min(1),
			applies_to: z.array(z.string()),
		},
		call: ({ ledger, agent }, note, actor) =>
			recordMemoryNote(ledger, { actor, agent, ...note }),
	}),
	tool({
		name: "publish_skill",
		description: "Publish the next version of a Skill, a Markdown procedure",
		input: { id: SkillId, title: z.string().min(1), body_md: z.string() },
		call: ({ ledger }, skill, actor) =>
			publishSkill(ledger, { actor, ...skill }),
	}),
	tool({
		name: "propose_revision",
		description:
			"Revise an Agent definition: its next version with the Charter, Persona, Skills or capacity you give, and the reason",
		input: {
			agent_id: AgentId,
			reason: z.string().min(1),
			charter: AgentDefinition.shape.charter.optional(),
			persona: AgentDefinition.shape.persona.optional(),
			skills: z.array(SkillId).optional(),
			capacity: z.number().int().positive().optional(),
		},
		call: ({ ledger }, { agent_id, reason, ...changes }, actor) => {
			const { definition } = orRefuse(
				"AgentDefinitionRevised",
				liveAgent(ledger.projections.org, agent_id),
			);
			const defined = Object.fromEntries(
				Object.entries(changes).filter(([, v]) => v !== undefined),
			);
			return revise(ledger, {
				actor,
				definition: {
					...definition,
					...defined,
					version: definition.version + 1,
					revised_by: actor,
					revision_reason: reason,
				},
			});
		},
	}),
	tool({
		name: "request_gate",
		description:
			"Request a Gate, the Operator's decision on an action outside the Sandbox; naming a Task you work blocks it until the decision",
		input: {
			kind: GateKind,
			payload: z.json(),
			task_id: TaskId.optional(),
		},
		call: ({ ledger }, { task_id, ...request }, actor) =>
			task_id === undefined
				? requestGate(ledger, { actor, ...request })
				: block(ledger, { actor, task_id, ...request }),
	}),
	tool({
		name: "order_rest",
		description: "Order Rest for an Agent, with the reason",
		input: { agent_id: AgentId, reason: z.string().min(1) },
		call: ({ ledger }, order, actor) =>
			orderRest(ledger, { actor, action: "begin", ...order }),
	}),
	tool({
		name: "end_rest",
		description: "End an Agent's Rest, with the reason",
		input: { agent_id: AgentId, reason: z.string().min(1) },
		call: ({ ledger }, order, actor) =>
			orderRest(ledger, { actor, action: "end", ...order }),
	}),
	tool({
		name: "verify_ledger",
		description: "Verify the Ledger's hash chain from the first Event",
		input: {},
		call: ({ ledger }) => ledger.verify(),
	}),
] as const;

export type AnyTool = (typeof TOOLS)[number];
export type ToolName = AnyTool["name"];

export const toolNamed = (name: string): AnyTool | undefined =>
	TOOLS.find((t) => t.name === name);
