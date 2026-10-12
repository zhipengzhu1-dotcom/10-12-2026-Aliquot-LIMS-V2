import { describe, expect, it } from "vitest";
import { AgentId } from "../ids.js";
import type { Mood, Vitality } from "../types/vitality.js";
import { MOOD_RULES, moodOf } from "./mood.js";

const calm: Vitality = {
	agent: AgentId.parse("A-rin"),
	load: 0,
	fatigue: 0,
	friction: 0,
	confidence: 1,
	morale: 0,
};

type Row = {
	order: number;
	mood: Mood;
	why: string;
	v: Partial<Vitality>;
	rest?: boolean;
	inProgress?: boolean;
};

// docs/design/vitality-and-merit.md, "Mood comes from thresholds". Each row
// sits on the boundary of its own rule and matches no earlier rule.
const rows: Row[] = [
	{ order: 1, mood: "resting", why: "Rest in effect", v: {}, rest: true },
	{ order: 2, mood: "overloaded", why: "load >= 1.0", v: { load: 1.0 } },
	{ order: 2, mood: "overloaded", why: "fatigue >= 0.8", v: { fatigue: 0.8 } },
	{
		order: 3,
		mood: "discouraged",
		why: "morale < -0.2 and confidence < 0.6",
		v: { morale: -0.21, confidence: 0.59 },
	},
	{ order: 4, mood: "strained", why: "load >= 0.7", v: { load: 0.7 } },
	{ order: 4, mood: "strained", why: "friction >= 0.3", v: { friction: 0.3 } },
	{ order: 4, mood: "strained", why: "fatigue >= 0.6", v: { fatigue: 0.6 } },
	{
		order: 5,
		mood: "focused",
		why: "a Task InProgress",
		v: {},
		inProgress: true,
	},
	{ order: 6, mood: "fresh", why: "no earlier rule", v: {} },
];

describe("moodOf", () => {
	it.each(rows)("rule $order: $why gives $mood", (row) => {
		const input = {
			v: { ...calm, ...row.v },
			restInEffect: row.rest ?? false,
			hasTaskInProgress: row.inProgress ?? false,
		};
		const earlier = MOOD_RULES.slice(0, row.order - 1);
		expect(MOOD_RULES[row.order - 1]?.mood).toBe(row.mood);
		expect(earlier.filter((r) => r.when(input)).map((r) => r.mood)).toEqual([]);
		expect(moodOf(input.v, input.restInEffect, input.hasTaskInProgress)).toBe(
			row.mood,
		);
	});

	it.each([
		{ why: "load just under 1.0", v: { load: 0.99 }, mood: "strained" },
		{ why: "fatigue just under 0.8", v: { fatigue: 0.79 }, mood: "strained" },
		{ why: "fatigue just under 0.6", v: { fatigue: 0.59 }, mood: "fresh" },
		{ why: "load just under 0.7", v: { load: 0.69 }, mood: "fresh" },
		{ why: "friction just under 0.3", v: { friction: 0.29 }, mood: "fresh" },
		{
			why: "morale exactly -0.2",
			v: { morale: -0.2, confidence: 0.1 },
			mood: "fresh",
		},
		{
			why: "confidence exactly 0.6",
			v: { morale: -5, confidence: 0.6 },
			mood: "fresh",
		},
	] satisfies { why: string; v: Partial<Vitality>; mood: Mood }[])(
		"$why gives $mood",
		({ v, mood }) => {
			expect(moodOf({ ...calm, ...v }, false, false)).toBe(mood);
		},
	);

	it("takes the first matching rule when several match", () => {
		const everything: Vitality = {
			...calm,
			load: 2,
			fatigue: 2,
			friction: 1,
			confidence: 0,
			morale: -3,
		};
		expect(moodOf(everything, true, true)).toBe("resting");
		expect(moodOf(everything, false, true)).toBe("overloaded");
		expect(
			moodOf({ ...everything, load: 0.9, fatigue: 0.7 }, false, true),
		).toBe("discouraged");
		expect(
			moodOf(
				{ ...everything, load: 0.9, fatigue: 0.7, confidence: 0.6 },
				false,
				true,
			),
		).toBe("strained");
	});
});
