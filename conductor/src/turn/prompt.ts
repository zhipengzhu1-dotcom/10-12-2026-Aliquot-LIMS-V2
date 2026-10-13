import { gateState } from "../gate/projection.js";
import type { AgentId, ArtifactId } from "../ids.js";
import type { Projections } from "../projections.js";
import { type Message, roomsOf } from "../room/projection.js";
import { LAB_ROOM } from "../room/seed.js";
import { LIVE_TAGS } from "../task/projection.js";
import { ACTIONS, charterActions } from "../tools/actions.js";
import { messagesById, PARSE_MESSAGE } from "../tools/message.js";
import { TOOLS } from "../tools/table.js";
import { actorText } from "../types/actor.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import type { Task } from "../types/task.js";
import { reviewerOf } from "../vitality/reviewers.js";
import { reviewSampleOf } from "../vitality/trust.js";
import { STAGES } from "../workflow/stages.js";
import type { TurnRecord } from "./projection.js";

/**
 * What one Turn tells its Agent, built from the Ledger: who it is and the
 * limits it works under, which the model holds for the whole Turn, and the
 * work in front of it now, which opens the Turn.
 */
export type TurnPrompt = {
	readonly standing: string;
	readonly work: string;
};

const [, RECEIPT, WORK_ORDER] = STAGES;
if (RECEIPT === undefined || WORK_ORDER === undefined) {
	throw new Error("the stage table has no stage 2 or 3");
}

/**
 * The Director's judgement on a Message in the Lab Room: received Samples
 * are work for the Specialist who works stage 2, and an unreadable report
 * gets a reply naming what is missing.
 */
const RECEIVING_WORK = `A Message in ${LAB_ROOM.id} that reports received Samples is work. When it names the Client, the product, the Lot, the Product Code, the quantity, the Sample Type and the TAT, propose a Task whose one input is the Message's Artifact id below, with the goal: store the Message with store_message, run S-${PARSE_MESSAGE} on it, run S-${RECEIPT.script} (stage ${RECEIPT.number} ${RECEIPT.name}) on its Submission Record and S-${WORK_ORDER.script} (stage ${WORK_ORDER.number} ${WORK_ORDER.name}) on the Receiving Log row and toy LIMS database that writes, all with the Task's id, then reply to the Message in ${LAB_ROOM.id} with each Lab Reference and the Work Order's due date. Then assign it to ${RECEIPT.worked_by}, who works stage ${RECEIPT.number}. When the Message cannot be read so, reply to it in ${LAB_ROOM.id} with send_message, naming what is missing, and propose no Task.`;

const list = (lines: readonly string[]) =>
	lines.length === 0 ? "None." : lines.map((l) => `- ${l}`).join("\n");

const section = (title: string, body: string) => `## ${title}\n\n${body}`;

const reportingLine = (
	projections: Projections,
	definition: AgentDefinition,
): string => {
	const id = definition.supervisor_id;
	if (id === undefined) return "You report to the Operator.";
	const name = projections.org.agents.get(id)?.definition.name ?? id;
	return `You report to ${name} (${id}).`;
};

const toolLines = (definition: AgentDefinition): string[] => {
	const forbidden = charterActions(definition);
	const rules = ACTIONS.filter((r) => forbidden.has(r.action));
	return TOOLS.map((tool) => {
		const covering = rules.filter((r) => r.covers.includes(tool.name));
		const plain = covering.find((r) => r.when === undefined);
		if (plain !== undefined) {
			return `${tool.name}: refused, your Charter forbids ${plain.action}`;
		}
		const when = covering.map((r) => r.action);
		return when.length === 0
			? `${tool.name}: ${tool.description}`
			: `${tool.name}: ${tool.description} (refused when the call is ${when.join(" or ")}, which your Charter forbids)`;
	});
};

const standing = (
	projections: Projections,
	definition: AgentDefinition,
): string => {
	const { name, id, role, charter, persona } = definition;
	const skills = definition.skills.map((skill) => {
		const latest = projections.training.skills.get(skill)?.at(-1);
		return latest === undefined
			? `### ${skill}\n\nNot published.`
			: `### ${latest.title} (${skill}, version ${latest.version})\n\n${latest.body_md}`;
	});
	const notes = (projections.training.notes.get(id) ?? []).map(
		(n) =>
			`${n.lesson} (from ${n.task_id}${n.applies_to.length === 0 ? "" : `; applies to ${n.applies_to.join(", ")}`})`,
	);
	return [
		`You are ${name} (${id}), the ${role} of a society of Agents that runs a pharmaceutical contract testing lab. ${reportingLine(projections, definition)} You act only through your Tools, always as ${id}, and every Tool call is an Event in the Ledger.`,
		section(
			"Charter",
			[
				`Purpose: ${charter.purpose}`,
				`Responsibilities:\n${list(charter.responsibilities)}`,
				`Forbidden: ${charter.forbidden.length === 0 ? "nothing" : charter.forbidden.join(", ")}`,
				`Escalation: ${charter.escalation}`,
			].join("\n\n"),
		),
		section(
			"Persona",
			`Voice: ${persona.voice}\nTraits: ${persona.traits.join(", ")}\nQuirk: ${persona.quirk}\nYour Persona changes how you speak, never what your Charter allows.`,
		),
		section("Skills", skills.length === 0 ? "None." : skills.join("\n\n")),
		section("Memory notes", list(notes)),
		section("Tools", list(toolLines(definition))),
	].join("\n\n");
};

const taskLine = (
	task: Task,
	projections: Projections,
	messages: ReadonlyMap<ArtifactId, Message>,
) => {
	const inputs = task.inputs.map((a) => {
		const type = projections.artifacts.artifacts.get(a)?.artifact_type;
		const message = messages.get(a);
		const said =
			message &&
			`the Operator's Message seq ${message.seq} in ${message.room_id}`;
		if (said === undefined) return type === undefined ? a : `${a} (${type})`;
		return type === undefined
			? `${a} (${said}, not stored yet: store it with store_message)`
			: `${a} (${type}, ${said})`;
	});
	return `${task.id} ${task.title}: ${task.goal}\n  Inputs: ${inputs.length === 0 ? "none" : inputs.join(", ")}. Priority ${task.priority}, TAT ${task.tat_class}.${reviewNote(task, projections)}`;
};

/**
 * What completing one's own Task takes when the Trust tier samples it for
 * Review: complete_task must name a reviewer, and the reviewer rule names
 * the first it allows.
 */
const reviewNote = (task: Task, projections: Projections): string => {
	const { state } = task;
	if (state.tag !== "Assigned" && state.tag !== "InProgress") return "";
	const { tier, sampled } = reviewSampleOf(
		projections.trust,
		state.assignee,
		task.id,
	);
	if (!sampled) return "";
	const reviewer = reviewerOf(projections, state.assignee);
	return `\n  Sampled for Review at ${tier}: complete it with complete_task naming a reviewer${reviewer === undefined ? "" : `, such as ${actorText(reviewer)}`}.`;
};

/** The Tasks assigned to the Agent and the ones it proposed, by live state. */
const tasksByState = (projections: Projections, agent: AgentId): string => {
	const { tasks } = projections.tasks;
	const { proposedBy } = projections.proposals;
	const messages = messagesById(projections);
	const mine = (task: Task) => {
		if ("assignee" in task.state) return task.state.assignee === agent;
		const proposer = proposedBy.get(task.id);
		return proposer?.tag === "Agent" && proposer.id === agent;
	};
	const byState = LIVE_TAGS.flatMap((tag) => {
		const inState = [...tasks.values()].filter(
			(t) => t.state.tag === tag && mine(t),
		);
		return inState.length === 0
			? []
			: [
					`${tag}:\n${list(inState.map((t) => taskLine(t, projections, messages)))}`,
				];
	});
	return byState.length === 0 ? "None." : byState.join("\n\n");
};

const work = (
	projections: Projections,
	agent: AgentId,
	role: AgentDefinition["role"],
	since: number,
	now: Date,
): string => {
	const self = { tag: "Agent", id: agent } as const;
	const rooms = new Set(
		roomsOf(projections.rooms, projections.org, self).map((r) => r.id),
	);
	const messages = projections.rooms.messages
		.filter((m) => m.seq > since && rooms.has(m.room_id))
		.map((m) => `seq ${m.seq}, ${m.room_id}, ${actorText(m.actor)}: ${m.body}`);
	const help = [...projections.tasks.help.entries()].flatMap(
		([task_id, requests]) => {
			const state = projections.tasks.tasks.get(task_id)?.state.tag;
			const live = (LIVE_TAGS as readonly string[]).includes(state ?? "");
			return live
				? requests
						.filter((r) => r.to.tag === "Agent" && r.to.id === agent)
						.map((r) => `${r.from} on ${task_id}: ${r.question}`)
				: [];
		},
	);
	const gates = [...projections.gates.gates.values()]
		.filter((g) => g.requester.tag === "Agent" && g.requester.id === agent)
		.map(
			(g) =>
				`${g.id} ${g.kind}${g.task_id === undefined ? "" : ` on ${g.task_id}`}: ${gateState(g, now)}`,
		);
	const coaching = (projections.training.coaching.get(agent) ?? [])
		.filter((c) => c.seq > since)
		.map(
			(c) => `${c.task_id === undefined ? "" : `On ${c.task_id}: `}${c.note}`,
		);
	const parts = [
		section("Your Tasks", tasksByState(projections, agent)),
		section("Messages in your Rooms since your last Turn", list(messages)),
		section("Help requests addressed to you", list(help)),
		section("Gates you requested", list(gates)),
		section("Coaching from the Operator since your last Turn", list(coaching)),
	];
	if (role === "Director") {
		const proposed = new Set(
			[...projections.tasks.tasks.values()].flatMap((t) => t.inputs),
		);
		const forms = [...projections.artifacts.artifacts.values()]
			.filter(
				(a) => a.artifact_type === "SubmissionForm" && !proposed.has(a.id),
			)
			.map((a) => `${a.id}${a.filename === undefined ? "" : ` ${a.filename}`}`);
		parts.push(
			section("Submission Forms no Task has been proposed for", list(forms)),
			section(
				`The Operator's Messages in ${LAB_ROOM.id} since your last Turn`,
				`${RECEIVING_WORK}\n\n${list(
					[...messagesById(projections)]
						.filter(([, m]) => m.seq > since && m.room_id === LAB_ROOM.id)
						.map(([id, m]) => `seq ${m.seq}, Artifact ${id}: ${m.body}`),
				)}`,
			),
		);
	}
	return [
		"Act on the work below with your Tools, within your Charter. When you have done what you can this Turn, stop.",
		...parts,
	].join("\n\n");
};

/**
 * The prompt of the open Turn `turn`, from the Projections as they stand.
 * Messages and Coaching count from the Agent's previous Turn's start, so a
 * Message sent during that Turn is shown again; none is lost.
 */
export const turnPrompt = (
	projections: Projections,
	turn: TurnRecord,
	now: Date,
): TurnPrompt => {
	const { agent } = turn.started;
	const definition = projections.org.agents.get(agent)?.definition;
	if (definition === undefined) throw new Error(`${agent} is not in the Org`);
	const previous = [...projections.turns.turns.values()]
		.filter((t) => t.started.agent === agent && t.seq < turn.seq)
		.at(-1);
	return {
		standing: standing(projections, definition),
		work: work(projections, agent, definition.role, previous?.seq ?? 0, now),
	};
};
