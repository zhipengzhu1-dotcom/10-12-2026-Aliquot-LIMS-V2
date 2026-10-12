import type { Event } from "../events.js";
import type { AgentId } from "../ids.js";
import { fold, type Projection } from "../reduce.js";
import type { AgentDefinition } from "../types/agent-definition.js";

/** One Agent as the Org Projection sees it: its current definition and status. */
export type AgentState = {
	readonly definition: AgentDefinition;
	readonly paused: boolean;
	readonly retired: boolean;
};

/** Every Agent ever recruited, in Recruitment order. Retired Agents stay. */
export type OrgState = {
	readonly agents: ReadonlyMap<AgentId, AgentState>;
};

const withAgent = (
	state: OrgState,
	id: AgentId,
	change: (agent: AgentState) => AgentState,
): OrgState => {
	const agent = state.agents.get(id);
	if (agent === undefined) return state;
	return { agents: new Map(state.agents).set(id, change(agent)) };
};

export const OrgProjection: Projection<OrgState> = {
	init: { agents: new Map() },
	reduce: (state, event) => {
		switch (event.kind) {
			case "AgentRecruited":
				return {
					agents: new Map(state.agents).set(event.payload.id, {
						definition: event.payload,
						paused: false,
						retired: false,
					}),
				};
			case "AgentDefinitionRevised": {
				const { definition } = event.payload;
				return withAgent(state, definition.id, (a) => ({ ...a, definition }));
			}
			case "AgentPaused":
				return withAgent(state, event.payload.agent_id, (a) => ({
					...a,
					paused: true,
				}));
			case "AgentResumed":
				return withAgent(state, event.payload.agent_id, (a) => ({
					...a,
					paused: false,
				}));
			case "AgentRetired":
				return withAgent(state, event.payload.agent_id, (a) => ({
					...a,
					retired: true,
				}));
			default:
				return state;
		}
	},
};

export const orgState = (events: Iterable<Event>): OrgState =>
	fold(events, OrgProjection.reduce, OrgProjection.init);

/** The reporting tree: the Operator at the root, live Agents below. */
export type OrgNode =
	| { readonly tag: "Operator"; readonly children: readonly OrgNode[] }
	| {
			readonly tag: "Agent";
			readonly agent: AgentState;
			readonly children: readonly OrgNode[];
	  };

/**
 * Build the reporting tree from live Agents, in Recruitment order. Retired
 * Agents are left out. The Specialists are one pool under every Supervisor,
 * so each Specialist appears under each live Supervisor. Any other Agent sits
 * under its `supervisor_id`, or under the Operator when it has none or its
 * supervisor is not live.
 */
export const tree = (state: OrgState): OrgNode => {
	const live = [...state.agents.values()].filter((a) => !a.retired);
	const liveIds = new Set(live.map((a) => a.definition.id));
	const supervisors = live.filter((a) => a.definition.role === "Supervisor");

	const parentsOf = (agent: AgentState): readonly (AgentId | "Operator")[] => {
		const { role, supervisor_id } = agent.definition;
		if (role === "Specialist" && supervisors.length > 0) {
			return supervisors.map((s) => s.definition.id);
		}
		return supervisor_id !== undefined && liveIds.has(supervisor_id)
			? [supervisor_id]
			: ["Operator"];
	};

	const childrenOf = (parent: AgentId | "Operator"): OrgNode[] =>
		live
			.filter((a) => parentsOf(a).includes(parent))
			.map((agent) => ({
				tag: "Agent",
				agent,
				children: childrenOf(agent.definition.id),
			}));

	return { tag: "Operator", children: childrenOf("Operator") };
};

const label = (node: OrgNode) => {
	if (node.tag === "Operator") return "Operator";
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
