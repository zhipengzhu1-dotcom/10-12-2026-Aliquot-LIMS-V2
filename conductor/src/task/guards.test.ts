import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId, ArtifactId, type TaskId } from "../ids.js";
import { fold } from "../reduce.js";
import type { Actor } from "../types/actor.js";
import { type Scenario, scenario, scores } from "../vitality/scenario.js";
import { TaskProjection } from "./projection.js";

const rin = AgentId.parse("A-rin");
const pia: Actor = { tag: "Agent", id: AgentId.parse("A-pia") };
const operator: Actor = { tag: "Operator" };
const output = ArtifactId.parse("a".repeat(64));

let s: Scenario;
beforeEach(() => {
	s = scenario();
});
afterEach(() => s.close());

const stateOf = (id: TaskId) =>
	fold(s.events(), TaskProjection.reduce, TaskProjection.init).tasks.get(id)
		?.state.tag;

const complete = (
	id: TaskId,
	review: { tag: "Skipped"; reason: string } | { tag: "Reviewed" },
	actor: Actor,
) =>
	s.append({
		actor,
		task_id: id,
		kind: "TaskCompleted",
		payload: { task_id: id, outputs: [output], review },
	});

const skip = (id: TaskId) =>
	complete(
		id,
		{ tag: "Skipped", reason: "not sampled" },
		{ tag: "Agent", id: rin },
	);

describe("Review skipping follows the Trust tier", () => {
	it("refuses to skip Review for an Agent on Probation", () => {
		const t = s.task(rin);

		expect(() => skip(t)).toThrow(
			"TaskCompleted (review Skipped) refused: A-rin is on Probation; every Task is reviewed",
		);
		expect(stateOf(t)).toBe("InProgress");
	});

	it("skips a Trusted Agent's Task the sample does not pick, and refuses one it picks", () => {
		for (let i = 0; i < 10; i++) s.reviewed(rin, scores(3));
		const unsampled = s.task(rin); // T-11: not 1 in 3
		skip(unsampled);
		for (let i = 0; i < 3; i++) s.task(rin, { start: false });
		const sampled = s.task(rin); // T-15: 1 in 3

		expect(unsampled).toBe("T-11");
		expect(stateOf(unsampled)).toBe("Done");
		expect(sampled).toBe("T-15");
		expect(() => skip(sampled)).toThrow(
			"TaskCompleted (review Skipped) refused: A-rin is Trusted, and T-15 is one of the 1 in 3 Tasks sampled for Review",
		);
	});
});

describe("Completing a Task after Review", () => {
	it("needs a Review by the named reviewer, completed by that reviewer", () => {
		const t = s.task(rin);
		s.submit(rin, t, pia);
		const reviewed = (actor: Actor) => complete(t, { tag: "Reviewed" }, actor);

		expect(() => reviewed(pia)).toThrow(
			"TaskCompleted (review Reviewed) refused: T-1 has no Review by A-pia, its reviewer",
		);
		s.review(t, scores(3), operator);
		expect(() => reviewed(pia)).toThrow(/T-1 has no Review by A-pia/);
		s.review(t, scores(3), pia);
		expect(() => reviewed(operator)).toThrow(
			"TaskCompleted (review Reviewed) refused: only A-pia, the reviewer of T-1, completes it after Review; the actor is Operator",
		);
		expect(stateOf(t)).toBe("UnderReview");

		reviewed(pia);
		expect(stateOf(t)).toBe("Done");
	});
});
