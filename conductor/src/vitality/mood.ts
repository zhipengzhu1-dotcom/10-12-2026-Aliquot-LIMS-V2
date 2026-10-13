import type { AgentId } from "../ids.js";
import type { Projections } from "../projections.js";
import type { Mood, Vitality } from "../types/vitality.js";
import { restInEffect } from "./vitality.js";
import { openTasks } from "./work.js";

export type MoodInput = {
	readonly v: Vitality;
	readonly restInEffect: boolean;
	readonly hasTaskInProgress: boolean;
};

/**
 * The Mood table of docs/design/vitality-and-merit.md, in order. The first
 * rule that matches sets the Mood; the last always matches.
 */
export const MOOD_RULES: readonly {
	readonly mood: Mood;
	readonly when: (input: MoodInput) => boolean;
}[] = [
	{ mood: "resting", when: ({ restInEffect }) => restInEffect },
	{
		mood: "overloaded",
		when: ({ v }) => v.load >= 1.0 || v.fatigue >= 0.8,
	},
	{
		mood: "discouraged",
		when: ({ v }) => v.morale < -0.2 && v.confidence < 0.6,
	},
	{
		mood: "strained",
		when: ({ v }) => v.load >= 0.7 || v.friction >= 0.3 || v.fatigue >= 0.6,
	},
	{ mood: "focused", when: ({ hasTaskInProgress }) => hasTaskInProgress },
	{ mood: "fresh", when: () => true },
];

export const moodOf = (
	v: Vitality,
	restInEffect: boolean,
	hasTaskInProgress: boolean,
): Mood => {
	const input = { v, restInEffect, hasTaskInProgress };
	return MOOD_RULES.find((rule) => rule.when(input))?.mood ?? "fresh";
};

/** What `sampleVitality` gives an Agent with no work, no Turns and no Reviews. */
const unsampled = (agent: AgentId): Vitality => ({
	agent,
	load: 0,
	fatigue: 0,
	friction: 0,
	confidence: 1,
	morale: 0,
});

/**
 * The Mood of `agent` as the Ledger stands: its latest VitalitySampled, with
 * Rest and Tasks InProgress read now. A guard reads no clock, so it cannot
 * take a sample; an Agent never sampled reads as one with no work, which is
 * `fresh` unless Rest or a Task InProgress says otherwise.
 */
export const currentMood = (projections: Projections, agent: AgentId): Mood =>
	moodOf(
		projections.work.samples.get(agent) ?? unsampled(agent),
		restInEffect(projections.work, agent),
		openTasks(projections.tasks, agent).inProgress > 0,
	);
