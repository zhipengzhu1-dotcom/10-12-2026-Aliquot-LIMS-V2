import { readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { type CommandTable, UsageError } from "./command.js";
import { canonicalJson } from "./hash.js";
import { openLedger, parseNewEvent } from "./ledger.js";

const readAll = async (stream: Readable) => {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
};

const parseJson = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`the Event body is not JSON: ${(error as Error).message}`);
	}
};

export const ledgerCommands: CommandTable = {
	append: {
		args: "[file]",
		describe:
			"Append one Event body {actor, kind, payload, task_id?, causation_id?} from a JSON file, or stdin",
		run: async (args, ctx) => {
			const { positionals } = parseArgs({ args, allowPositionals: true });
			if (positionals.length > 1) {
				throw new UsageError("ledger append takes at most one file");
			}
			const [file] = positionals;
			const text =
				file === undefined || file === "-"
					? await readAll(ctx.stdin)
					: readFileSync(file, "utf8");
			const body = parseNewEvent(parseJson(text));
			const ledger = openLedger({ home: ctx.home, writer: true });
			try {
				const event = ledger.append(body);
				ctx.stdout.write(`${canonicalJson(event)}\n`);
				return 0;
			} finally {
				ledger.close();
			}
		},
	},
	verify: {
		describe: "Walk the hash chain and report the first broken seq",
		run: async (args, ctx) => {
			parseArgs({ args });
			const ledger = openLedger({ home: ctx.home, writer: false });
			try {
				const result = ledger.verify();
				if (result.ok) {
					const noun = result.count === 1 ? "Event" : "Events";
					ctx.stdout.write(
						`Ledger verified: ${result.count} ${noun}, chain intact\n`,
					);
					return 0;
				}
				ctx.stderr.write(
					`Ledger broken at seq ${result.seq}: ${result.reason}\n`,
				);
				return 1;
			} finally {
				ledger.close();
			}
		},
	},
};
