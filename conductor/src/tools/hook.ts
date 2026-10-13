import { z } from "zod";
import { AppendRefused, refusalText } from "../append-guard.js";
import { TaskId } from "../ids.js";
import type { Projections } from "../projections.js";
import type { Action } from "../types/action.js";
import { ACTIONS, charterActions, performs, type ToolCall } from "./actions.js";
import { recordRefusal } from "./lifecycle.js";
import { toolNamed } from "./table.js";
import { type Tool, type ToolContext, ToolRefused } from "./tool.js";

/** Why the hook refuses a call: the Action the Charter forbids. */
export type HookRefusal = {
	readonly action: Action;
	readonly reason: string;
};

/**
 * The hook's verdict on one call, before it runs: refused when the Agent's
 * Charter forbids an Action the call performs. Mood is flat (#62), so no
 * Policy refuses a call.
 */
export const refusalOf = (
	call: ToolCall,
	projections: Projections,
): HookRefusal | undefined => {
	const definition = projections.org.agents.get(call.agent)?.definition;
	const forbidden = definition ? charterActions(definition) : new Set();
	for (const rule of ACTIONS) {
		if (!forbidden.has(rule.action)) continue;
		const why = performs(rule, call, projections);
		if (why !== undefined) {
			return {
				action: rule.action,
				reason: `${call.agent}'s Charter forbids ${rule.action}: ${why}`,
			};
		}
	}
	return undefined;
};

/**
 * How one call ended: Done with the Tool's result, Refused by the hook, the
 * Ledger or the Tool itself, or Invalid input. The text is what the model
 * reads.
 */
export type Outcome = {
	readonly tag: "Done" | "Refused" | "Invalid";
	readonly text: string;
};

/**
 * Call the Tool `name` as the context's Agent: parse the input, run the hook,
 * which records a refusal as `ActionRefused`, then run the Tool. A refusal by
 * the Ledger or the Tool comes back as its text.
 */
export const callTool = async (
	ctx: ToolContext,
	name: string,
	raw: unknown,
): Promise<Outcome> => {
	const tool: Tool | undefined = toolNamed(name);
	if (tool === undefined) {
		return { tag: "Invalid", text: `no Tool is named ${name}` };
	}
	const parsed = tool.input.safeParse(raw);
	if (!parsed.success) {
		return {
			tag: "Invalid",
			text: `${name} input: ${z.prettifyError(parsed.error)}`,
		};
	}
	const input = parsed.data;
	// The input parsed by the named Tool's own schema, so name and input agree.
	const call = {
		agent: ctx.agent,
		stages: ctx.stages,
		name,
		input,
	} as ToolCall;
	const refusal = refusalOf(call, ctx.ledger.projections);
	if (refusal !== undefined) {
		const task_id = TaskId.safeParse(input.task_id).data;
		recordRefusal(ctx.ledger, {
			agent: ctx.agent,
			tool: name,
			...refusal,
			...(task_id === undefined ? {} : { task_id }),
		});
		return { tag: "Refused", text: refusalText(name, refusal.reason) };
	}
	try {
		return { tag: "Done", text: await tool.call(ctx, input) };
	} catch (error) {
		if (error instanceof AppendRefused) {
			return { tag: "Refused", text: error.message };
		}
		if (error instanceof ToolRefused) {
			return { tag: "Refused", text: refusalText(name, error.message) };
		}
		throw error;
	}
};
