import type { AgentId, Seq } from "../ids.js";
import { type Projection, Refusal } from "../reduce.js";
import type { AgentDefinition } from "../types/agent-definition.js";

/**
 * One Agent as the Org Projection sees it: its current definition, its
 * status, and the seq of its latest Org Event.
 */
export type AgentState = {
	readonly definition: AgentDefinition;
	readonly paused: boolean;
	readonly retired: boolean;
	readonly lastSeq: Seq;
};

/** Every Agent ever recruited, in Recruitment order. Retired Agents stay. */
export type OrgState = {
	readonly agents: ReadonlyMap<AgentId, AgentState>;
};

const withAgent = (
	state: OrgState,
	id: AgentId,
	lastSeq: Seq,
	change: (agent: AgentState) => Omit<AgentState, "lastSeq">,
): OrgState | Refusal => {
	const agent = state.agents.get(id);
	if (agent === undefined) return new Refusal(notInOrg(id));
	return {
		agents: new Map(state.agents).set(id, { ...change(agent), lastSeq }),
	};
};

export const notInOrg = (id: AgentId) => `${id} is not in the Org`;

export const OrgProjection: Projection<OrgState> = {
	init: { agents: new Map() },
	reduce: (state, event) => {
		switch (event.kind) {
			case "AgentRecruited": {
				const { id } = event.payload;
				if (state.agents.has(id)) {
					return new Refusal(
						`${id} is already in the Org; change it with a Revision`,
					);
				}
				return {
					agents: new Map(state.agents).set(id, {
						definition: event.payload,
						paused: false,
						retired: false,
						lastSeq: event.seq,
					}),
				};
			}
			case "AgentDefinitionRevised": {
				const { definition } = event.payload;
				return withAgent(state, definition.id, event.seq, (a) => ({
					...a,
					definition,
				}));
			}
			case "AgentPaused":
				return withAgent(state, event.payload.agent_id, event.seq, (a) => ({
					...a,
					paused: true,
				}));
			case "AgentResumed":
				return withAgent(state, event.payload.agent_id, event.seq, (a) => ({
					...a,
					paused: false,
				}));
			case "AgentRetired":
				return withAgent(state, event.payload.agent_id, event.seq, (a) => ({
					...a,
					retired: true,
				}));
			default:
				return state;
		}
	},
};

/**
 * The definitions `after` holds at a later version than `before`, in
 * Recruitment order: the Revisions written between the two.
 */
export const revisedBetween = (
	before: OrgState,
	after: OrgState,
): AgentDefinition[] =>
	[...after.agents.values()]
		.map((a) => a.definition)
		.filter(
			(d) => d.version > (before.agents.get(d.id)?.definition.version ?? 0),
		);

/**
 * The reporting tree: the Operator at the root, live Agents below, and the
 * Specialists as one pool node that reports to every live Supervisor.
 */
export type OrgNode =
	| { readonly tag: "Operator"; readonly children: readonly OrgNode[] }
	| {
			readonly tag: "Agent";
			readonly agent: AgentState;
			readonly children: readonly OrgNode[];
	  }
	| {
			readonly tag: "Pool";
			readonly supervisors: readonly AgentState[];
			readonly children: readonly OrgNode[];
	  };

/**
 * Build the reporting tree from live Agents, in Recruitment order. Retired
 * Agents are left out. The Specialists are one pool that reports to every
 * live Supervisor, so they appear once, in a pool node beside the
 * Supervisors under their parent (the Director). Any other Agent sits under
 * its `supervisor_id`, or under the Operator when it has none or its
 * supervisor is not live; so do the Specialists when no Supervisor is live.
 */
export const tree = (state: OrgState): OrgNode => {
	const live = [...state.agents.values()].filter((a) => !a.retired);
	const liveIds = new Set(live.map((a) => a.definition.id));
	const supervisors = live.filter((a) => a.definition.role === "Supervisor");
	const pool =
		supervisors.length === 0
			? []
			: live.filter((a) => a.definition.role === "Specialist");

	const parentOf = (agent: AgentState): AgentId | "Operator" => {
		const { supervisor_id } = agent.definition;
		return supervisor_id !== undefined && liveIds.has(supervisor_id)
			? supervisor_id
			: "Operator";
	};
	const [firstSupervisor] = supervisors;
	const poolParent = firstSupervisor && parentOf(firstSupervisor);

	const nodeOf = (agent: AgentState): OrgNode => ({
		tag: "Agent",
		agent,
		children: childrenOf(agent.definition.id),
	});
	const childrenOf = (parent: AgentId | "Operator"): OrgNode[] => {
		const agents = live
			.filter((a) => !pool.includes(a) && parentOf(a) === parent)
			.map(nodeOf);
		if (parent !== poolParent || pool.length === 0) return agents;
		return [
			...agents,
			{ tag: "Pool", supervisors, children: pool.map(nodeOf) },
		];
	};

	return { tag: "Operator", children: childrenOf("Operator") };
};

const andList = (names: readonly string[]) =>
	names.length <= 1
		? names.join("")
		: `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

const label = (node: OrgNode) => {
	if (node.tag === "Operator") return "Operator";
	if (node.tag === "Pool") {
		return `Specialist pool, reports to ${andList(node.supervisors.map((s) => s.definition.name))}`;
	}
	const { definition, paused } = node.agent;
	const line = `${definition.name}, ${definition.role}, ${definition.trust_tier}`;
	return paused ? `${line} (paused)` : line;
};

/** Print the tree in ASCII, one node per line, children indented under their parent. */
export const renderTree = (root: OrgNode): string => {
	const lines = [label(root)];
	const walk = (node: OrgNode, indent: string) => {
		node.children.forEach((child, i) => {
			const last = i === node.children.length - 1;
			lines.push(`${indent}${last ? "\\-- " : "+-- "}${label(child)}`);
			walk(child, `${indent}${last ? "    " : "|   "}`);
		});
	};
	walk(root, "");
	return `${lines.join("\n")}\n`;
};
