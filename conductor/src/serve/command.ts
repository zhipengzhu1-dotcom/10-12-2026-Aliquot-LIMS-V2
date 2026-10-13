import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Command, UsageError } from "../command.js";
import { openLedger } from "../ledger.js";
import { cloudflareAccess } from "./access.js";
import { serve } from "./http.js";

const LOOPBACK = "127.0.0.1";

/** `pnpm -C conductor build` compiles the interface here, from `src/serve/` or `dist/serve/` alike. */
const UI_DIR = fileURLToPath(new URL("../../dist/ui/", import.meta.url));

const portOf = (text: string) => {
	const port = Number(text);
	if (!/^\d+$/.test(text) || port > 65535) {
		throw new UsageError(
			`--port must be 0 to 65535, not ${JSON.stringify(text)}`,
		);
	}
	return port;
};

/** Cloudflare Access takes all three flags or none. */
const accessOf = (values: {
	"access-team"?: string | undefined;
	"access-aud"?: string | undefined;
	"operator-email"?: string | undefined;
}) => {
	const {
		"access-team": team,
		"access-aud": aud,
		"operator-email": email,
	} = values;
	if (team === undefined && aud === undefined && email === undefined)
		return undefined;
	if (team === undefined || aud === undefined || email === undefined) {
		throw new UsageError(
			"Cloudflare Access needs all of --access-team, --access-aud and --operator-email",
		);
	}
	return { team, aud, email };
};

const stopSignal = () =>
	new Promise<NodeJS.Signals>((done) => {
		const stop = (signal: NodeJS.Signals) => {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
			done(signal);
		};
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
	});

/**
 * `aliquot serve`: the long-running Conductor. It holds the Ledger's writer
 * from start to SIGINT or SIGTERM, so a command that writes meanwhile is
 * refused by the writer lock, and closes it before it exits.
 */
export const serveCommand: Command = {
	args: "[--port 8787] [--bind 127.0.0.1] [--access-team <team> --access-aud <aud> --operator-email <email>]",
	describe:
		"Hold the Ledger and serve the Operator's interface: Projections, Events over SSE, and actions",
	run: async (args, ctx) => {
		const { values } = parseArgs({
			args,
			options: {
				home: { type: "string" },
				port: { type: "string", default: "8787" },
				bind: { type: "string", default: LOOPBACK },
				"access-team": { type: "string" },
				"access-aud": { type: "string" },
				"operator-email": { type: "string" },
			},
		});
		const port = portOf(values.port);
		const access = accessOf(values);
		if (access === undefined && values.bind !== LOOPBACK) {
			throw new UsageError(
				`--bind ${values.bind} needs --access-team: without Cloudflare Access the Conductor serves ${LOOPBACK} only`,
			);
		}
		const home = values.home === undefined ? ctx.home : resolve(values.home);
		if (!existsSync(join(UI_DIR, "index.html"))) {
			ctx.stderr.write(
				`The interface is not built; run \`pnpm -C conductor build\`. The API is served without it.\n`,
			);
		}

		const ledger = openLedger({ home, writer: true });
		let signal: NodeJS.Signals;
		try {
			const serving = await serve(ledger, {
				port,
				bind: values.bind,
				ui: UI_DIR,
				...(access === undefined ? {} : { admit: cloudflareAccess(access) }),
			});
			ctx.stdout.write(`Serving ${home} at ${serving.url}\n`);
			signal = await stopSignal();
			await serving.close();
		} finally {
			ledger.close();
		}
		ctx.stdout.write(`Stopped on ${signal}; the Ledger is closed\n`);
		return 0;
	},
};
