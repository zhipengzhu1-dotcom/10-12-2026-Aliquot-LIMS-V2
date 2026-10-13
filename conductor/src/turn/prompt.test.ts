import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId, RoomId, Sha256 } from "../ids.js";
import { open, say } from "../room/lifecycle.js";
import { store } from "../sandbox/lifecycle.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import { giveCoaching } from "../training/lifecycle.js";
import type { Actor } from "../types/actor.js";
import { finishTurn, startTurn } from "./lifecycle.js";
import { NO_USAGE } from "./model.js";
import { turnPrompt } from "./prompt.js";

const rin = AgentId.parse("A-rin");
const odile = AgentId.parse("A-odile");
const operator: Actor = { tag: "Operator" };
const lab = RoomId.parse("RM-lab");

let s: Scenario;
beforeEach(() => {
	s = scenario();
	open(s.ledger, {
		id: lab,
		name: "Lab",
		purpose: "The whole lab",
		membership: { tag: "Everyone" },
		opened_by: operator,
	});
});
afterEach(() => s.close());

const start = (agent: AgentId) =>
	startTurn(s.ledger, {
		agent,
		model: "claude-sonnet-5-5",
		energyBudgetTokens: 1_000_000,
	}).turn;

const promptOf = (agent: AgentId) => {
	const { standing, work } = turnPrompt(
		s.ledger.projections,
		start(agent),
		s.now(),
	);
	return `${standing}\n\n${work}`;
};

const count = (text: string, part: string) => text.split(part).length - 1;

describe("the prompt of a Turn", () => {
	it("renders a seeded Agent's Task, Message and Coaching once each, in that order, after its Charter and Mood", () => {
		const task_id = s.task(rin);
		say(s.ledger, {
			actor: operator,
			room_id: lab,
			body: "The balance on bench 2 is calibrated.",
		});
		giveCoaching(s.ledger, {
			actor: operator,
			agent_id: rin,
			note: "Name the Lot in every Message.",
		});

		const prompt = promptOf(rin);

		const parts = [
			"You are Rin (A-rin), the Specialist",
			"## Charter",
			"Your Mood is focused.",
			"You may accept new Tasks.",
			`${task_id} Task 1: Do the work`,
			"RM-lab, Operator: The balance on bench 2 is calibrated.",
			"Name the Lot in every Message.",
		];
		for (const part of parts) {
			expect(count(prompt, part), `${part} appears once`).toBe(1);
		}
		const at = parts.map((part) => prompt.indexOf(part));
		expect(at, "each part follows the one before").toEqual(
			[...at].sort((a, b) => a - b),
		);
	});

	it("shows only the Messages and Coaching recorded since the Agent's previous Turn started", () => {
		say(s.ledger, { actor: operator, room_id: lab, body: "First word." });
		giveCoaching(s.ledger, { actor: operator, agent_id: rin, note: "Old." });
		const first = start(rin);
		finishTurn(s.ledger, {
			turn_id: first.started.turn_id,
			usage: NO_USAGE,
			outcome: { tag: "Completed" },
			tool_calls: 0,
		});
		say(s.ledger, { actor: operator, room_id: lab, body: "Second word." });
		giveCoaching(s.ledger, { actor: operator, agent_id: rin, note: "New." });

		const prompt = promptOf(rin);

		expect(prompt).toContain("RM-lab, Operator: Second word.");
		expect(prompt).toContain("- New.");
		expect(prompt).not.toContain("First word.");
		expect(prompt).not.toContain("- Old.");
	});

	it("names the Policy the Mood gives in words, from the Turn's TurnStarted", () => {
		const prompt = promptOf(rin);

		expect(prompt).toContain("Your Mood is fresh.");
		expect(prompt).toContain("You may offer help to other Agents.");
		expect(prompt).not.toContain("You must");
	});

	it("lists for the Director the Submission Forms no Task has been proposed for, and its refused Tools", () => {
		const { artifact } = store(
			s.ledger,
			{ actor: operator },
			{
				sha256: Sha256.parse("c".repeat(64)),
				media_type: "application/octet-stream",
				artifact_type: "SubmissionForm",
				produced_by: operator,
				lineage: [],
			},
		);

		const director = promptOf(odile);
		const specialist = promptOf(rin);

		expect(director).toContain(
			`## Submission Forms no Task has been proposed for\n\n- ${artifact.id}`,
		);
		expect(director).toContain(
			"run_script: refused, your Charter forbids RunScript",
		);
		expect(specialist).not.toContain("Submission Forms no Task");
		expect(specialist).not.toContain(artifact.id);
	});
});
