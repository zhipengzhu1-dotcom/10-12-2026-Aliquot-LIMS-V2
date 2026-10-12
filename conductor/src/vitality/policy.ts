import type { Mood, Policy } from "../types/vitality.js";

const nothing: Policy = {
	mayAcceptTasks: false,
	mayOfferHelp: false,
	mustHandOff: false,
	mustRequestHelp: false,
	mustNameBlocker: false,
	schedulable: true,
};

const normal: Policy = { ...nothing, mayAcceptTasks: true, mayOfferHelp: true };

/** The Policy table of docs/design/vitality-and-merit.md, one row per Mood. */
export const POLICY_TABLE: Readonly<Record<Mood, Policy>> = {
	fresh: normal,
	focused: normal,
	// Finish current Tasks, accept no new ones; the next message names the blocker.
	strained: { ...nothing, mustNameBlocker: true },
	// Nothing new; hand off the lowest-priority open Task.
	overloaded: { ...nothing, mustHandOff: true },
	// Nothing until it sends a Help request.
	discouraged: { ...nothing, mustRequestHelp: true },
	// The Conductor schedules no Turns.
	resting: { ...nothing, schedulable: false },
};

export const policyOf = (m: Mood): Policy => POLICY_TABLE[m];
