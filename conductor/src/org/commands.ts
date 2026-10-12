import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { parseActor, parseOrUsage, withLedger } from "../cli-support.js";
import {
	type CommandContext,
	type CommandTable,
	UsageError,
} from "../command.js";
import type { NewEvent } from "../events.js";
import { payloadText, projectGates } from "../gate/projection.js";
import { requestGate } from "../gate/request.js";
import { AgentId, GateId } from "../ids.js";
import { AgentDefinition } from "../types/agent-definition.js";
import { orgState, renderTree, tree } from "./projection.js";
import { rosterDefinitions, seedOrg } from "./seed.js";

const options = {
	reason: { type: "string" },
	as: { type: "string" },
	gate: { type: "string" },
} as const;

/** Parse `<id> [more positionals] [--reason R] [--as A-<id>]`. */
const parse = (command: string, args: string[], positionals: string[]) => {
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
		actor: parseActor(parsed.values.as),
	};
};

const needReason = (command: string, reason: string | undefined) => {
	if (reason === undefined || reason.trim() === "") {
		throw new UsageError(`org ${command} needs --reason`);
	}
	return reason;
};

const appendOne = (ctx: CommandContext, event: NewEvent, done: string) => {
	withLedger(ctx.home, true, (ledger) => ledger.append(event));
	ctx.stdout.write(`${done}\n`);
	return 0;
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
			const ids = withLedger(ctx.home, true, seedOrg);
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
			const state = withLedger(ctx.home, false, (l) => orgState(l.events()));
			ctx.stdout.write(renderTree(tree(state)));
			return 0;
		},
	},
	pause: {
		args: "<id> --reason <text> [--as <agent>]",
		describe: "Pause an Agent",
		run: async (args, ctx) => {
			const { id, reason, actor } = parse("pause", args, ["id"]);
			return appendOne(
				ctx,
				{
					actor,
					kind: "AgentPaused",
					payload: { agent_id: id, reason: needReason("pause", reason) },
				},
				`Paused ${id}`,
			);
		},
	},
	resume: {
		args: "<id> [--as <agent>]",
		describe: "Resume a paused Agent",
		run: async (args, ctx) => {
			const { id, actor } = parse("resume", args, ["id"]);
			return appendOne(
				ctx,
				{ actor, kind: "AgentResumed", payload: { agent_id: id } },
				`Resumed ${id}`,
			);
		},
	},
	retire: {
		args: "<id> --reason <text> [--as <agent>] | <id> --gate G-n [--reason <text>]",
		describe:
			"Request a RetireAgent Gate for an Agent, or retire it through the approved Gate; its Events stay in the Ledger",
		run: async (args, ctx) => {
			const { id, reason, as, gate, actor } = parse("retire", args, ["id"]);
			if (gate === undefined) {
				const why = needReason("retire", reason);
				const { gate_id, payload_hash } = withLedger(ctx.home, true, (ledger) =>
					requestGate(ledger, {
						actor,
						kind: "RetireAgent",
						payload: { agent_id: id, reason: why },
					}),
				);
				ctx.stdout.write(
					`Requested ${gate_id} to retire ${id}; payload hash ${payload_hash}\n` +
						`Decide it with \`aliquot gate decide ${gate_id} --approve --reason <text>\`, then run \`aliquot org retire ${id} --gate ${gate_id}\`\n`,
				);
				return 0;
			}
			if (as !== undefined) {
				throw new UsageError(
					"org retire --gate writes as the Operator; --as only names who requests the Gate",
				);
			}
			const gate_id = parseOrUsage(GateId, gate, "--gate must look like G-1");
			withLedger(ctx.home, true, (ledger) => {
				const requested = projectGates(ledger.events()).gates.get(gate_id);
				const gateReason = requested && payloadText(requested, "reason");
				ledger.append({
					actor: { tag: "Operator" },
					kind: "AgentRetired",
					payload: {
						agent_id: id,
						reason: reason ?? gateReason ?? `Retired through ${gate_id}`,
						gate_id,
					},
				});
			});
			ctx.stdout.write(`Retired ${id} through ${gate_id}\n`);
			return 0;
		},
	},
	revise: {
		args: "<id> <file.json> [--as <agent>]",
		describe:
			"Revise an Agent definition from a JSON file holding the full next version",
		run: async (args, ctx) => {
			const { id, rest, actor } = parse("revise", args, ["id", "file.json"]);
			const [file = ""] = rest;
			const parsed = AgentDefinition.safeParse(readJson(file));
			if (!parsed.success) {
				throw new Error(
					`${file} is not an Agent definition: ${z.prettifyError(parsed.error)}`,
				);
			}
			const definition = parsed.data;
			if (definition.id !== id) {
				throw new UsageError(
					`org revise ${id}: ${file} defines ${definition.id}, not ${id}`,
				);
			}
			return appendOne(
				ctx,
				{ actor, kind: "AgentDefinitionRevised", payload: { definition } },
				`Revised ${id} to version ${definition.version}`,
			);
		},
	},
};
