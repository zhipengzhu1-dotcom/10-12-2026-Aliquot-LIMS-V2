import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
	actingAs,
	parseOrThrow,
	parseOrUsage,
	personOf,
	withLedger,
} from "../cli-support.js";
import {
	type CommandContext,
	type CommandTable,
	UsageError,
} from "../command.js";
import { requestGate } from "../gate/lifecycle.js";
import { AgentId, GateId } from "../ids.js";
import { AgentDefinition } from "../types/agent-definition.js";
import { pause, resume, retire, revise } from "./lifecycle.js";
import { renderTree, tree } from "./projection.js";
import { rosterDefinitions, seedOrg } from "./seed.js";

const options = {
	reason: { type: "string" },
	as: { type: "string" },
	gate: { type: "string" },
} as const;

/** Parse `<id> [more positionals] [--reason R] [--as A-<id>]`. */
const parse = (
	ctx: CommandContext,
	command: string,
	args: string[],
	positionals: string[],
) => {
	const parsed = parseArgs({ args, options, allowPositionals: true });
	if (parsed.positionals.length !== positionals.length) {
		throw new UsageError(
			`org ${command} takes ${positionals.map((p) => `<${p}>`).join(" ")}`,
		);
	}
	return {
		id: parseOrUsage(
			AgentId,
			parsed.positionals[0],
			`org ${command} takes an Agent id like A-rin`,
		),
		rest: parsed.positionals.slice(1),
		reason: parsed.values.reason,
		as: parsed.values.as,
		gate: parsed.values.gate,
		actor: actingAs(ctx, parsed.values.as),
	};
};

const needReason = (command: string, reason: string | undefined) => {
	if (reason === undefined || reason.trim() === "") {
		throw new UsageError(`org ${command} needs --reason`);
	}
	return reason;
};

const readJson = (file: string): unknown => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`${file} is not a JSON file: ${(error as Error).message}`);
	}
};

export const orgCommands: CommandTable = {
	seed: {
		describe:
			"Recruit the eight-agent starting roster; a second run appends nothing",
		run: async (args, ctx) => {
			parseArgs({ args });
			const by = personOf(ctx);
			const ids = withLedger(ctx.home, true, (ledger) =>
				seedOrg(ledger, by),
			).map((r) => r.agent.definition.id);
			if (ids.length === 0) {
				const count = rosterDefinitions().length;
				ctx.stdout.write(
					`Org already seeded: all ${count} roster Agents are in the Ledger, nothing appended\n`,
				);
				return 0;
			}
			const noun = ids.length === 1 ? "Agent" : "Agents";
			ctx.stdout.write(`Recruited ${ids.length} ${noun}: ${ids.join(", ")}\n`);
			return 0;
		},
	},
	tree: {
		describe: "Print the reporting tree of live Agents under the Operator",
		run: async (args, ctx) => {
			parseArgs({ args });
			const state = withLedger(ctx.home, false, (l) => l.projections.org);
			ctx.stdout.write(renderTree(tree(state)));
			return 0;
		},
	},
	pause: {
		args: "<id> --reason <text> [--as <agent>]",
		describe: "Pause an Agent",
		run: async (args, ctx) => {
			const { id, reason, actor } = parse(ctx, "pause", args, ["id"]);
			const why = needReason("pause", reason);
			withLedger(ctx.home, true, (ledger) =>
				pause(ledger, { actor, agent_id: id, reason: why }),
			);
			ctx.stdout.write(`Paused ${id}\n`);
			return 0;
		},
	},
	resume: {
		args: "<id> [--as <agent>]",
		describe: "Resume a paused Agent",
		run: async (args, ctx) => {
			const { id, actor } = parse(ctx, "resume", args, ["id"]);
			withLedger(ctx.home, true, (ledger) =>
				resume(ledger, { actor, agent_id: id }),
			);
			ctx.stdout.write(`Resumed ${id}\n`);
			return 0;
		},
	},
	retire: {
		args: "<id> --reason <text> [--as <agent>] | <id> --gate G-n [--reason <text>]",
		describe:
			"Request a RetireAgent Gate for an Agent, or retire it through the approved Gate; its Events stay in the Ledger",
		run: async (args, ctx) => {
			const { id, reason, as, gate, actor } = parse(ctx, "retire", args, [
				"id",
			]);
			if (gate === undefined) {
				const why = needReason("retire", reason);
				const { id: gate_id, payload_hash } = withLedger(
					ctx.home,
					true,
					(ledger) =>
						requestGate(ledger, {
							actor,
							kind: "RetireAgent",
							payload: { agent_id: id, reason: why },
						}).gate,
				);
				ctx.stdout.write(
					`Requested ${gate_id} to retire ${id}; payload hash ${payload_hash}\n` +
						`Decide it with \`aliquot gate decide ${gate_id} --approve --hash ${payload_hash} --reason <text>\`, then run \`aliquot org retire ${id} --gate ${gate_id}\`\n`,
				);
				return 0;
			}
			if (as !== undefined) {
				throw new UsageError(
					"org retire --gate writes as the Operator; --as only names who requests the Gate",
				);
			}
			const gate_id = parseOrUsage(GateId, gate, "--gate must look like G-1");
			withLedger(ctx.home, true, (ledger) =>
				retire(ledger, {
					actor,
					agent_id: id,
					gate_id,
					reason,
				}),
			);
			ctx.stdout.write(`Retired ${id} through ${gate_id}\n`);
			return 0;
		},
	},
	revise: {
		args: "<id> <file.json> [--as <agent>]",
		describe:
			"Revise an Agent definition from a JSON file holding the full next version",
		run: async (args, ctx) => {
			const { id, rest, actor } = parse(ctx, "revise", args, [
				"id",
				"file.json",
			]);
			const [file = ""] = rest;
			const definition = parseOrThrow(
				AgentDefinition,
				readJson(file),
				`${file} is not an Agent definition`,
			);
			if (definition.id !== id) {
				throw new UsageError(
					`org revise ${id}: ${file} defines ${definition.id}, not ${id}`,
				);
			}
			withLedger(ctx.home, true, (ledger) =>
				revise(ledger, { actor, definition }),
			);
			ctx.stdout.write(`Revised ${id} to version ${definition.version}\n`);
			return 0;
		},
	},
};
