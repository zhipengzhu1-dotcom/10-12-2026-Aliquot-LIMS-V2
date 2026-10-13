import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendRefused } from "../append-guard.js";
import { AgentId, type Seq } from "../ids.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import { finishTurn, startTurn } from "../turn/lifecycle.js";
import type { Actor } from "../types/actor.js";
import { orderRest, sample } from "./lifecycle.js";

const rin = AgentId.parse("A-rin");
const ines = AgentId.parse("A-ines");
const operator: Actor = { tag: "Operator" };
const mabel: Actor = { tag: "Agent", id: AgentId.parse("A-mabel") };

let s: Scenario;
beforeEach(() => {
	s = scenario();
});
afterEach(() => s.close());

const sampleOf = (agent: AgentId, causation_id?: Seq) =>
	sample(s.ledger, {
		actor: operator,
		causation_id,
		agent,
		now: s.now(),
		energyBudgetTokens: 8000,
	});

/** A finished Turn of `agent` that spends 300 tokens of the Energy budget. */
const turn = (agent: AgentId) => {
	const { turn: started } = startTurn(s.ledger, {
		agent,
		model: "claude-opus-5-5",
		energyBudgetTokens: 8000,
	});
	return finishTurn(s.ledger, {
		turn_id: started.started.turn_id,
		usage: {
			input_tokens: 200,
			output_tokens: 100,
			cache_creation_tokens: 0,
			cache_read_tokens: 0,
			cost_usd: 0.01,
		},
		outcome: { tag: "Completed" },
		tool_calls: 1,
	});
};

const rest = (agent: AgentId, action: "begin" | "end") =>
	orderRest(s.ledger, {
		actor: mabel,
		agent_id: agent,
		action,
		reason: "fatigue",
	});

const stored = (seq: Seq) => s.events().find((e) => e.seq === seq);

describe("the Vitality lifecycle", () => {
	it("samples a live Agent's Vitality from the Ledger, naming no cause, and returns the sample and the seq it appended", () => {
		turn(rin);
		const { vitality, seq } = sampleOf(rin);

		expect(vitality, "300 tokens of a 1000-token share").toEqual({
			agent: rin,
			load: 0,
			fatigue: 0.3,
			friction: 0,
			confidence: 1,
			morale: 0,
		});
		expect(stored(seq)).toMatchObject({
			kind: "VitalitySampled",
			actor: operator,
			payload: vitality,
		});
		expect(stored(seq)).not.toHaveProperty("causation_id");
	});

	it("names the TurnFinished a sample is taken at the end of as its cause", () => {
		const finished = turn(rin);
		const { seq } = sampleOf(rin, finished.seq);

		expect(stored(seq)).toMatchObject({
			kind: "VitalitySampled",
			causation_id: finished.seq,
			payload: { agent: rin, fatigue: 0.3 },
		});
	});

	it("names the Agent's previous Vitality Event as the cause of each Rest order, but none for a sample, and returns the order and the seq it appended", () => {
		const first = rest(rin, "begin");
		const ended = rest(rin, "end");
		const sampled = sampleOf(rin);
		sampleOf(ines);
		const again = rest(rin, "begin");

		expect(again.order, "the order as the Event recorded it").toEqual({
			agent_id: rin,
			action: "begin",
			reason: "fatigue",
		});

		expect(
			[first, ended, sampled, again].map(({ seq }) => {
				const e = stored(seq);
				return [e?.kind, e?.payload, e?.causation_id];
			}),
		).toEqual([
			[
				"RestOrdered",
				{ agent_id: rin, action: "begin", reason: "fatigue" },
				undefined,
			],
			[
				"RestOrdered",
				{ agent_id: rin, action: "end", reason: "fatigue" },
				first.seq,
			],
			["VitalitySampled", sampled.vitality, undefined],
			[
				"RestOrdered",
				{ agent_id: rin, action: "begin", reason: "fatigue" },
				sampled.seq,
			],
		]);
	});

	it("refuses Rest for an Agent not in the Org, ending Rest not in effect, and beginning Rest in effect, and appends nothing", () => {
		const before = s.events().length;

		expect(() => rest(AgentId.parse("A-nobody"), "begin")).toThrow(
			new AppendRefused("RestOrdered refused: A-nobody is not in the Org"),
		);
		expect(() => rest(rin, "end")).toThrow(
			new AppendRefused("RestOrdered refused: A-rin is not resting"),
		);
		expect(s.events()).toHaveLength(before);

		rest(rin, "begin");
		expect(() => rest(rin, "begin")).toThrow(
			new AppendRefused("RestOrdered refused: A-rin is already resting"),
		);
		expect(s.events()).toHaveLength(before + 1);
	});

	it("refuses sampling an Agent that is not live in the Org, and appends nothing", () => {
		const anselm = AgentId.parse("A-anselm");
		s.retire(anselm, "Replaced");
		const before = s.events().length;

		expect(() => sampleOf(anselm)).toThrow(
			new AppendRefused(
				"VitalitySampled refused: A-anselm is not a live Agent in the Org",
			),
		);
		expect(() => sampleOf(AgentId.parse("A-nobody"))).toThrow(
			new AppendRefused(
				"VitalitySampled refused: A-nobody is not a live Agent in the Org",
			),
		);
		expect(s.events()).toHaveLength(before);
	});
});
