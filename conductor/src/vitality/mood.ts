import type { Mood, Vitality } from "../types/vitality.js";

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
