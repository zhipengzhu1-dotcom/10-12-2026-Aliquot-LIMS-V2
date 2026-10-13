import { z } from "zod";
import type { Outcome } from "../tools/hook.js";
import { type TurnOutcome, TurnUsage } from "../types/turn.js";
import type { Login } from "./auth.js";
import type { TurnPrompt } from "./prompt.js";

/** Calls one Tool as the Turn's Agent, through the hook. */
export type ToolCaller = (tool: string, input: unknown) => Promise<Outcome>;

/** Everything one Turn's model call gets. */
export type ModelRequest = {
	readonly model: string;
	readonly prompt: TurnPrompt;
	readonly call: ToolCaller;
	/** The Tools the model may call; the Charter's refusals are the hook's. */
	readonly tools: readonly string[];
	readonly maxTurns: number;
	readonly maxBudgetUsd: number | undefined;
	/** A scratch directory: the model has no file Tool, so nothing reads it. */
	readonly cwd: string;
	readonly login: Login;
};

/** What the model reports when it stops. */
export type ModelResult = {
	readonly outcome: TurnOutcome;
	readonly usage: TurnUsage;
};

/** The one boundary between a Turn and its model. It may throw. */
export type RunModel = (request: ModelRequest) => Promise<ModelResult>;

export const NO_USAGE: TurnUsage = {
	input_tokens: 0,
	output_tokens: 0,
	cache_creation_tokens: 0,
	cache_read_tokens: 0,
	cost_usd: 0,
};

const added = (a: TurnUsage, b: TurnUsage): TurnUsage => ({
	input_tokens: a.input_tokens + b.input_tokens,
	output_tokens: a.output_tokens + b.output_tokens,
	cache_creation_tokens: a.cache_creation_tokens + b.cache_creation_tokens,
	cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
	cost_usd: a.cost_usd + b.cost_usd,
});

/** One model's share of a Turn, as the SDK's `modelUsage` reports it. */
export type ModelUsage = {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadInputTokens: number;
	readonly cacheCreationInputTokens: number;
	readonly costUSD: number;
};

/** The SDK's `modelUsage`, summed over models. */
export const usageOf = (
	modelUsage: Readonly<Record<string, ModelUsage>>,
): TurnUsage =>
	Object.values(modelUsage).reduce(
		(sum, m) =>
			added(sum, {
				input_tokens: m.inputTokens,
				output_tokens: m.outputTokens,
				cache_creation_tokens: m.cacheCreationInputTokens,
				cache_read_tokens: m.cacheReadInputTokens,
				cost_usd: m.costUSD,
			}),
		NO_USAGE,
	);

/** The fields of the SDK's result message a Turn's outcome reads. */
export type ResultMessage = {
	readonly subtype: string;
	readonly is_error: boolean;
	readonly result?: string;
	readonly errors?: readonly string[];
};

/** A Turn's outcome from the SDK's result: how it stopped. */
export const outcomeOf = (result: ResultMessage): TurnOutcome => {
	switch (result.subtype) {
		case "success":
			return result.is_error
				? {
						tag: "Error",
						message: result.result || "the model reported an error",
					}
				: { tag: "Completed" };
		case "error_max_turns":
			return { tag: "MaxTurns" };
		case "error_max_budget_usd":
			return { tag: "Budget" };
		default:
			return {
				tag: "Error",
				message: [result.subtype, ...(result.errors ?? [])].join(": "),
			};
	}
};

/**
 * A stand-in model for tests and for a Turn run by hand without the network:
 * it makes `calls` in order, one per round trip of `usage_per_round`, then a
 * last round trip, and stops as `stop` says. Like the SDK, it stops at
 * `maxTurns` round trips, and once its cost passes `maxBudgetUsd`.
 */
export const ScriptedModel = z.strictObject({
	calls: z.array(
		z.strictObject({ tool: z.string().min(1), input: z.unknown() }),
	),
	usage_per_round: TurnUsage,
	stop: z.discriminatedUnion("tag", [
		z.strictObject({ tag: z.literal("Completed") }),
		z.strictObject({ tag: z.literal("Throws"), message: z.string().min(1) }),
	]),
});
export type ScriptedModel = z.infer<typeof ScriptedModel>;

export const scriptedModel =
	({ calls, usage_per_round, stop }: ScriptedModel): RunModel =>
	async ({ call, maxTurns, maxBudgetUsd }) => {
		let usage = NO_USAGE;
		const rounds = [...calls, undefined];
		for (const [round, next] of rounds.entries()) {
			if (round === maxTurns) return { outcome: { tag: "MaxTurns" }, usage };
			usage = added(usage, usage_per_round);
			if (next !== undefined) await call(next.tool, next.input);
			if (maxBudgetUsd !== undefined && usage.cost_usd > maxBudgetUsd) {
				return { outcome: { tag: "Budget" }, usage };
			}
		}
		if (stop.tag === "Throws") throw new Error(stop.message);
		return { outcome: { tag: "Completed" }, usage };
	};
