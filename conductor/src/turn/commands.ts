import { parseArgs } from "node:util";
import { parseOrUsage, withLedger } from "../cli-support.js";
import type { CommandTable } from "../command.js";
import { AgentId } from "../ids.js";
import type { TurnOutcome } from "../types/turn.js";
import type { TurnRecord } from "./projection.js";

const outcomeText = (outcome: TurnOutcome) =>
	outcome.tag === "Error" ? `Error: ${outcome.message}` : outcome.tag;

const line = ({ started, at, finished }: TurnRecord) => {
	const head = `${started.turn_id} ${started.agent} model=${started.model} started=${at}`;
	if (finished === undefined) return `${head} finished=- outcome=open`;
	const { usage, outcome, tool_calls } = finished.payload;
	return `${head} finished=${finished.at} input=${usage.input_tokens} output=${usage.output_tokens} cache_creation=${usage.cache_creation_tokens} cache_read=${usage.cache_read_tokens} cost_usd=${usage.cost_usd} tool_calls=${tool_calls} outcome=${outcomeText(outcome)}`;
};

export const turnCommands: CommandTable = {
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
