import { type AppendGuard, AppendRefused } from "../append-guard.js";
import type { AgentId } from "../ids.js";
import type { Actor } from "../types/actor.js";
import { type AgentState, type OrgState, orgState } from "./projection.js";

const who = (actor: Actor) =>
	actor.tag === "Operator" ? "Operator" : actor.id;

const existing = (state: OrgState, id: AgentId): AgentState => {
	const agent = state.agents.get(id);
	if (agent === undefined) throw new AppendRefused(`${id} is not in the Org`);
	return agent;
};

const live = (state: OrgState, id: AgentId): AgentState => {
	const agent = existing(state, id);
	if (agent.retired) {
		throw new AppendRefused(
			`${id} is Retired; its status can no longer change`,
		);
	}
	return agent;
};

/**
 * Org rules at append. Revisions follow ADR-0005: one version at a time, and
 * only the Operator revises the Auditor.
 */
const orgGuard: AppendGuard = (ctx, event) => {
	switch (event.kind) {
		case "AgentRecruited": {
			const { id } = event.payload;
			if (orgState(ctx.events).agents.has(id)) {
				throw new AppendRefused(
					`${id} is already in the Org; change it with a Revision`,
				);
			}
			return;
		}
		case "AgentDefinitionRevised": {
			const { definition } = event.payload;
			const current = existing(orgState(ctx.events), definition.id).definition;
			if (current.role === "Auditor" && event.actor.tag !== "Operator") {
				throw new AppendRefused(
					`the Auditor can only be revised by the Operator; ${who(event.actor)} tried to revise ${current.id} (${current.name}, version ${current.version})`,
				);
			}
			if (definition.version !== current.version + 1) {
				throw new AppendRefused(
					`Revision to version ${definition.version} refused: ${current.id} is at version ${current.version}; the next must be ${current.version + 1}`,
				);
			}
			return;
		}
		case "AgentPaused":
		case "AgentRetired":
			live(orgState(ctx.events), event.payload.agent_id);
			return;
		case "AgentResumed": {
			const { agent_id } = event.payload;
			if (!live(orgState(ctx.events), agent_id).paused) {
				throw new AppendRefused(`${agent_id} is not paused`);
			}
			return;
		}
		default:
			return;
	}
};

export const orgGuards: readonly AppendGuard[] = [orgGuard];
