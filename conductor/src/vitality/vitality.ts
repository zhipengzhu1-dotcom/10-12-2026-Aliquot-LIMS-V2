import type { Event } from "../events.js";
import type { AgentId } from "../ids.js";
import { orgState } from "../org/projection.js";
import type { Vitality } from "../types/vitality.js";
import { openTasks } from "./tasks.js";

export type SampleOptions = {
	readonly now: Date;
	/** Tokens per 5-hour window for the whole society, set by the Operator. */
	readonly energyBudgetTokens: number;
	/**
	 * Tokens the Agent used in the rolling 5-hour window. No Event carries
	 * token use yet; from slice 1 the Conductor supplies it from each Turn's
	 * `modelUsage`. Defaults to 0.
	 */
	readonly tokensUsedInWindow?: number;
};

/** The latest RestOrdered for the Agent is a `begin`. */
export const restInEffect = (
	events: Iterable<Event>,
	agent: AgentId,
): boolean => {
	let resting = false;
	for (const e of events) {
		if (e.kind === "RestOrdered" && e.payload.agent_id === agent) {
			resting = e.payload.action === "begin";
		}
	}
	return resting;
};

/**
 * Compute a Vitality sample from Events already in the Ledger, per the Field
 * table of docs/design/vitality-and-merit.md.
 */
export const sampleVitality = (
	events: readonly Event[],
	agent: AgentId,
	options: SampleOptions,
): Vitality => {
	const org = orgState(events);
	const definition = org.agents.get(agent)?.definition;
	if (definition === undefined) throw new Error(`${agent} is not in the Org`);
	if (!(options.energyBudgetTokens > 0)) {
		throw new Error(
			`the Energy budget must be a positive number of tokens, not ${options.energyBudgetTokens}`,
		);
	}
	const notResting = [...org.agents.values()].filter(
		(a) => !a.retired && !restInEffect(events, a.definition.id),
	).length;
	const share = options.energyBudgetTokens / Math.max(1, notResting);
	return {
		agent,
		load: openTasks(events, agent).open / definition.capacity,
		fatigue: (options.tokensUsedInWindow ?? 0) / share,
		friction: 0,
		confidence: 1,
		morale: 0,
	};
};
