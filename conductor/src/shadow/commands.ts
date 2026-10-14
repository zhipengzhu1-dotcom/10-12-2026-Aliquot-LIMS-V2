import { parseArgs } from "node:util";
import {
	fromInvocation,
	parseTimeout,
	personOf,
	withLedger,
} from "../cli-support.js";
import { type CommandTable, UsageError } from "../command.js";
import { buildImage, defaultImageTag, imageId } from "../sandbox/image.js";
import { compareShadow } from "./comparison.js";
import { nameReceivingLog } from "./lifecycle.js";

export const shadowCommands: CommandTable = {
	"receiving-log": {
		args: "<lab's Receiving Log workbook>",
		describe:
			"Name the lab's Receiving Log workbook for this home (ReceivingLogNamed records its path and sha256); the Conductor only ever reads it",
		run: async (args, ctx) => {
			const { positionals } = parseArgs({ args, allowPositionals: true });
			if (positionals.length !== 1) {
				throw new UsageError("shadow receiving-log takes exactly one workbook");
			}
			const actor = personOf(ctx);
			const path = fromInvocation(positionals[0] as string);
			const { receiving_log, seq } = withLedger(ctx.home, true, (ledger) =>
				nameReceivingLog(ledger, { actor, path }),
			);
			ctx.stdout.write(
				`ReceivingLogNamed seq ${seq}: ${receiving_log.path} sha256 ${receiving_log.sha256}\n`,
			);
			return 0;
		},
	},
	compare: {
		args: "[--timeout <ms>]",
		describe:
			"Compare the latest Shadow with a fresh read of the lab's Receiving Log, field by field, and store the Comparison its Run writes",
		run: async (args, ctx) => {
			const { values } = parseArgs({
				args,
				options: { timeout: { type: "string", default: "60000" } },
			});
			const timeoutMs = parseTimeout(values.timeout);
			const operator = personOf(ctx);
			const tag = defaultImageTag();
			const image =
				imageId(tag) ??
				(
					await buildImage({
						tag,
						onOutput: (chunk) => ctx.stderr.write(chunk),
					})
				).id;
			const c = await withLedger(ctx.home, true, (ledger) =>
				compareShadow({ ledger, home: ctx.home, operator, image, timeoutMs }),
			);
			ctx.stdout.write(
				[
					`shadow      ${c.shadow} ShadowReceivingLog, written by ${c.shadow_run}`,
					`lab's       ${c.lab} ReceivingLog, read from ${c.path}`,
					`run         ${c.run.id} ${c.run.script.id} v${c.run.script.version}, exit ${c.run.exit_code}`,
					`comparison  ${c.json} comparison.json`,
					`comparison  ${c.table} comparison.txt`,
					"",
					c.text,
				].join("\n"),
			);
			return 0;
		},
	},
};
