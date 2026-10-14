import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendRefused } from "../append-guard.js";
import { AgentId, ArtifactId, type Seq, type TaskId } from "../ids.js";
import { type Ledger, openMemoryLedger } from "../ledger.js";
import { pause, resume } from "../org/lifecycle.js";
import { seedOrg } from "../org/seed.js";
import { TEST_OPERATOR } from "../test-support/operator.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import type { Actor } from "../types/actor.js";
import {
	assign,
	block,
	complete,
	escalate,
	fail,
	handOff,
	propose,
	requestHelp,
	review,
	start,
} from "./lifecycle.js";

const operator: Actor = { tag: "Operator" };
const odile = AgentId.parse("A-odile");
const rin = AgentId.parse("A-rin");
const asRin: Actor = { tag: "Agent", id: rin };
const asOdile: Actor = { tag: "Agent", id: odile };
const pia: Actor = { tag: "Agent", id: AgentId.parse("A-pia") };
const thorne: Actor = { tag: "Agent", id: AgentId.parse("A-thorne") };
const output = ArtifactId.parse("c".repeat(64));
const threes = {
	quality: 3,
	traceability: 3,
	boundary_adherence: 3,
	collaboration: 3,
	timeliness: 3,
} as const;

let ledger: Ledger;
beforeEach(() => {
	ledger = openMemoryLedger();
	seedOrg(ledger, TEST_OPERATOR);
});
afterEach(() => ledger.close());

const proposal = {
	actor: operator,
	title: "Parse the Submission Form",
	goal: "Extract every field",
	tat_class: "Regular",
	priority: 1,
} as const;

describe("the Task lifecycle", () => {
	it("names the Task's previous Event as each Event's cause, and the Review as the cause of completing after it, returning each new Task and the seq it appended", () => {
		const cause = ledger.all().at(-1)?.seq as Seq;

		const proposed = propose(ledger, { ...proposal, causation_id: cause });
		const task_id = proposed.task.id;
		const assigned = assign(ledger, {
			actor: operator,
			task_id,
			assignee: odile,
		});
		const started = start(ledger, { actor: asOdile, task_id });
		const submitted = complete(ledger, {
			actor: asOdile,
			task_id,
			outputs: [output],
			reviewer: operator,
		});
		const reviewed = review(ledger, {
			task_id,
			reviewer: operator,
			...threes,
			note: "Clean work",
		});
		const closed = complete(ledger, { actor: operator, task_id });

		expect(task_id).toBe("T-1");
		expect(proposed.task).toMatchObject({
			state: { tag: "Proposed" },
			rubric_id: "default",
		});
		expect(submitted.task.state).toEqual({
			tag: "UnderReview",
			assignee: odile,
			reviewer: operator,
		});
		expect(closed.task).toMatchObject({
			state: { tag: "Done", assignee: odile },
			outputs: [output],
		});
		const recorded = [proposed, assigned, started, submitted, reviewed, closed];
		const bySeq = new Map(ledger.all().map((e) => [e.seq, e]));
		expect(
			recorded.map(({ seq }) => {
				const e = bySeq.get(seq);
				return [e?.kind, e?.task_id, e?.causation_id];
			}),
		).toEqual([
			["TaskProposed", "T-1", cause],
			["TaskAssigned", "T-1", proposed.seq],
			["TaskStarted", "T-1", assigned.seq],
			["TaskCompleted", "T-1", started.seq],
			["ReviewRecorded", "T-1", submitted.seq],
			["TaskCompleted", "T-1", reviewed.seq],
		]);
		expect(
			propose(ledger, proposal).task.id,
			"the next proposal mints the next id",
		).toBe("T-2");
	});
});

/** A Task `agent` starts, so it is InProgress. */
const started = (agent: AgentId): TaskId => {
	const { task } = propose(ledger, proposal);
	assign(ledger, { actor: operator, task_id: task.id, assignee: agent });
	start(ledger, { actor: { tag: "Agent", id: agent }, task_id: task.id });
	return task.id;
};

/**
 * A Specialist `agent` on Probation completes a Task, so the sample picks
 * it, and Pia, a Supervisor, reviews with 3 on every dimension.
 */
const reviewed = (agent: AgentId) => {
	const task_id = started(agent);
	complete(ledger, {
		actor: { tag: "Agent", id: agent },
		task_id,
		reviewer: pia,
	});
	review(ledger, { task_id, reviewer: pia, ...threes, note: "" });
	complete(ledger, { actor: pia, task_id });
};

describe("completing a Task decides its own Review", () => {
	it("refuses a Task sampled for Review that names no reviewer, saying it was sampled", () => {
		const t = started(rin);

		expect(() => complete(ledger, { actor: asRin, task_id: t })).toThrow(
			"TaskCompleted refused: T-1 is sampled for Review, as every Task of A-rin on Probation is; its completion names a reviewer",
		);
		expect(ledger.projections.tasks.tasks.get(t)?.state.tag).toBe("InProgress");
	});

	describe("for a Trusted Agent, whom the sample picks 1 Task in 3", () => {
		/** Rin's next Task after 10 reviewed ones, and `skip` Proposed ones. */
		const trustedTask = (skip: number) => {
			for (let i = 0; i < 10; i++) reviewed(rin);
			for (let i = 0; i < skip; i++) propose(ledger, proposal);
			return started(rin);
		};

		it("skips Review for a Task the sample leaves out, even with a reviewer named", () => {
			const unsampled = trustedTask(0);

			const skipped = complete(ledger, {
				actor: asRin,
				task_id: unsampled,
				reviewer: operator,
			});

			expect(unsampled).toBe("T-11");
			expect(skipped.task.state).toEqual({ tag: "Done", assignee: rin });
			expect(skipped.review).toEqual({
				tag: "Skipped",
				reason: "not sampled for Review at tier Trusted",
			});
		});

		it("refuses a sampled Task that names no reviewer, naming the 1 in 3 sample", () => {
			const sampled = trustedTask(4);

			expect(() =>
				complete(ledger, { actor: asRin, task_id: sampled }),
			).toThrow(
				"TaskCompleted refused: T-15 is sampled for Review, as 1 in 3 Tasks of A-rin at Trusted are; its completion names a reviewer",
			);
		});

		it("sends a sampled Task to the reviewer named", () => {
			const sampled = trustedTask(4);

			const submitted = complete(ledger, {
				actor: asRin,
				task_id: sampled,
				reviewer: pia,
			});

			expect(submitted.task.state).toEqual({
				tag: "UnderReview",
				assignee: rin,
				reviewer: pia,
			});
		});
	});
});

describe("completing a Task after Review", () => {
	it("needs a Review by the named reviewer, completed by that reviewer", () => {
		const task_id = started(rin);
		complete(ledger, { actor: asRin, task_id, reviewer: pia });
		const close = (actor: Actor) => () =>
			complete(ledger, { actor, task_id, reviewer: operator });
		const reviewBy = (reviewer: Actor) =>
			review(ledger, { task_id, reviewer, ...threes, note: "" });

		expect(close(pia)).toThrow(
			"TaskCompleted refused: T-1 has no Review by A-pia, its reviewer",
		);
		reviewBy(thorne);
		expect(close(pia)).toThrow(/T-1 has no Review by A-pia/);
		reviewBy(pia);
		expect(close(operator)).toThrow(
			"TaskCompleted refused: only A-pia, the reviewer of T-1, completes it after Review; the actor is Operator",
		);

		expect(close(pia)().task.state).toEqual({ tag: "Done", assignee: rin });
	});

	it("refuses completing a Task that is neither InProgress nor UnderReview, naming its state, and appends nothing", () => {
		const { task } = propose(ledger, proposal);
		const before = ledger.all().length;

		expect(() =>
			complete(ledger, { actor: operator, task_id: task.id }),
		).toThrow(
			new AppendRefused(
				"TaskCompleted refused: T-1 is Proposed, expected InProgress or UnderReview",
			),
		);
		expect(ledger.all()).toHaveLength(before);
	});
});

describe("the other Task verbs", () => {
	it("refuses starting a Task that is not Assigned, naming its state", () => {
		const task_id = started(rin);

		expect(() => start(ledger, { actor: asRin, task_id })).toThrow(
			new AppendRefused(
				"TaskStarted refused: T-1 is InProgress, expected Assigned",
			),
		);
	});

	it("hands an InProgress Task off from its assignee, back to Assigned", () => {
		const task_id = started(rin);

		const { task, seq } = handOff(ledger, {
			actor: asRin,
			task_id,
			to: odile,
			reason: "needs a second pair of eyes",
		});

		expect(task.state).toEqual({ tag: "Assigned", assignee: odile });
		expect(ledger.all().find((e) => e.seq === seq)?.payload).toEqual({
			task_id,
			from: rin,
			to: odile,
			reason: "needs a second pair of eyes",
		});
	});

	it("refuses a Hand-off of a Task that is not InProgress, naming its state", () => {
		const { task } = propose(ledger, proposal);

		expect(() =>
			handOff(ledger, {
				actor: operator,
				task_id: task.id,
				to: odile,
				reason: "busy",
			}),
		).toThrow("TaskHandedOff refused: T-1 is Proposed, expected InProgress");
	});

	it("escalates and fails live Tasks", () => {
		const first = propose(ledger, proposal).task.id;
		const second = propose(ledger, proposal).task.id;

		const escalated = escalate(ledger, {
			actor: operator,
			task_id: first,
			to: operator,
			reason: "no balance",
		});
		const failed = fail(ledger, {
			actor: operator,
			task_id: second,
			reason: "form unreadable",
		});

		expect(escalated.task.state).toEqual({ tag: "Escalated", to: operator });
		expect(failed.task.state).toEqual({
			tag: "Failed",
			reason: "form unreadable",
		});
	});

	it("blocks an InProgress Task on a Gate it requests under the next free gate id, caused by the Task's previous Event", () => {
		const task_id = started(rin);
		const cause = ledger.all().at(-1)?.seq as Seq;

		const blocked = block(ledger, {
			actor: asRin,
			task_id,
			kind: "Deploy",
			payload: { target: "staging" },
		});

		expect(blocked.gate.id).toBe("G-1");
		expect(blocked.task.state).toEqual({
			tag: "Blocked",
			assignee: rin,
			gate: "G-1",
		});
		expect(ledger.all().find((e) => e.seq === blocked.seq)).toMatchObject({
			kind: "GateRequested",
			task_id,
			causation_id: cause,
			payload: { gate_id: "G-1", kind: "Deploy" },
		});
	});
});

describe("a Help request", () => {
	const question = "Which column holds the TAT code?";

	it("is the assignee's, keeps the Task's state, names the Task's previous Event as its cause, and joins the Task's Help requests", () => {
		const task_id = started(rin);
		const cause = ledger.all().at(-1)?.seq as Seq;

		const first = requestHelp(ledger, {
			actor: asRin,
			task_id,
			to: operator,
			question,
		});
		const second = requestHelp(ledger, {
			actor: asRin,
			task_id,
			to: pia,
			question: "Is a blank TAT Regular?",
		});

		expect(first.task.state).toEqual({ tag: "InProgress", assignee: rin });
		expect(ledger.all().find((e) => e.seq === first.seq)).toMatchObject({
			actor: asRin,
			task_id,
			causation_id: cause,
			kind: "HelpRequested",
		});
		expect(ledger.projections.tasks.help.get(task_id)).toEqual([
			{ seq: first.seq, from: rin, to: operator, question },
			{
				seq: second.seq,
				from: rin,
				to: pia,
				question: "Is a blank TAT Regular?",
			},
		]);
	});

	it("is refused from anyone but the assignee, on a Task that is not live, and of an Agent not in the Org", () => {
		const task_id = started(rin);
		const before = ledger.all().length;

		expect(() =>
			requestHelp(ledger, { actor: pia, task_id, to: operator, question }),
		).toThrow(
			new AppendRefused(
				"HelpRequested refused: only A-rin, the assignee of T-1, requests help on it; the actor is A-pia",
			),
		);
		expect(() =>
			ledger.append({
				actor: operator,
				task_id,
				kind: "HelpRequested",
				payload: { task_id, to: pia, question },
			}),
		).toThrow(
			new AppendRefused(
				"HelpRequested refused: only A-rin, the assignee of T-1, requests help on it; the actor is Operator",
			),
		);
		expect(() =>
			requestHelp(ledger, {
				actor: asRin,
				task_id,
				to: { tag: "Agent", id: AgentId.parse("A-nobody") },
				question,
			}),
		).toThrow(
			new AppendRefused(
				"HelpRequested refused: A-nobody is not a live Agent in the Org",
			),
		);
		fail(ledger, { actor: operator, task_id, reason: "form unreadable" });
		expect(() =>
			requestHelp(ledger, { actor: asRin, task_id, to: operator, question }),
		).toThrow(
			new AppendRefused(
				"HelpRequested refused: T-1 is Failed, expected Assigned, InProgress, UnderReview or Blocked",
			),
		);
		expect(ledger.all(), "only the failure is appended").toHaveLength(
			before + 1,
		);
	});
});

describe("an assignment or Hand-off", () => {
	const bram = AgentId.parse("A-bram");
	const anselm = AgentId.parse("A-anselm");
	const nobody = AgentId.parse("A-nobody");
	const refusedAssignees: readonly [AgentId, string][] = [
		[bram, "A-bram is paused"],
		[anselm, "A-anselm is not a live Agent in the Org"],
		[nobody, "A-nobody is not a live Agent in the Org"],
	];

	let s: Scenario;
	beforeEach(() => {
		s = scenario();
		pause(s.ledger, { actor: operator, agent_id: bram, reason: "audit" });
		s.retire(anselm, "Replaced");
	});
	afterEach(() => s.close());

	it("is refused to a paused Agent, a Retired one, or one not in the Org, naming why, by the verb and by the Ledger, and appends nothing", () => {
		const proposed = propose(s.ledger, proposal).task.id;
		const held = propose(s.ledger, proposal).task.id;
		assign(s.ledger, { actor: operator, task_id: held, assignee: rin });
		start(s.ledger, { actor: asRin, task_id: held });
		const before = s.events().length;

		for (const [agent, reason] of refusedAssignees) {
			const assigned = new AppendRefused(`TaskAssigned refused: ${reason}`);
			const handedOff = new AppendRefused(`TaskHandedOff refused: ${reason}`);
			expect(() =>
				assign(s.ledger, {
					actor: operator,
					task_id: proposed,
					assignee: agent,
				}),
			).toThrow(assigned);
			expect(() =>
				s.ledger.append({
					actor: operator,
					task_id: proposed,
					kind: "TaskAssigned",
					payload: { task_id: proposed, assignee: agent },
				}),
			).toThrow(assigned);
			expect(() =>
				handOff(s.ledger, {
					actor: asRin,
					task_id: held,
					to: agent,
					reason: "out of time",
				}),
			).toThrow(handedOff);
			expect(() =>
				s.ledger.append({
					actor: asRin,
					task_id: held,
					kind: "TaskHandedOff",
					payload: { task_id: held, from: rin, to: agent, reason: "" },
				}),
			).toThrow(handedOff);
		}
		expect(s.events()).toHaveLength(before);
	});

	it("an escalation or Help request is refused to a paused Agent, a Retired one, or one not in the Org, naming why, by the verb and by the Ledger, and appends nothing", () => {
		const held = propose(s.ledger, proposal).task.id;
		assign(s.ledger, { actor: operator, task_id: held, assignee: rin });
		start(s.ledger, { actor: asRin, task_id: held });
		const before = s.events().length;

		for (const [agent, reason] of refusedAssignees) {
			const to: Actor = { tag: "Agent", id: agent };
			const escalated = new AppendRefused(`TaskEscalated refused: ${reason}`);
			const helped = new AppendRefused(`HelpRequested refused: ${reason}`);
			expect(() =>
				escalate(s.ledger, { actor: asRin, task_id: held, to, reason: "x" }),
			).toThrow(escalated);
			expect(() =>
				s.ledger.append({
					actor: asRin,
					task_id: held,
					kind: "TaskEscalated",
					payload: { task_id: held, to, reason: "x" },
				}),
			).toThrow(escalated);
			expect(() =>
				requestHelp(s.ledger, {
					actor: asRin,
					task_id: held,
					to,
					question: "q",
				}),
			).toThrow(helped);
			expect(() =>
				s.ledger.append({
					actor: asRin,
					task_id: held,
					kind: "HelpRequested",
					payload: { task_id: held, to, question: "q" },
				}),
			).toThrow(helped);
		}
		expect(s.events()).toHaveLength(before);
	});

	it("goes to a paused Agent once it is resumed", () => {
		const task_id = propose(s.ledger, proposal).task.id;
		resume(s.ledger, { actor: operator, agent_id: bram });

		expect(
			assign(s.ledger, { actor: operator, task_id, assignee: bram }).task.state,
		).toEqual({ tag: "Assigned", assignee: bram });
	});
});
