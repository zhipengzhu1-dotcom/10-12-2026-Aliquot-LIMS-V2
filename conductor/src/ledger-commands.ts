import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { AppendRefused, refusalText } from "./append-guard.js";
import { readAll, withLedger } from "./cli-support.js";
import { type CommandTable, UsageError } from "./command.js";
import { canonicalJson } from "./hash.js";
import { parseNewEvent, verifyLedger } from "./ledger.js";
import { type TaskEventKind, taskEventKind } from "./task/lifecycle.js";

/** The command that appends each Event only the Task lifecycle appends. */
const TASK_EVENT_COMMANDS: Record<TaskEventKind | "GateRequested", string> = {
	TaskProposed: "task propose",
	TaskAssigned: "task assign",
	TaskStarted: "task start",
	TaskHandedOff: "task handoff",
	TaskCompleted: "task complete",
	TaskFailed: "task fail",
	TaskEscalated: "task escalate",
	ReviewRecorded: "vitality review",
	GateRequested: "gate request --task",
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
			const kind = taskEventKind(body);
			if (kind !== undefined) {
				throw new AppendRefused(
					refusalText(
						kind,
						`only the Task lifecycle appends Task Events; use aliquot ${TASK_EVENT_COMMANDS[kind]}`,
					),
				);
			}
			const event = withLedger(ctx.home, true, (l) => l.append(body));
			ctx.stdout.write(`${canonicalJson(event)}\n`);
			return 0;
		},
	},
	verify: {
		describe: "Walk the hash chain and report the first broken seq",
		run: async (args, ctx) => {
			parseArgs({ args });
			const result = verifyLedger(ctx.home);
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
		},
	},
};
