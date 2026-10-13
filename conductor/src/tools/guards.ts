import type { AppendGuard } from "../append-guard.js";
import { notInOrg } from "../org/projection.js";
import { actorText } from "../types/actor.js";

/**
 * A refused Tool call is the Conductor's own act (ADR-0013): no one else
 * records one, and it names an Agent in the Org.
 */
const refusals: AppendGuard = (projections, event) => {
	if (event.kind !== "ActionRefused") return undefined;
	const { agent, tool } = event.payload;
	if (event.actor.tag !== "Conductor") {
		return `only the Conductor records a refused Tool call; ${actorText(event.actor)} tried to record ${agent}'s ${tool}`;
	}
	return projections.org.agents.has(agent) ? undefined : notInOrg(agent);
};

export const toolGuards: readonly AppendGuard[] = [refusals];
