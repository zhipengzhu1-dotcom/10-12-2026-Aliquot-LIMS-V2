import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId, Seq, TurnId } from "./ids.js";
import { assign, propose } from "./task/lifecycle.js";
import { type Scenario, scenario } from "./test-support/scenario.js";
import { finishTurn, startTurn } from "./turn/lifecycle.js";
import type { Actor, EventActor } from "./types/actor.js";
import type { AgentDefinition } from "./types/agent-definition.js";
import { policyOf } from "./vitality/policy.js";

const rin = AgentId.parse("A-rin");
const operator: Actor = { tag: "Operator" };

let s: Scenario;
beforeEach(() => {
	s = scenario();
});
afterEach(() => s.close());

const current = (): AgentDefinition => {
	const agent = s.ledger.projections.org.agents.get(rin);
	if (agent === undefined) throw new Error("A-rin is not seeded");
	return agent.definition;
};

const revise = (actor: Actor, changes: Partial<AgentDefinition>) => {
	const definition = current();
	return () =>
		s.appendNonTask({
			actor,
			kind: "AgentDefinitionRevised",
			payload: {
				definition: {
					...definition,
					version: definition.version + 1,
					revised_by: actor,
					revision_reason: "ADR check",
					...changes,
				},
			},
		});
};

describe("ADR rules the slice-0 review found missing", () => {
	it("refuses AgentRetired when its Gate is a RetireAgent Gate the Operator rejected (ADR-0006)", () => {
		const gate_id = s.gate("RetireAgent", { agent_id: rin }, "reject");

		expect(() =>
			s.appendNonTask({
				actor: operator,
				kind: "AgentRetired",
				payload: { agent_id: rin, reason: "Replaced", gate_id },
			}),
		).toThrow(
			`AgentRetired refused: ${gate_id} is a RetireAgent Gate, Rejected, naming A-rin; retiring A-rin needs an approved RetireAgent Gate naming it`,
		);
	});

	it("refuses a Revision to Mentor without an approved, unused PromoteToMentor Gate (ADR-0007)", () => {
		s.gate("PromoteToMentor", { agent_id: rin }, "reject");

		expect(revise(operator, { trust_tier: "Mentor" })).toThrow(
			"AgentDefinitionRevised refused: A-rin cannot be Mentor: no approved, unused PromoteToMentor Gate names it; its projected Trust tier is Probation",
		);
	});

	it("refuses a Revision of trust_tier to anything but the projected tier, whoever authors it (ADR-0011)", () => {
		const odile: Actor = { tag: "Agent", id: AgentId.parse("A-odile") };
		const refusal =
			"AgentDefinitionRevised refused: A-rin's projected Trust tier is Probation, not Trusted";

		expect(revise(operator, { trust_tier: "Trusted" })).toThrow(refusal);
		expect(revise(odile, { trust_tier: "Trusted" })).toThrow(refusal);
		s.gate("PromoteToMentor", { agent_id: rin });
		expect(revise(operator, { trust_tier: "Mentor" })).toThrow(
			"AgentDefinitionRevised refused: A-rin's projected Trust tier is Probation, not Mentor",
		);

		revise(operator, { capacity: 4 })();
		expect(current()).toMatchObject({ capacity: 4, trust_tier: "Probation" });
	});

	describe("the Conductor authors only the tier Revisions Merit and Gates require (ADR-0011)", () => {
		const conductor: EventActor = { tag: "Conductor" };
		const tierRevision = (
			changes: Partial<AgentDefinition>,
			causation_id: number | null = 1,
		) => {
			const definition = current();
			return () =>
				s.appendNonTask({
					actor: conductor,
					...(causation_id === null
						? {}
						: { causation_id: Seq.parse(causation_id) }),
					kind: "AgentDefinitionRevised",
					payload: {
						definition: {
							...definition,
							version: definition.version + 1,
							revised_by: conductor,
							revision_reason: "Trust tier Probation -> Trusted",
							...changes,
						},
					},
				});
		};

		it("refuses any other Event with actor Conductor", () => {
			expect(() =>
				s.appendNonTask({
					actor: conductor,
					kind: "AgentPaused",
					payload: { agent_id: rin, reason: "Tired" },
				}),
			).toThrow(
				"AgentPaused refused: the Conductor authors only tier Revisions",
			);
		});

		it("refuses a payload that names the Conductor as anything but an author", () => {
			const task_id = s.task(rin);
			expect(() =>
				s.ledger.append({
					actor: { tag: "Agent", id: rin },
					task_id,
					kind: "TaskCompleted",
					payload: {
						task_id,
						outputs: [],
						review: {
							tag: "Required",
							reviewer: conductor as unknown as Actor,
						},
					},
				}),
			).toThrow("TaskCompleted refused: not a valid Event");
		});

		it("refuses a Conductor Revision without a causation_id, or whose causation_id names no Event", () => {
			expect(tierRevision({ trust_tier: "Trusted" }, null)).toThrow(
				"AgentDefinitionRevised refused: the Conductor's Revision of A-rin names no causation_id",
			);
			const next = s.events().length + 1;
			expect(tierRevision({ trust_tier: "Trusted" }, next)).toThrow(
				`AgentDefinitionRevised refused: causation_id ${next} names no Event in the Ledger`,
			);
		});

		it("refuses a Conductor Revision that changes another field, or leaves the tier as it is", () => {
			expect(tierRevision({ trust_tier: "Trusted", capacity: 9 })).toThrow(
				"AgentDefinitionRevised refused: the Conductor's Revision of A-rin may change only its Trust tier; it also changes capacity",
			);
			expect(tierRevision({})).toThrow(
				"AgentDefinitionRevised refused: the Conductor's Revision of A-rin leaves its Trust tier at Probation",
			);
		});

		it("refuses a Conductor Revision to a tier other than the projected one", () => {
			expect(tierRevision({ trust_tier: "Trusted" })).toThrow(
				"AgentDefinitionRevised refused: A-rin's projected Trust tier is Probation, not Trusted",
			);
		});
	});

	describe("the Conductor records its own acts, and no one else records them (ADR-0013)", () => {
		const conductor: EventActor = { tag: "Conductor" };
		const turnStarted = (actor: EventActor) => () =>
			s.appendNonTask({
				actor,
				kind: "TurnStarted",
				payload: {
					turn_id: TurnId.parse("TN-1"),
					agent: rin,
					model: "claude-opus-5-5",
					mood: "fresh",
					policy: policyOf("fresh"),
				},
			});

		it("accepts a Turn by the Conductor and refuses one by the Operator or an Agent", () => {
			expect(turnStarted(operator)).toThrow(
				"TurnStarted refused: only the Conductor records a Turn; Operator tried to record TN-1",
			);
			expect(turnStarted({ tag: "Agent", id: rin })).toThrow(
				"TurnStarted refused: only the Conductor records a Turn; A-rin tried to record TN-1",
			);
			expect(turnStarted(conductor)()).toMatchObject({
				kind: "TurnStarted",
				actor: conductor,
			});
		});

		it("accepts a refused Tool call recorded by the Conductor and refuses one recorded by the Operator or an Agent", () => {
			const refusal = (actor: EventActor) => () =>
				s.appendNonTask({
					actor,
					kind: "ActionRefused",
					payload: {
						agent: rin,
						tool: "run_script",
						action: "RunOutsideSandbox",
						reason: "A-rin's Charter forbids RunOutsideSandbox",
					},
				});

			expect(refusal(operator)).toThrow(
				"ActionRefused refused: only the Conductor records a refused Tool call; Operator tried to record A-rin's run_script",
			);
			expect(refusal({ tag: "Agent", id: rin })).toThrow(
				"ActionRefused refused: only the Conductor records a refused Tool call; A-rin tried to record A-rin's run_script",
			);
			expect(refusal(conductor)()).toMatchObject({
				kind: "ActionRefused",
				actor: conductor,
			});
		});

		it("still refuses every Conductor Event that is neither its own act nor a tier Revision", () => {
			expect(() =>
				s.appendNonTask({
					actor: conductor,
					kind: "RestOrdered",
					payload: { agent_id: rin, action: "begin", reason: "tired" },
				}),
			).toThrow(
				"RestOrdered refused: the Conductor authors only tier Revisions",
			);
		});

		describe("the scheduler's assignment of a Proposed Task is the Conductor's act (#40)", () => {
			const proposed = () =>
				propose(s.ledger, {
					actor: operator,
					title: "Waiting for an assignee",
					goal: "Do the work",
					tat_class: "Regular",
					priority: 1,
				});

			it("accepts the Conductor's assignment of a Proposed Task, naming its TaskProposed", () => {
				const { task, seq } = proposed();

				const assigned = assign(s.ledger, {
					actor: conductor,
					task_id: task.id,
					assignee: rin,
				});

				expect(s.ledger.all().at(-1)).toMatchObject({
					seq: assigned.seq,
					kind: "TaskAssigned",
					actor: conductor,
					causation_id: seq,
				});
				expect(assigned.task.state).toEqual({ tag: "Assigned", assignee: rin });
			});

			it("refuses the Conductor's assignment of a Task that is no longer Proposed", () => {
				const { task } = proposed();
				assign(s.ledger, { actor: operator, task_id: task.id, assignee: rin });
				const before = s.ledger.all().length;

				expect(() =>
					assign(s.ledger, {
						actor: conductor,
						task_id: task.id,
						assignee: AgentId.parse("A-ines"),
					}),
				).toThrow(
					`TaskAssigned refused: the Conductor assigns only a Proposed Task; ${task.id} is Assigned, expected Proposed`,
				);
				expect(s.ledger.all()).toHaveLength(before);
			});

			it("refuses a Conductor assignment that names another cause than the Task's previous Event", () => {
				const { task, seq } = proposed();

				expect(() =>
					s.ledger.append({
						actor: conductor,
						task_id: task.id,
						causation_id: Seq.parse(seq - 1),
						kind: "TaskAssigned",
						payload: { task_id: task.id, assignee: rin },
					}),
				).toThrow(
					`TaskAssigned refused: the Conductor's assignment of ${task.id} names its previous Event, seq ${seq}, as its cause, not ${seq - 1}`,
				);
			});
		});

		describe("the end-of-Turn Vitality sample is the Conductor's act (#43)", () => {
			const sampled =
				(actor: EventActor, agent: AgentId, cause?: number) => () =>
					s.appendNonTask({
						actor,
						...(cause === undefined ? {} : { causation_id: Seq.parse(cause) }),
						kind: "VitalitySampled",
						payload: {
							agent,
							load: 0,
							fatigue: 0,
							friction: 0,
							confidence: 1,
							morale: 0,
						},
					});
			const finishedTurn = (agent: AgentId) => {
				const { turn } = startTurn(s.ledger, {
					agent,
					model: "claude-sonnet-5-5",
					energyBudgetTokens: 1_000_000,
				});
				const { seq } = finishTurn(s.ledger, {
					turn_id: turn.started.turn_id,
					usage: {
						input_tokens: 10,
						output_tokens: 5,
						cache_creation_tokens: 0,
						cache_read_tokens: 0,
						cost_usd: 0.001,
					},
					outcome: { tag: "Completed" },
					tool_calls: 0,
				});
				return { started: turn.seq, finished: seq };
			};

			it("accepts a Conductor sample that names a TurnFinished of the same Agent", () => {
				const { finished } = finishedTurn(rin);

				expect(sampled(conductor, rin, finished)()).toMatchObject({
					kind: "VitalitySampled",
					actor: conductor,
					causation_id: finished,
				});
			});

			it("refuses a Conductor sample that names no cause, a TurnStarted, or another Agent's TurnFinished", () => {
				const ines = AgentId.parse("A-ines");
				const { started, finished } = finishedTurn(ines);

				expect(sampled(conductor, rin)).toThrow(
					"VitalitySampled refused: the Conductor samples A-rin only at the end of its Turn, naming its TurnFinished; this sample names no cause",
				);
				expect(sampled(conductor, ines, started)).toThrow(
					`VitalitySampled refused: the Conductor samples A-ines only at the end of its Turn, naming its TurnFinished; seq ${started} is not a TurnFinished`,
				);
				expect(sampled(conductor, rin, finished)).toThrow(
					`VitalitySampled refused: the Conductor samples A-rin only at the end of its Turn, naming its TurnFinished; seq ${finished} finishes TN-1 of A-ines`,
				);
			});

			it("still accepts a sample by the Operator with no cause", () => {
				expect(sampled(operator, rin)()).toMatchObject({
					kind: "VitalitySampled",
					actor: operator,
				});
			});
		});
	});

	it("refuses a Revision whose revised_by is not the actor that writes it (ADR-0005)", () => {
		const mabel: Actor = { tag: "Agent", id: AgentId.parse("A-mabel") };

		expect(revise(operator, { revised_by: mabel })).toThrow(
			"AgentDefinitionRevised refused: A-rin's definition names A-mabel as revised_by, but the actor is Operator",
		);
	});
});
