import { resolve } from "node:path";
import { z } from "zod";
import { type CommandContext, UsageError } from "./command.js";
import { AgentId } from "./ids.js";
import { type Ledger, openLedger } from "./ledger.js";
import { type Actor, type Person, person } from "./types/actor.js";

// Shared by every domain's commands. `actorText` and `nextId` live beside
// `Actor` and the ids so projections and guards can use them without
// importing the Ledger, which imports every guard (ESM cycle).
export { readAll } from "./command.js";
export { nextId } from "./ids.js";
export { actorName, actorText } from "./types/actor.js";

type Parser<T> = {
	safeParse(v: unknown): { success: true; data: T } | { success: false };
};

/**
 * Parse a command-line value with a zod schema, or throw a UsageError:
 * `<what>, not "<value>"`, so `what` says what was expected.
 */
export const parseOrUsage = <T>(
	schema: Parser<T>,
	value: string | undefined,
	what: string,
): T => {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new UsageError(`${what}, not ${JSON.stringify(value ?? "")}`);
	}
	return parsed.data;
};

/**
 * Parse a document, such as JSON read from a file or stdin, with a zod
 * schema, or throw an Error: `<what>: <every problem zod found>`.
 */
export const parseOrThrow = <T>(
	schema: z.ZodType<T>,
	value: unknown,
	what: string,
): T => {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new Error(`${what}: ${z.prettifyError(parsed.error)}`);
	}
	return parsed.data;
};

/**
 * `Operator` or `A-<id>`; the Operator when the flag is absent. The Operator
 * here is a role, such as a reader or a reviewer to be, so it names no person;
 * a command that acts takes its actor from `actingAs`.
 */
export const parseActor = (
	flagValue: string | undefined,
	flag = "--as",
): Actor =>
	flagValue === undefined || flagValue === "Operator"
		? { tag: "Operator" }
		: {
				tag: "Agent",
				id: parseOrUsage(
					AgentId,
					flagValue,
					`${flag} must be Operator or an Agent id like A-odile`,
				),
			};

export const OPERATOR_UNNAMED =
	"this command acts as the Operator, who must be named: pass --operator <email> or set ALIQUOT_OPERATOR";

/** The person the command acts for as the Operator, or an Error that says how to name one. */
export const personOf = (ctx: CommandContext): Person => {
	if (ctx.operator === undefined) throw new Error(OPERATOR_UNNAMED);
	return person(ctx.operator);
};

/** The Agent that `--as` names, or else the person acting as the Operator. */
export const actingAs = (
	ctx: CommandContext,
	flagValue: string | undefined,
): Actor => {
	const actor = parseActor(flagValue);
	return actor.tag === "Agent" ? actor : personOf(ctx);
};

/**
 * Open the Ledger, hand it to `use`, and close it when `use` returns, throws,
 * or (for a Promise) settles.
 */
export const withLedger = <T>(
	home: string,
	writer: boolean,
	use: (ledger: Ledger) => T,
): T => {
	const ledger = openLedger({ home, writer });
	let result: T;
	try {
		result = use(ledger);
	} catch (error) {
		ledger.close();
		throw error;
	}
	if (result instanceof Promise) {
		return result.finally(() => ledger.close()) as T;
	}
	ledger.close();
	return result;
};

/** Relative paths mean relative to where the Operator typed the command. */
export const fromInvocation = (path: string): string =>
	resolve(process.env.INIT_CWD ?? process.cwd(), path);

/** `--timeout`: a positive whole number of ms. */
export const parseTimeout = (text: string): number => {
	const ms = Number(text);
	if (!/^\d+$/.test(text) || ms <= 0) {
		throw new UsageError(
			`--timeout ${text} is not a positive whole number of ms`,
		);
	}
	return ms;
};
