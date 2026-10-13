import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId } from "../ids.js";
import { pause } from "../org/lifecycle.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import type { TurnUsage } from "../types/turn.js";
import { orderRest } from "../vitality/lifecycle.js";
import { startTurn } from "./lifecycle.js";
import {
	type ModelRequest,
	type RunModel,
	type ScriptedModel,
	scriptedModel,
} from "./model.js";
import { runTurn } from "./run.js";

const rin = AgentId.parse("A-rin");
const odile = AgentId.parse("A-odile");

const round: TurnUsage = {
	input_tokens: 1000,
	output_tokens: 200,
	cache_creation_tokens: 50,
	cache_read_tokens: 4000,
	cost_usd: 0.25,
};

let s: Scenario;
let home: string;
beforeEach(() => {
	s = scenario();
	home = mkdtempSync(join(tmpdir(), "aliquot-turn-run-"));
});
afterEach(() => {
	s.close();
	rmSync(home, { recursive: true, force: true });
});

const run = (
	agent: AgentId,
	model: RunModel,
	caps: { maxTurns?: number; maxBudgetUsd?: number } = {},
) =>
	runTurn(s.ledger, {
		home,
		agent,
		maxTurns: caps.maxTurns ?? 20,
		maxBudgetUsd: caps.maxBudgetUsd,
		energyBudgetTokens: 1_000_000,
		login: { tag: "Subscription" },
		runModel: model,
	});

const scripted = (
	calls: ScriptedModel["calls"],
	stop: ScriptedModel["stop"] = { tag: "Completed" },
) => scriptedModel({ calls, usage_per_round: round, stop });

const newEvents = (before: number) => s.events().slice(before);

describe("one Turn on the scripted model", () => {
	it("records TurnStarted, the Events of its Tool calls, TurnFinished naming TurnStarted, and a VitalitySampled naming TurnFinished", async () => {
		const task_id = s.task(rin);
		const before = s.events().length;

		const { turn, mood } = await run(
			rin,
			scripted([
				{ tool: "read_tasks", input: { assignee: "A-rin" } },
				{
					tool: "note_memory",
					input: { task_id, lesson: "Merged cells hide rows", applies_to: [] },
				},
			]),
		);

		const events = newEvents(before);
		expect(events.map((e) => [e.kind, e.actor])).toEqual([
			["TurnStarted", { tag: "Conductor" }],
			["MemoryNoted", { tag: "Agent", id: rin }],
			["TurnFinished", { tag: "Conductor" }],
			["VitalitySampled", { tag: "Conductor" }],
		]);
		const [started, , finished, sampled] = events;
		expect(finished?.causation_id).toBe(started?.seq);
		expect(sampled?.causation_id).toBe(finished?.seq);
		expect(turn.finished?.payload).toEqual({
			turn_id: "TN-1",
			usage: {
				input_tokens: 3000,
				output_tokens: 600,
				cache_creation_tokens: 150,
				cache_read_tokens: 12000,
				cost_usd: 0.75,
			},
			outcome: { tag: "Completed" },
			tool_calls: 2,
		});
		expect(mood).toBe("focused");
		expect(s.ledger.verify().ok).toBe(true);
	});

	it("records ActionRefused for a forbidden Tool and still finishes Completed", async () => {
		const before = s.events().length;

		const { turn } = await run(
			odile,
			scripted([
				{
					tool: "run_script",
					input: { script: "S-copy", inputs: [] },
				},
			]),
		);

		const events = newEvents(before);
		expect(events.map((e) => e.kind)).toEqual([
			"TurnStarted",
			"ActionRefused",
			"TurnFinished",
			"VitalitySampled",
		]);
		expect(events[1]).toMatchObject({
			actor: { tag: "Conductor" },
			causation_id: events[0]?.seq,
			payload: { agent: odile, tool: "run_script", action: "RunScript" },
		});
		expect(turn.finished?.payload.outcome).toEqual({ tag: "Completed" });
		expect(turn.finished?.payload.tool_calls).toBe(1);
	});

	it("records MaxTurns, and the usage consumed, when the model reaches --max-turns", async () => {
		const calls = [1, 2, 3].map(() => ({ tool: "verify_ledger", input: {} }));

		const { turn } = await run(rin, scripted(calls), { maxTurns: 2 });

		expect(turn.finished?.payload).toMatchObject({
			outcome: { tag: "MaxTurns" },
			usage: { input_tokens: 2000, cost_usd: 0.5 },
			tool_calls: 2,
		});
	});

	it("records Budget, and the usage consumed, when the model passes --max-budget-usd", async () => {
		const calls = [1, 2, 3].map(() => ({ tool: "verify_ledger", input: {} }));

		const { turn } = await run(rin, scripted(calls), { maxBudgetUsd: 0.6 });

		expect(turn.finished?.payload).toMatchObject({
			outcome: { tag: "Budget" },
			usage: { input_tokens: 3000, cost_usd: 0.75 },
			tool_calls: 3,
		});
	});

	it("passes the caps, the Agent's model and every Tool to the model", async () => {
		let seen: ModelRequest | undefined;
		const model: RunModel = async (request) => {
			seen = request;
			return scripted([])(request);
		};

		await run(rin, model, { maxTurns: 3, maxBudgetUsd: 0.5 });

		expect(seen).toMatchObject({
			model: "claude-sonnet-5-5",
			maxTurns: 3,
			maxBudgetUsd: 0.5,
			cwd: join(home, "scratch"),
		});
		expect(seen?.tools).toHaveLength(25);
	});

	it("records Error with the message when the model call throws, so no Turn stays open", async () => {
		const { turn } = await run(
			rin,
			scripted([{ tool: "verify_ledger", input: {} }], {
				tag: "Throws",
				message: "the claude CLI exited with code 1",
			}),
		);

		expect(turn.finished?.payload).toMatchObject({
			outcome: { tag: "Error", message: "the claude CLI exited with code 1" },
			usage: { input_tokens: 0, cost_usd: 0 },
			tool_calls: 1,
		});
		expect(s.ledger.projections.turns.open.size).toBe(0);
		expect(s.events().at(-1)).toMatchObject({
			kind: "VitalitySampled",
			causation_id: s.events().at(-2)?.seq,
		});
	});
});

describe("a Turn that may not start", () => {
	const refusedBeforeAnyEvent = async (agent: AgentId, reason: string) => {
		const before = s.events().length;
		let called = false;
		const model: RunModel = async (request) => {
			called = true;
			return scripted([])(request);
		};

		await expect(run(agent, model)).rejects.toThrow(
			`TurnStarted refused: ${reason}`,
		);
		expect(s.events().length, "no Event is appended").toBe(before);
		expect(called, "the model is never called").toBe(false);
	};

	it("is refused for a resting Agent", async () => {
		orderRest(s.ledger, {
			actor: { tag: "Operator" },
			agent_id: rin,
			action: "begin",
			reason: "fatigue",
		});
		await refusedBeforeAnyEvent(rin, "A-rin is resting");
	});

	it("is refused for a paused Agent", async () => {
		pause(s.ledger, {
			actor: { tag: "Operator" },
			agent_id: rin,
			reason: "Operator's review",
		});
		await refusedBeforeAnyEvent(rin, "A-rin is paused");
	});

	it("is refused for a retired Agent", async () => {
		s.retire(rin, "Replaced");
		await refusedBeforeAnyEvent(rin, "A-rin is not a live Agent in the Org");
	});

	it("is refused for an Agent with an open Turn", async () => {
		startTurn(s.ledger, {
			agent: rin,
			model: "claude-sonnet-5-5",
			energyBudgetTokens: 1_000_000,
		});
		await refusedBeforeAnyEvent(rin, "A-rin already has an open Turn, TN-1");
	});
});
