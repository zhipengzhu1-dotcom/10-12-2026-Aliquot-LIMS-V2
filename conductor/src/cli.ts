import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	type CommandContext,
	type CommandTable,
	UsageError,
} from "./command.js";
import { gateCommands } from "./gate/commands.js";
import { ledgerCommands } from "./ledger-commands.js";
import { orgCommands } from "./org/commands.js";
import { roomCommands } from "./room/commands.js";
import { sandboxCommands } from "./sandbox/commands.js";
import { taskCommands } from "./task/commands.js";
import { vitalityCommands } from "./vitality/commands.js";
import { workflowCommands } from "./workflow/commands.js";

/** `aliquot <domain> <command>`. Each domain owns its table. */
const domains: Readonly<Record<string, CommandTable>> = {
	ledger: ledgerCommands,
	org: orgCommands,
	task: taskCommands,
	room: roomCommands,
	gate: gateCommands,
	sandbox: sandboxCommands,
	vitality: vitalityCommands,
	workflow: workflowCommands,
};

const globalOptions = {
	home: { type: "string" },
	help: { type: "boolean", short: "h" },
} as const;

const usage = () => {
	const rows = Object.entries(domains).flatMap(([domain, table]) =>
		Object.entries(table).map(([name, command]) => [
			[domain, name, command.args].filter(Boolean).join(" "),
			command.describe,
		]),
	);
	const width = Math.max(...rows.map(([synopsis]) => synopsis?.length ?? 0));
	const lines = rows.map(
		([synopsis, describe]) => `  ${synopsis?.padEnd(width)}  ${describe}`,
	);
	return `Usage: aliquot <command> [options]

The Conductor's command line.

Options:
  --home <dir>  Data directory (default: $ALIQUOT_HOME, else ./.aliquot)
  -h, --help    Show this help

Commands:
${lines.join("\n")}
`;
};

const isUsageError = (error: unknown) =>
	error instanceof UsageError ||
	(error instanceof Error &&
		"code" in error &&
		String(error.code).startsWith("ERR_PARSE_ARGS"));

/** Global options come before the first positional; the rest is the command's. */
const splitGlobal = (argv: string[]) => {
	const { tokens } = parseArgs({
		args: argv,
		options: globalOptions,
		allowPositionals: true,
		strict: false,
		tokens: true,
	});
	const first = tokens.find((t) => t.kind === "positional");
	const cut = first?.index ?? argv.length;
	const { values } = parseArgs({
		args: argv.slice(0, cut),
		options: globalOptions,
	});
	return { values, rest: argv.slice(cut) };
};

export const main = async (
	argv: string[],
	io: Omit<CommandContext, "home">,
): Promise<number> => {
	try {
		const { values, rest } = splitGlobal(argv);
		const [domain, name, ...args] = rest;
		if (values.help || domain === undefined) {
			io.stdout.write(usage());
			return 0;
		}
		const command = name === undefined ? undefined : domains[domain]?.[name];
		if (command === undefined) {
			io.stderr.write(
				`unknown command: ${[domain, name].filter(Boolean).join(" ")}\n\n${usage()}`,
			);
			return 2;
		}
		const home = resolve(
			values.home ?? (process.env.ALIQUOT_HOME || ".aliquot"),
		);
		return await command.run(args, { ...io, home });
	} catch (error) {
		const message =
			error instanceof Error
				? `${error.name === "Error" ? "error" : error.name}: ${error.message}`
				: `error: ${String(error)}`;
		if (isUsageError(error)) {
			io.stderr.write(`${message}\n\n${usage()}`);
			return 2;
		}
		io.stderr.write(`${message}\n`);
		return 1;
	}
};

process.exitCode = await main(process.argv.slice(2), {
	stdin: process.stdin,
	stdout: process.stdout,
	stderr: process.stderr,
});
