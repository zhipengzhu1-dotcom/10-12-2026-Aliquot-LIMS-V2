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
