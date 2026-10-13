import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendRefused } from "../append-guard.js";
import type { NewEvent } from "../events.js";
import { AgentId, Seq, TurnId } from "../ids.js";
import { pause } from "../org/lifecycle.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import type { Actor, EventActor } from "../types/actor.js";
import type { TurnUsage } from "../types/turn.js";
import { orderRest } from "../vitality/lifecycle.js";
import { finishTurn, startTurn } from "./lifecycle.js";

const rin = AgentId.parse("A-rin");
const ines = AgentId.parse("A-ines");
const operator: Actor = { tag: "Operator" };
const conductor: EventActor = { tag: "Conductor" };
const MODEL = "claude-opus-5-5";

const usage: TurnUsage = {
	input_tokens: 1200,
	output_tokens: 300,
	cache_creation_tokens: 40,
	cache_read_tokens: 9000,
	cost_usd: 0.021,
};

let s: Scenario;
beforeEach(() => {
	s = scenario();
});
afterEach(() => s.close());

const start = (agent: AgentId) =>
	startTurn(s.ledger, { agent, model: MODEL, energyBudgetTokens: 8000 });

const finish = (turn_id: TurnId) =>
	finishTurn(s.ledger, {
		turn_id,
		usage,
		outcome: { tag: "Completed" },
		tool_calls: 3,
	});

const stored = (seq: Seq) => s.events().find((e) => e.seq === seq);

describe("the Turn lifecycle", () => {
	it("starts a Turn as the Conductor under the next Turn id, with the Agent's model, Mood and Policy", () => {
		const first = start(rin);
		const second = start(ines);

		expect(stored(first.seq)).toMatchObject({
			actor: conductor,
			kind: "TurnStarted",
			payload: {
				turn_id: "TN-1",
				agent: rin,
				model: MODEL,
				mood: "fresh",
				policy: {
					mayAcceptTasks: true,
					mayOfferHelp: true,
					mustHandOff: false,
					mustRequestHelp: false,
					mustNameBlocker: false,
					schedulable: true,
				},
			},
		});
		expect(stored(first.seq)).not.toHaveProperty("causation_id");
		expect(second.turn.started.turn_id).toBe("TN-2");
		expect(first.turn).toMatchObject({
			seq: first.seq,
			at: s.now().toISOString(),
		});
	});

	it("records the Mood the Agent works under, as vitality show gives it", () => {
		s.task(rin);

		expect(start(rin).turn.started.mood, "a Task InProgress").toBe("focused");
	});

	it("finishes a Turn as the Conductor, naming its TurnStarted as the cause, and closes it", () => {
		const started = start(rin);
		const finished = finish(started.turn.started.turn_id);

		expect(stored(finished.seq)).toMatchObject({
			actor: conductor,
			causation_id: started.seq,
			kind: "TurnFinished",
			payload: {
				turn_id: "TN-1",
				usage,
				outcome: { tag: "Completed" },
				tool_calls: 3,
			},
		});
		expect(finished.turn.finished).toMatchObject({ seq: finished.seq });
		expect(s.ledger.projections.turns.open.has(rin), "no open Turn").toBe(
			false,
		);
		expect(start(rin).turn.started.turn_id, "a new Turn may start").toBe(
			"TN-2",
		);
	});

	it("records an Error outcome with its text", () => {
		const { turn } = start(rin);
		const { seq } = finishTurn(s.ledger, {
			turn_id: turn.started.turn_id,
			usage,
			outcome: { tag: "Error", message: "the model refused the prompt" },
			tool_calls: 0,
		});

		expect(stored(seq)?.payload).toMatchObject({
			outcome: { tag: "Error", message: "the model refused the prompt" },
		});
	});

	it("refuses a Turn for an Agent that is not live, is resting, is paused, or has an open Turn, and appends nothing", () => {
		const anselm = AgentId.parse("A-anselm");
		const bram = AgentId.parse("A-bram");
		s.retire(anselm, "Replaced");
		orderRest(s.ledger, {
			actor: operator,
			agent_id: ines,
			action: "begin",
			reason: "fatigue",
		});
		pause(s.ledger, { actor: operator, agent_id: bram, reason: "audit" });
		start(rin);
		const before = s.events().length;

		const refused = (agent: AgentId, reason: string) =>
			expect(() => start(agent)).toThrow(
				new AppendRefused(`TurnStarted refused: ${reason}`),
			);
		refused(anselm, "A-anselm is not a live Agent in the Org");
		refused(
			AgentId.parse("A-nobody"),
			"A-nobody is not a live Agent in the Org",
		);
		refused(ines, "A-ines is resting");
		refused(bram, "A-bram is paused");
		refused(rin, "A-rin already has an open Turn, TN-1");
		expect(s.events()).toHaveLength(before);
	});

	it("refuses to finish a Turn that is unknown or already finished, and appends nothing", () => {
		const { turn } = start(rin);
		finish(turn.started.turn_id);
		const before = s.events().length;

		expect(() => finish(TurnId.parse("TN-9"))).toThrow(
			new AppendRefused("TurnFinished refused: TN-9 has not started"),
		);
		expect(() => finish(turn.started.turn_id)).toThrow(
			new AppendRefused("TurnFinished refused: TN-1 has already finished"),
		);
		expect(s.events()).toHaveLength(before);
	});
});

describe("the Ledger's Turn rules", () => {
	const started = (actor: EventActor, agent = rin): NewEvent => ({
		actor,
		kind: "TurnStarted",
		payload: {
			turn_id: TurnId.parse("TN-1"),
			agent,
			model: MODEL,
			mood: "fresh",
			policy: {
				mayAcceptTasks: true,
				mayOfferHelp: true,
				mustHandOff: false,
				mustRequestHelp: false,
				mustNameBlocker: false,
				schedulable: true,
			},
		},
	});
	const finished = (actor: EventActor, causation_id?: Seq): NewEvent => ({
		actor,
		...(causation_id === undefined ? {} : { causation_id }),
		kind: "TurnFinished",
		payload: {
			turn_id: TurnId.parse("TN-1"),
			usage,
			outcome: { tag: "MaxTurns" },
			tool_calls: 12,
		},
	});

	it("refuses TurnStarted and TurnFinished from an Agent or the Operator", () => {
		const agent: Actor = { tag: "Agent", id: rin };
		expect(() => s.ledger.append(started(operator))).toThrow(
			new AppendRefused(
				"TurnStarted refused: only the Conductor records a Turn; Operator tried to record TN-1",
			),
		);
		expect(() => s.ledger.append(started(agent))).toThrow(
			new AppendRefused(
				"TurnStarted refused: only the Conductor records a Turn; A-rin tried to record TN-1",
			),
		);
		const { seq } = s.ledger.append(started(conductor));
		expect(() => s.ledger.append(finished(agent, seq))).toThrow(
			new AppendRefused(
				"TurnFinished refused: only the Conductor records a Turn; A-rin tried to record TN-1",
			),
		);
		expect(s.ledger.append(finished(conductor, seq))).toMatchObject({
			kind: "TurnFinished",
			causation_id: seq,
		});
	});

	it("refuses a TurnFinished that does not name its TurnStarted as the cause", () => {
		const { seq } = s.ledger.append(started(conductor));
		expect(() => s.ledger.append(finished(conductor))).toThrow(
			new AppendRefused(
				`TurnFinished refused: TN-1 finishes naming its TurnStarted, seq ${seq}, as its cause, not none`,
			),
		);
		expect(() => s.ledger.append(finished(conductor, Seq.parse(1)))).toThrow(
			new AppendRefused(
				`TurnFinished refused: TN-1 finishes naming its TurnStarted, seq ${seq}, as its cause, not 1`,
			),
		);
	});

	it("refuses a second TurnStarted with a Turn id already used", () => {
		s.ledger.append(started(conductor));
		finishTurn(s.ledger, {
			turn_id: TurnId.parse("TN-1"),
			usage,
			outcome: { tag: "Budget" },
			tool_calls: 1,
		});
		expect(() => s.ledger.append(started(conductor, ines))).toThrow(
			new AppendRefused("TurnStarted refused: TN-1 has already started"),
		);
	});
});
