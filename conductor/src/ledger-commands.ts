import { parseArgs } from "node:util";
import type { CommandTable } from "./command.js";
import { verifyLedger } from "./ledger.js";

export const ledgerCommands: CommandTable = {
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
