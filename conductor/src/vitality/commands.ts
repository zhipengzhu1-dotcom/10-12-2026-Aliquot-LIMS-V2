import { parseArgs } from "node:util";
import {
	type CommandContext,
	type CommandTable,
	UsageError,
} from "../command.js";
import type { Event } from "../events.js";
import { AgentId, TaskId } from "../ids.js";
import { type Ledger, openLedger } from "../ledger.js";
import { orgState } from "../org/projection.js";
import type { Actor } from "../types/actor.js";
import { Score } from "../types/merit.js";
import type { Policy, Vitality } from "../types/vitality.js";
import {
	type AgentVitality,
	tierRevisions,
	vitalityProjection,
} from "./projection.js";
import { sampleVitality } from "./vitality.js";
import { mean, scoresOf } from "./work.js";

/**
 * Tokens per 5-hour window for the whole society when `--budget` is not
 * given. A cautious placeholder until slice 1 measures real use.
 */
export const DEFAULT_ENERGY_BUDGET_TOKENS = 1_000_000;

const OPERATOR: Actor = { tag: "Operator" };

const parseId = <T>(
	schema: {
		safeParse(v: unknown): { success: true; data: T } | { success: false };
	},
	text: string | undefined,
	expected: string,
): T => {
	const parsed = schema.safeParse(text);
	if (!parsed.success) {
		throw new UsageError(`${expected}, not ${JSON.stringify(text ?? "")}`);
	}
	return parsed.data;
};

const agentId = (text: string | undefined) =>
	parseId(AgentId, text, "expected an Agent id like A-rin");

/** `Operator`, or an Agent id. */
const actorArg = (text: string | undefined): Actor =>
	text === undefined || text === "Operator"
		? OPERATOR
		: {
				tag: "Agent",
				id: parseId(
					AgentId,
					text,
					"--as must be Operator or an Agent id like A-thorne",
				),
			};

const who = (actor: Actor) =>
	actor.tag === "Operator" ? "Operator" : actor.id;

const atMostOne = (positionals: string[], command: string) => {
	if (positionals.length > 1) {
		throw new UsageError(`vitality ${command} takes at most one Agent id`);
	}
	return positionals[0] === undefined ? undefined : agentId(positionals[0]);
};

/** A whole number of tokens; `--budget` must also be above 0. */
const tokens = (text: string | undefined, flag: string, fallback: number) => {
	if (text === undefined) return fallback;
	if (!/^[0-9]+$/.test(text) || (flag === "--budget" && Number(text) === 0)) {
		throw new UsageError(
			`${flag} must be a whole number of tokens${flag === "--budget" ? " above 0" : ""}, not ${JSON.stringify(text)}`,
		);
	}
	return Number(text);
};

const required = (value: string | undefined, flag: string): string => {
	if (value === undefined || value.trim() === "") {
		throw new UsageError(`${flag} is required`);
	}
	return value;
};

const score = (text: string | undefined, flag: string): Score => {
	if (!/^[0-3]$/.test(required(text, flag))) {
		throw new UsageError(
			`${flag} must be a score 0, 1, 2 or 3, not ${JSON.stringify(text)}`,
		);
	}
	return Score.parse(Number(text));
};

const withLedger = <T>(
	ctx: CommandContext,
	writer: boolean,
	use: (ledger: Ledger) => T,
): T => {
	const ledger = openLedger({ home: ctx.home, writer });
	try {
		return use(ledger);
	} finally {
		ledger.close();
	}
};

const liveAgents = (events: readonly Event[], only: AgentId | undefined) => {
	const live = [...orgState(events).agents.values()]
		.filter((a) => !a.retired)
		.map((a) => a.definition);
	if (only === undefined) return live;
	const one = live.find((d) => d.id === only);
	if (one === undefined)
		throw new Error(`${only} is not a live Agent in the Org`);
	return [one];
};

const n2 = (x: number) => x.toFixed(2);

const vector = (v: Vitality) =>
	`load=${n2(v.load)} fatigue=${n2(v.fatigue)} friction=${n2(v.friction)} confidence=${n2(v.confidence)} morale=${n2(v.morale)}`;

const flags = (p: Policy) => {
	const on = (Object.keys(p) as (keyof Policy)[]).filter((k) => p[k]);
	return on.length === 0 ? "-" : on.join(",");
};

const line = (id: AgentId, name: string, a: AgentVitality) =>
	`${id} ${name} ${vector(a.vitality)} mood=${a.mood} policy=${flags(a.policy)} merit=${a.merit === undefined ? "-" : n2(a.merit)} reviewed=${a.reviewedTasks} tier=${a.tier} (${a.sampled ? "sampled" : "computed"})`;

export const vitalityCommands: CommandTable = {
	show: {
		args: "[A-<id>]",
		describe:
			"Print each live Agent's Vitality, Mood, Policy, Merit, reviewed Tasks and Trust tier",
		run: async (args, ctx) => {
			const { positionals } = parseArgs({ args, allowPositionals: true });
			const only = atMostOne(positionals, "show");
			const events = withLedger(ctx, false, (l) => l.all());
			const view = vitalityProjection(events, {
				now: new Date(),
				energyBudgetTokens: DEFAULT_ENERGY_BUDGET_TOKENS,
			});
			for (const d of liveAgents(events, only)) {
				const a = view.get(d.id);
				if (a !== undefined) ctx.stdout.write(`${line(d.id, d.name, a)}\n`);
			}
			return 0;
		},
	},
	sample: {
		args: "[A-<id>] [--tokens <n>] [--budget <n>]",
		describe:
			"Append a VitalitySampled computed from the Ledger for one Agent, or every live Agent",
		run: async (args, ctx) => {
			const { positionals, values } = parseArgs({
				args,
				allowPositionals: true,
				options: { tokens: { type: "string" }, budget: { type: "string" } },
			});
			const only = atMostOne(positionals, "sample");
			if (values.tokens !== undefined && only === undefined) {
				throw new UsageError("vitality sample --tokens needs one Agent id");
			}
			const tokensUsedInWindow = tokens(values.tokens, "--tokens", 0);
			const energyBudgetTokens = tokens(
				values.budget,
				"--budget",
				DEFAULT_ENERGY_BUDGET_TOKENS,
			);
			return withLedger(ctx, true, (ledger) => {
				const events = ledger.all();
				const now = new Date();
				for (const d of liveAgents(events, only)) {
					const v = sampleVitality(events, d.id, {
						now,
						energyBudgetTokens,
						tokensUsedInWindow,
					});
					ledger.append({
						actor: OPERATOR,
						kind: "VitalitySampled",
						payload: v,
					});
					ctx.stdout.write(`Sampled ${d.id}: ${vector(v)}\n`);
				}
				return 0;
			});
		},
	},
	rest: {
		args: "<A-id> --begin|--end --reason <text> [--as <A-id>]",
		describe: "Order Rest for an Agent, or end it",
		run: async (args, ctx) => {
			const { positionals, values } = parseArgs({
				args,
				allowPositionals: true,
				options: {
					begin: { type: "boolean" },
					end: { type: "boolean" },
					reason: { type: "string" },
					as: { type: "string" },
				},
			});
			if (positionals.length !== 1)
				throw new UsageError("vitality rest takes one Agent id");
			const id = agentId(positionals[0]);
			if (Boolean(values.begin) === Boolean(values.end)) {
				throw new UsageError(
					"vitality rest needs exactly one of --begin or --end",
				);
			}
			const action = values.begin ? "begin" : "end";
			withLedger(ctx, true, (ledger) =>
				ledger.append({
					actor: actorArg(values.as),
					kind: "RestOrdered",
					payload: {
						agent_id: id,
						action,
						reason: required(values.reason, "--reason"),
					},
				}),
			);
			ctx.stdout.write(`Rest ${action}s for ${id}\n`);
			return 0;
		},
	},
	review: {
		args: "<T-n> --quality <0-3> --traceability <0-3> --boundary <0-3> --collaboration <0-3> --timeliness <0-3> --note <text> [--as <Operator|A-id>]",
		describe: "Record a Review of a completed Task as the Operator or an Agent",
		run: async (args, ctx) => {
			const { positionals, values } = parseArgs({
				args,
				allowPositionals: true,
				options: {
					quality: { type: "string" },
					traceability: { type: "string" },
					boundary: { type: "string" },
					collaboration: { type: "string" },
					timeliness: { type: "string" },
					note: { type: "string" },
					as: { type: "string" },
				},
			});
			if (positionals.length !== 1)
				throw new UsageError("vitality review takes one Task id");
			const task_id = parseId(
				TaskId,
				positionals[0],
				"expected a Task id like T-1",
			);
			const reviewer = actorArg(values.as);
			if (values.note === undefined) throw new UsageError("--note is required");
			const review = {
				task_id,
				reviewer,
				quality: score(values.quality, "--quality"),
				traceability: score(values.traceability, "--traceability"),
				boundary_adherence: score(values.boundary, "--boundary"),
				collaboration: score(values.collaboration, "--collaboration"),
				timeliness: score(values.timeliness, "--timeliness"),
				note: values.note,
			};
			withLedger(ctx, true, (ledger) =>
				ledger.append({
					actor: reviewer,
					task_id,
					kind: "ReviewRecorded",
					payload: review,
				}),
			);
			ctx.stdout.write(
				`Recorded a Review of ${task_id} by ${who(reviewer)}: mean ${n2(mean(scoresOf(review)))}\n`,
			);
			return 0;
		},
	},
	tiers: {
		args: "[--apply]",
		describe:
			"List the Revisions that bring each Trust tier in line with Merit; --apply appends them",
		run: async (args, ctx) => {
			const { values } = parseArgs({
				args,
				options: { apply: { type: "boolean" } },
			});
			return withLedger(ctx, Boolean(values.apply), (ledger) => {
				const revisions = tierRevisions(ledger.all());
				if (revisions.length === 0) {
					ctx.stdout.write(
						"Every Trust tier is in line with Merit; nothing to revise\n",
					);
					return 0;
				}
				for (const r of revisions) {
					if (r.kind !== "AgentDefinitionRevised") continue;
					const d = r.payload.definition;
					if (values.apply) {
						ledger.append(r);
						ctx.stdout.write(
							`Revised ${d.id} to version ${d.version}: ${d.revision_reason}\n`,
						);
					} else {
						ctx.stdout.write(`${d.id} ${d.name}: ${d.revision_reason}\n`);
					}
				}
				if (!values.apply) {
					const noun = revisions.length === 1 ? "Revision" : "Revisions";
					const it = revisions.length === 1 ? "it" : "them";
					ctx.stdout.write(
						`${revisions.length} ${noun} needed; run vitality tiers --apply to append ${it}\n`,
					);
				}
				return 0;
			});
		},
	},
};
