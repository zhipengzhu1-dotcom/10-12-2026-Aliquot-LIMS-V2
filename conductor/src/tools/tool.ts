import type { z } from "zod";
import type { AgentId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import { liveAgent } from "../org/projection.js";
import { Refusal } from "../reduce.js";
import type { Action } from "../types/action.js";
import { STAGES, type Stage } from "../workflow/stages.js";

/**
 * What every Tool call of one Agent runs against. The Agent is fixed here,
 * never read from a call's input, so a Tool cannot act as another Agent.
 */
export type ToolContext = {
	readonly ledger: Ledger;
	readonly home: string;
	readonly agent: AgentId;
	/** The toy workflow, which `run_script` and the Action predicates read. */
	readonly stages: readonly Stage[];
	readonly timeoutMs: number;
};

/** The context for a live Agent, or an Error naming why there is none. */
export const toolContext = ({
	stages = STAGES,
	timeoutMs = 60_000,
	...rest
}: Pick<ToolContext, "ledger" | "home" | "agent"> &
	Partial<Pick<ToolContext, "stages" | "timeoutMs">>): ToolContext => {
	const live = liveAgent(rest.ledger.projections.org, rest.agent);
	if (live instanceof Refusal) throw new Error(live.reason);
	return { ...rest, stages, timeoutMs };
};

/**
 * One row of the Tool table: a Ledger-backed verb the Agent calls with
 * itself as actor, its input shape, and the plain Action it performs.
 */
export type Tool<
	N extends string = string,
	S extends z.ZodRawShape = z.ZodRawShape,
> = {
	readonly name: N;
	readonly description: string;
	readonly input: z.ZodObject<S, z.core.$strict>;
	readonly action: Action | undefined;
	/** The Event the verb appended, or the Projection it read, as JSON text. */
	call(
		ctx: ToolContext,
		input: z.output<z.ZodObject<S, z.core.$strict>>,
	): Promise<string>;
};

/**
 * A Tool's own refusal of its input, such as an Artifact the Ledger does not
 * hold. Like the Ledger's refusals, its text goes back to the model.
 */
export class ToolRefused extends Error {
	override readonly name = "ToolRefused";
}

/** JSON with each Map as an object keyed by id and each Set as an array. */
export const asText = (value: unknown): string =>
	JSON.stringify(
		value,
		(_key, v: unknown) =>
			v instanceof Map ? Object.fromEntries(v) : v instanceof Set ? [...v] : v,
		2,
	);
