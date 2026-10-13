import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendRefused } from "../append-guard.js";
import { AgentId, TaskId } from "../ids.js";
import { type Scenario, scenario, scores } from "../test-support/scenario.js";
import type { Actor } from "../types/actor.js";

const rin = AgentId.parse("A-rin");
const thorne: Actor = { tag: "Agent", id: AgentId.parse("A-thorne") };
const asRin: Actor = { tag: "Agent", id: rin };

let s: Scenario;
beforeEach(() => {
	s = scenario();
});
afterEach(() => s.close());

describe("ReviewRecorded", () => {
	it("is refused for a Task that does not exist", () => {
		expect(() => s.review(TaskId.parse("T-9"), scores(3))).toThrow(
			new AppendRefused("ReviewRecorded refused: T-9 does not exist"),
		);
	});

	it("is refused for a Task that is not completed", () => {
		const t = s.task(rin);
		expect(() => s.review(t, scores(3))).toThrow(
			new AppendRefused(
				`ReviewRecorded refused: ${t} is InProgress; only an UnderReview or Done Task gets a Review`,
			),
		);
	});

	it("is refused when the assignee reviews its own Task", () => {
		const t = s.submitted(rin);
		expect(() => s.review(t, scores(3), asRin)).toThrow(
			new AppendRefused(
				`ReviewRecorded refused: A-rin is the assignee of ${t} and cannot review it`,
			),
		);
	});

	it("is refused when the reviewer is not the actor recording it", () => {
		const t = s.submitted(rin);
		expect(() =>
			s.ledger.append({
				actor: { tag: "Operator" },
				kind: "ReviewRecorded",
				payload: { task_id: t, reviewer: thorne, ...scores(3), note: "" },
			}),
		).toThrow(
			new AppendRefused(
				"ReviewRecorded refused: the reviewer A-thorne is not the actor Operator",
			),
		);
	});

	it("accepts a Review of an UnderReview Task, and the Auditor's of a Done one", () => {
		const t = s.reviewed(rin, scores(3));
		expect(() => s.review(t, scores(2), thorne)).not.toThrow();
	});
});
