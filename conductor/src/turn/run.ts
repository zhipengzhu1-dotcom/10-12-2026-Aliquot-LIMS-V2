import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { orRefuse } from "../append-guard.js";
import type { AgentId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import { liveAgent } from "../org/projection.js";
import { callTool } from "../tools/hook.js";
import { TOOLS } from "../tools/table.js";
import { toolContext } from "../tools/tool.js";
import type { Mood, Vitality } from "../types/vitality.js";
import { currentMood } from "../vitality/mood.js";
import type { Login } from "./auth.js";
import { finishTurn, sampleAfterTurn, startTurn } from "./lifecycle.js";
import { type ModelResult, NO_USAGE, type RunModel } from "./model.js";
import type { TurnRecord } from "./projection.js";
import { turnPrompt } from "./prompt.js";

export type TurnOptions = {
	readonly home: string;
	readonly agent: AgentId;
	readonly maxTurns: number;
	readonly maxBudgetUsd: number | undefined;
	readonly energyBudgetTokens: number;
	readonly login: Login;
	readonly runModel: RunModel;
};

/** A finished Turn, the Vitality sampled after it, and the Mood that gives. */
export type TurnRun = {
	readonly turn: TurnRecord;
	readonly vitality: Vitality;
	readonly mood: Mood;
};

/**
 * Run one Turn of one Agent: start it, build its prompt from the Ledger, call
 * the model with the Agent's Tools, finish it with the usage and outcome the
 * model reports and the number of Tool calls, then sample the Agent's
 * Vitality naming the TurnFinished. A model call that throws still finishes
 * the Turn, with outcome Error, so no Turn stays open.
 */
export const runTurn = async (
	ledger: Ledger,
	{
		home,
		agent,
		maxTurns,
		maxBudgetUsd,
		energyBudgetTokens,
		login,
		runModel,
	}: TurnOptions,
): Promise<TurnRun> => {
	const { definition } = orRefuse(
		"TurnStarted",
		liveAgent(ledger.projections.org, agent),
	);
	const { turn } = startTurn(ledger, {
		agent,
		model: definition.model,
		energyBudgetTokens,
	});
	const { turn_id, model } = turn.started;
	const ctx = toolContext({ ledger, home, agent });
	let toolCalls = 0;
	const cwd = join(home, "scratch");
	let result: ModelResult;
	try {
		mkdirSync(cwd, { recursive: true });
		result = await runModel({
			model,
			prompt: turnPrompt(ledger.projections, turn, ledger.now()),
			call: (tool, input) => {
				toolCalls += 1;
				return callTool(ctx, tool, input);
			},
			tools: TOOLS.map((t) => t.name),
			maxTurns,
			maxBudgetUsd,
			cwd,
			login,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		result = {
			outcome: { tag: "Error", message: message || "the model call failed" },
			usage: NO_USAGE,
		};
	}
	const finished = finishTurn(ledger, {
		turn_id,
		usage: result.usage,
		outcome: result.outcome,
		tool_calls: toolCalls,
	});
	const { vitality } = sampleAfterTurn(ledger, {
		agent,
		finished: finished.seq,
		now: ledger.now(),
		energyBudgetTokens,
	});
	return {
		turn: finished.turn,
		vitality,
		mood: currentMood(),
	};
};
