import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendRefused } from "../append-guard.js";
import { AgentId, TaskId } from "../ids.js";
import type { Actor } from "../types/actor.js";
import { type Scenario, scenario, scores } from "./scenario.js";

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
		const t = s.task(rin);
		s.submit(rin, t);
		expect(() => s.review(t, scores(3), asRin)).toThrow(
			new AppendRefused(
				`ReviewRecorded refused: A-rin is the assignee of ${t} and cannot review it`,
			),
		);
	});

	it("is refused when the reviewer is not the actor recording it", () => {
		const t = s.task(rin);
		s.submit(rin, t);
		expect(() =>
			s.append({
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

describe("RestOrdered", () => {
	const rest = (agent: string, action: "begin" | "end") =>
		s.append({
			actor: { tag: "Operator" },
			kind: "RestOrdered",
			payload: { agent_id: AgentId.parse(agent), action, reason: "fatigue" },
		});

	it("is refused for an Agent not in the Org", () => {
		expect(() => rest("A-nobody", "begin")).toThrow(
			new AppendRefused("RestOrdered refused: A-nobody is not in the Org"),
		);
	});

	it("begins only when no Rest is in effect and ends only when one is", () => {
		expect(() => rest("A-rin", "end")).toThrow(
			new AppendRefused("RestOrdered refused: A-rin is not resting"),
		);
		rest("A-rin", "begin");
		expect(() => rest("A-rin", "begin")).toThrow(
			new AppendRefused("RestOrdered refused: A-rin is already resting"),
		);
		expect(() => rest("A-rin", "end")).not.toThrow();
	});
});
