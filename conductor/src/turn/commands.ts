import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
	fromInvocation,
	parseOrThrow,
	parseOrUsage,
	withLedger,
} from "../cli-support.js";
import { type CommandTable, UsageError } from "../command.js";
import { AgentId } from "../ids.js";
import { sdkModel } from "../tools/sdk.js";
import type { TurnOutcome } from "../types/turn.js";
import type { Vitality } from "../types/vitality.js";
import { DEFAULT_ENERGY_BUDGET_TOKENS } from "../vitality/commands.js";
import { loginFrom, loginText } from "./auth.js";
import { type RunModel, ScriptedModel, scriptedModel } from "./model.js";
import type { TurnRecord } from "./projection.js";
import { runTurn } from "./run.js";

const outcomeText = (outcome: TurnOutcome) =>
	outcome.tag === "Error" ? `Error: ${outcome.message}` : outcome.tag;

const line = ({ started, at, finished }: TurnRecord) => {
	const head = `${started.turn_id} ${started.agent} model=${started.model} started=${at}`;
	if (finished === undefined) return `${head} finished=- outcome=open`;
	const { usage, outcome, tool_calls } = finished.payload;
	return `${head} finished=${finished.at} input=${usage.input_tokens} output=${usage.output_tokens} cache_creation=${usage.cache_creation_tokens} cache_read=${usage.cache_read_tokens} cost_usd=${usage.cost_usd} tool_calls=${tool_calls} outcome=${outcomeText(outcome)}`;
};

const n2 = (x: number) => x.toFixed(2);

const vector = (v: Vitality) =>
	`load=${n2(v.load)} fatigue=${n2(v.fatigue)} friction=${n2(v.friction)} confidence=${n2(v.confidence)} morale=${n2(v.morale)}`;

/** The environment variable naming a scripted model's JSON file. */
export const SCRIPTED_MODEL_VARIABLE = "ALIQUOT_SCRIPTED_MODEL";

/** The real model, or the scripted one when the variable names its file. */
const chosenModel = (): { run: RunModel; text: string } => {
	const file = process.env[SCRIPTED_MODEL_VARIABLE];
	if (file === undefined || file === "") {
		return { run: sdkModel, text: "the Agent SDK" };
	}
	const path = fromInvocation(file);
	const script = parseOrThrow(
		ScriptedModel,
		JSON.parse(readFileSync(path, "utf8")),
		`${SCRIPTED_MODEL_VARIABLE} ${path}`,
	);
	return { run: scriptedModel(script), text: `the scripted model in ${path}` };
};

const positiveWhole = (text: string, flag: string) => {
	if (!/^[0-9]+$/.test(text) || Number(text) === 0) {
		throw new UsageError(
			`${flag} must be a whole number above 0, not ${JSON.stringify(text)}`,
		);
	}
	return Number(text);
};

const positiveUsd = (text: string | undefined) => {
	if (text === undefined) return undefined;
	const usd = Number(text);
	if (!/^[0-9]*\.?[0-9]+$/.test(text) || !(usd > 0)) {
		throw new UsageError(
			`--max-budget-usd must be a number of USD above 0, not ${JSON.stringify(text)}`,
		);
	}
	return usd;
};

export const turnCommands: CommandTable = {
	run: {
		args: "<agent> [--max-turns <n>] [--max-budget-usd <usd>]",
		describe:
			"Run one Turn of one Agent with its Tools, record it, sample its Vitality, and print the Turn, the sample and the Mood",
		run: async (args, ctx) => {
			const { values, positionals } = parseArgs({
				args,
				allowPositionals: true,
				options: {
					"max-turns": { type: "string", default: "20" },
					"max-budget-usd": { type: "string" },
				},
			});
			if (positionals.length !== 1) {
				throw new UsageError("turn run takes one Agent id");
			}
			const agent = parseOrUsage(
				AgentId,
				positionals[0],
				"turn run takes an Agent id like A-rin",
			);
			const maxTurns = positiveWhole(values["max-turns"], "--max-turns");
			const maxBudgetUsd = positiveUsd(values["max-budget-usd"]);
			const login = loginFrom(process.env);
			if (login.tag === "ApiKey" && maxBudgetUsd === undefined) {
				throw new UsageError(
					`a Turn on ${loginText(login)} needs --max-budget-usd`,
				);
			}
			const model = chosenModel();
			const { turn, vitality, mood } = await withLedger(
				ctx.home,
				true,
				(ledger) =>
					runTurn(ledger, {
						home: ctx.home,
						agent,
						maxTurns,
						maxBudgetUsd,
						energyBudgetTokens: DEFAULT_ENERGY_BUDGET_TOKENS,
						login,
						runModel: model.run,
					}),
			);
			ctx.stdout.write(
				[
					line(turn),
					`Model: ${model.text}, on ${loginText(login)}`,
					`Sampled ${agent}: ${vector(vitality)}`,
					`Mood: ${mood}`,
					"",
				].join("\n"),
			);
			return turn.finished?.payload.outcome.tag === "Error" ? 1 : 0;
		},
	},
	list: {
		args: "[--agent A-<id>]",
		describe:
			"Print each Turn, or one Agent's, with its start and finish time, usage and outcome",
		run: async (args, ctx) => {
			const { values } = parseArgs({
				args,
				options: { agent: { type: "string" } },
			});
			const agent =
				values.agent === undefined
					? undefined
					: parseOrUsage(
							AgentId,
							values.agent,
							"--agent expects an Agent id like A-rin",
						);
			const { turns } = withLedger(
				ctx.home,
				false,
				(ledger) => ledger.projections.turns,
			);
			const listed = [...turns.values()].filter(
				(t) => agent === undefined || t.started.agent === agent,
			);
			ctx.stdout.write(
				listed.length === 0 ? "No Turns\n" : `${listed.map(line).join("\n")}\n`,
			);
			return 0;
		},
	},
};
