import { describe, expect, it } from "vitest";
import type { Mood, Policy } from "../types/vitality.js";
import { policyOf } from "./policy.js";

const off: Policy = {
	mayAcceptTasks: false,
	mayOfferHelp: false,
	mustHandOff: false,
	mustRequestHelp: false,
	mustNameBlocker: false,
	schedulable: true,
};

// docs/design/vitality-and-merit.md, "Policy follows from Mood".
const rows: { mood: Mood; policy: Policy }[] = [
	{
		mood: "fresh",
		policy: { ...off, mayAcceptTasks: true, mayOfferHelp: true },
	},
	{
		mood: "focused",
		policy: { ...off, mayAcceptTasks: true, mayOfferHelp: true },
	},
	{ mood: "strained", policy: { ...off, mustNameBlocker: true } },
	{ mood: "overloaded", policy: { ...off, mustHandOff: true } },
	{ mood: "discouraged", policy: { ...off, mustRequestHelp: true } },
	{ mood: "resting", policy: { ...off, schedulable: false } },
];

describe("policyOf", () => {
	it.each(rows)("$mood", ({ mood, policy }) => {
		expect(policyOf(mood)).toEqual(policy);
	});

	it("makes only a resting Agent unschedulable", () => {
		const unschedulable = rows
			.map((r) => r.mood)
			.filter((m) => !policyOf(m).schedulable);
		expect(unschedulable).toEqual(["resting"]);
	});
});
