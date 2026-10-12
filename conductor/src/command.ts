import type { Readable, Writable } from "node:stream";

/** What a command gets from the `aliquot` dispatcher. */
export type CommandContext = {
	/** The data directory: `--home`, else `ALIQUOT_HOME`, else `./.aliquot`. */
	readonly home: string;
	readonly stdin: Readable;
	readonly stdout: Writable;
	readonly stderr: Writable;
};

/**
 * One subcommand. `aliquot <domain> <name> ...args` calls `run(args, ctx)`,
 * and the number it resolves to is the exit code (0 success, 1 failure,
 * 2 usage error). Parse `args` with `node:util` `parseArgs`. Throw an Error to
 * fail: the dispatcher prints `<name>: <message>` to stderr and exits 1, or 2
 * for a `UsageError` or a `parseArgs` error.
 */
export type Command = {
	/** Argument synopsis for usage, such as `[file]`. */
	readonly args?: string;
	/** One line for usage. */
	readonly describe: string;
	run(args: string[], ctx: CommandContext): Promise<number>;
};

/**
 * A domain's subcommands by name. Each domain directory exports one from
 * `commands.ts`, and `cli.ts` registers it under the domain's name:
 *
 *   export const taskCommands: CommandTable = {
 *     propose: { args: "<file>", describe: "Propose a Task", run: async (args, ctx) => 0 },
 *   };
 */
export type CommandTable = Readonly<Record<string, Command>>;

/** The arguments do not fit the command's synopsis. Exits 2. */
export class UsageError extends Error {
	override readonly name = "UsageError";
}
