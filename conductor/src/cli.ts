import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	type Command,
	type CommandContext,
	type CommandTable,
	UsageError,
} from "./command.js";
import { gateCommands } from "./gate/commands.js";
import { ledgerCommands } from "./ledger-commands.js";
import { orgCommands } from "./org/commands.js";
import { roomCommands } from "./room/commands.js";
import { sandboxCommands } from "./sandbox/commands.js";
import { serveCommand } from "./serve/command.js";
import { taskCommands } from "./task/commands.js";
import { trainingCommands } from "./training/commands.js";
import { turnCommands } from "./turn/commands.js";
import { vitalityCommands } from "./vitality/commands.js";
import { workflowCommands } from "./workflow/commands.js";

/** `aliquot <domain> <command>`. Each domain owns its table. */
const domains: Readonly<Record<string, CommandTable>> = {
	ledger: ledgerCommands,
	org: orgCommands,
	task: taskCommands,
	training: trainingCommands,
	room: roomCommands,
	gate: gateCommands,
	sandbox: sandboxCommands,
	turn: turnCommands,
	vitality: vitalityCommands,
	workflow: workflowCommands,
};

/** `aliquot <command>`: commands that belong to no one domain. */
const processes: CommandTable = { serve: serveCommand };

const globalOptions = {
	home: { type: "string" },
	help: { type: "boolean", short: "h" },
} as const;

const usage = () => {
	const synopsis = (words: string[], command: Command) => [
		[...words, command.args].filter(Boolean).join(" "),
		command.describe,
	];
	const rows = [
		...Object.entries(processes).map(([name, command]) =>
			synopsis([name], command),
		),
		...Object.entries(domains).flatMap(([domain, table]) =>
			Object.entries(table).map(([name, command]) =>
				synopsis([domain, name], command),
			),
		),
	];
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
		const own = Object.hasOwn(processes, domain)
			? processes[domain]
			: undefined;
		const command =
			own ?? (name === undefined ? undefined : domains[domain]?.[name]);
		if (command === undefined) {
			io.stderr.write(
				`unknown command: ${[domain, name].filter(Boolean).join(" ")}\n\n${usage()}`,
			);
			return 2;
		}
		const home = resolve(
			values.home ?? (process.env.ALIQUOT_HOME || ".aliquot"),
		);
		return await command.run(own === undefined ? args : rest.slice(1), {
			...io,
			home,
		});
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
