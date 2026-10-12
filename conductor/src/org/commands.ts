import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
	type CommandContext,
	type CommandTable,
	UsageError,
} from "../command.js";
import type { NewEvent } from "../events.js";
import { AgentId } from "../ids.js";
import { type Ledger, openLedger } from "../ledger.js";
import type { Actor } from "../types/actor.js";
import { AgentDefinition } from "../types/agent-definition.js";
import { orgState, renderTree, tree } from "./projection.js";
import { rosterDefinitions, seedOrg } from "./seed.js";

const options = {
	reason: { type: "string" },
	as: { type: "string" },
} as const;

/** Parse `<id> [more positionals] [--reason R] [--as A-<id>]`. */
const parse = (command: string, args: string[], positionals: string[]) => {
	const parsed = parseArgs({ args, options, allowPositionals: true });
	if (parsed.positionals.length !== positionals.length) {
		throw new UsageError(
			`org ${command} takes ${positionals.map((p) => `<${p}>`).join(" ")}`,
		);
	}
	const id = AgentId.safeParse(parsed.positionals[0]);
	if (!id.success) {
		throw new UsageError(
			`org ${command}: ${parsed.positionals[0]} is not an Agent id (A-<slug>)`,
		);
	}
	const as = parsed.values.as;
	let actor: Actor = { tag: "Operator" };
	if (as !== undefined) {
		const asId = AgentId.safeParse(as);
		if (!asId.success) {
			throw new UsageError(`org ${command}: --as ${as} is not an Agent id`);
		}
		actor = { tag: "Agent", id: asId.data };
	}
	return {
		id: id.data,
		rest: parsed.positionals.slice(1),
		reason: parsed.values.reason,
		actor,
	};
};

const needReason = (command: string, reason: string | undefined) => {
	if (reason === undefined || reason.trim() === "") {
		throw new UsageError(`org ${command} needs --reason`);
	}
	return reason;
};

const withWriter = <T>(ctx: CommandContext, use: (ledger: Ledger) => T): T => {
	const ledger = openLedger({ home: ctx.home, writer: true });
	try {
		return use(ledger);
	} finally {
		ledger.close();
	}
};

const appendOne = (ctx: CommandContext, event: NewEvent, done: string) => {
	withWriter(ctx, (ledger) => ledger.append(event));
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
			const ids = withWriter(ctx, seedOrg);
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
			const ledger = openLedger({ home: ctx.home, writer: false });
			try {
				ctx.stdout.write(renderTree(tree(orgState(ledger.events()))));
				return 0;
			} finally {
				ledger.close();
			}
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
		args: "<id> --reason <text> [--as <agent>]",
		describe: "Retire an Agent; its Events stay in the Ledger",
		run: async (args, ctx) => {
			const { id, reason, actor } = parse("retire", args, ["id"]);
			return appendOne(
				ctx,
				{
					actor,
					kind: "AgentRetired",
					payload: { agent_id: id, reason: needReason("retire", reason) },
				},
				`Retired ${id}`,
			);
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
