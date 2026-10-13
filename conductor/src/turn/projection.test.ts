import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId } from "../ids.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import { finishTurn, startTurn } from "./lifecycle.js";
import { tokensInWindow } from "./projection.js";

const rin = AgentId.parse("A-rin");
const ines = AgentId.parse("A-ines");
const HOUR = 1 / 24; // in days

let s: Scenario;
beforeEach(() => {
	s = scenario("2026-10-12T00:00:00.000Z");
});
afterEach(() => s.close());

/** A Turn of `agent` that starts now and finishes `hours` later. */
const turn = (
	agent: AgentId,
	tokens: { input: number; output: number; creation: number; read: number },
	hours = 0,
) => {
	const { turn: started } = startTurn(s.ledger, {
		agent,
		model: "claude-opus-5-5",
		energyBudgetTokens: 8000,
	});
	s.advanceDays(hours * HOUR);
	finishTurn(s.ledger, {
		turn_id: started.started.turn_id,
		usage: {
			input_tokens: tokens.input,
			output_tokens: tokens.output,
			cache_creation_tokens: tokens.creation,
			cache_read_tokens: tokens.read,
			cost_usd: 0.01,
		},
		outcome: { tag: "Completed" },
		tool_calls: 1,
	});
};

const at = (iso: string) => new Date(iso);

describe("the Turn Projection's tokens in a window", () => {
	it("counts input, output and cache creation tokens, not cache reads, of Turns that finished in the window", () => {
		turn(rin, { input: 100, output: 20, creation: 3, read: 5000 }); // 00:00
		s.advanceDays(2 * HOUR);
		turn(rin, { input: 1000, output: 200, creation: 30, read: 5000 }, 1); // 03:00
		turn(ines, { input: 7, output: 0, creation: 0, read: 0 }); // 03:00
		const { turns } = s.ledger.projections;

		const window = [
			at("2026-10-12T00:00:00.000Z"),
			at("2026-10-12T05:00:00.000Z"),
		] as const;
		expect(
			tokensInWindow(turns, rin, ...window),
			"the 00:00 Turn falls out",
		).toBe(1230);
		expect(
			tokensInWindow(turns, "society", ...window),
			"every Agent's Turns",
		).toBe(1237);
		expect(
			tokensInWindow(
				turns,
				rin,
				at("2026-10-11T23:00:00.000Z"),
				at("2026-10-12T02:59:59.999Z"),
			),
			"the 03:00 Turn is not yet in",
		).toBe(123);
	});

	it("leaves out a Turn still open", () => {
		startTurn(s.ledger, {
			agent: rin,
			model: "claude-opus-5-5",
			energyBudgetTokens: 8000,
		});

		expect(
			tokensInWindow(
				s.ledger.projections.turns,
				"society",
				at("2026-10-11T00:00:00.000Z"),
				at("2026-10-13T00:00:00.000Z"),
			),
		).toBe(0);
	});
});
