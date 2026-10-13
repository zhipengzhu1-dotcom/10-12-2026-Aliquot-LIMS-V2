import { parseArgs } from "node:util";
import { parseOrUsage, parseTimeout, withLedger } from "../cli-support.js";
import { type CommandTable, UsageError } from "../command.js";
import { AgentId } from "../ids.js";
import { liveAgent } from "../org/projection.js";
import { Refusal } from "../reduce.js";
import type { Action } from "../types/action.js";
import { ACTIONS, charterActions } from "./actions.js";
import { callTool } from "./hook.js";
import { TOOLS } from "./table.js";
import { toolContext } from "./tool.js";

const agentArg = (value: string | undefined, command: string) =>
	parseOrUsage(AgentId, value, `tools ${command} takes an Agent id like A-rin`);

/**
 * One line per Tool: what it does, or the plain Action that the Charter
 * forbids it, or the relational Actions that refuse some of its calls.
 */
const listing = (forbidden: ReadonlySet<Action>): string[] => {
	const rules = ACTIONS.filter((r) => forbidden.has(r.action));
	const width = Math.max(...TOOLS.map((t) => t.name.length));
	return TOOLS.map((tool) => {
		const name = tool.name.padEnd(width);
		const covering = rules.filter((r) => r.covers.includes(tool.name));
		const plain = covering.find((r) => r.when === undefined);
		if (plain !== undefined) return `${name}  refused: ${plain.action}`;
		const when = covering.map((r) => r.action);
		return when.length === 0
			? `${name}  ${tool.description}`
			: `${name}  ${tool.description} (refused when it is ${when.join(" or ")})`;
	});
};

export const toolCommands: CommandTable = {
	list: {
		args: "<agent>",
		describe:
			"Print the Tools an Agent may use given its Charter, and the Actions that refuse the rest",
		run: async (args, ctx) => {
			const { positionals } = parseArgs({ args, allowPositionals: true });
			if (positionals.length !== 1) {
				throw new UsageError("tools list takes one Agent id");
			}
			const agent = agentArg(positionals[0], "list");
			const forbidden = withLedger(ctx.home, false, (ledger) => {
				const live = liveAgent(ledger.projections.org, agent);
				if (live instanceof Refusal) throw new Error(live.reason);
				return charterActions(live.definition);
			});
			const head =
				forbidden.size === 0
					? `${agent}'s Charter forbids no Action`
					: `${agent}'s Charter forbids ${[...forbidden].join(", ")}`;
			ctx.stdout.write(`${[head, ...listing(forbidden)].join("\n")}\n`);
			return 0;
		},
	},
	call: {
		args: "<agent> <tool> [json] [--timeout <ms>]",
		describe:
			"Call one Tool as an Agent through the hook, and print its result or its refusal",
		run: async (args, ctx) => {
			const { values, positionals } = parseArgs({
				args,
				allowPositionals: true,
				options: { timeout: { type: "string", default: "60000" } },
			});
			const [agentText, name, json = "{}", ...extra] = positionals;
			if (name === undefined || extra.length > 0) {
				throw new UsageError("tools call takes <agent> <tool> [json]");
			}
			const agent = agentArg(agentText, "call");
			const timeoutMs = parseTimeout(values.timeout);
			let input: unknown;
			try {
				input = JSON.parse(json);
			} catch (error) {
				throw new UsageError(
					`tools call: the input is not JSON: ${(error as Error).message}`,
				);
			}
			const { tag, text } = await withLedger(ctx.home, true, (ledger) =>
				callTool(
					toolContext({ ledger, home: ctx.home, agent, timeoutMs }),
					name,
					input,
				),
			);
			if (tag === "Invalid") throw new UsageError(text);
			if (tag === "Refused") {
				ctx.stderr.write(`${text}\n`);
				return 1;
			}
			ctx.stdout.write(`${text}\n`);
			return 0;
		},
	},
};
