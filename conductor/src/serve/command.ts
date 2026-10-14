import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { personOf } from "../cli-support.js";
import { type Command, UsageError } from "../command.js";
import { openLedger } from "../ledger.js";
import { useSandbox } from "../sandbox/runner.js";
import { openWarmSandbox } from "../sandbox/warm.js";
import type { SchedulerOptions } from "../scheduler/plan.js";
import { openScheduler } from "../scheduler/scheduler.js";
import { loginFrom, loginText } from "../turn/auth.js";
import { chosenModel } from "../turn/commands.js";
import { type Email, emailOf } from "../types/actor.js";
import { DEFAULT_ENERGY_BUDGET_TOKENS } from "../vitality/commands.js";
import { cloudflareAccess } from "./access.js";
import { type People, serve } from "./http.js";

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

/** The cap on a scheduled Turn's model round trips, as `turn run` defaults it. */
const MAX_TURNS = 20;

const UNIT_MS: Readonly<Record<string, number>> = {
	ms: 1,
	s: 1000,
	m: 60_000,
	h: 3_600_000,
};

/** `15s`, `30m`, `500ms` or `1h`: a whole number above 0 and a unit. */
const durationOf = (text: string, flag: string): number => {
	const [, amount, unit] = /^(\d+)(ms|s|m|h)$/.exec(text) ?? [];
	const ms = Number(amount) * (UNIT_MS[unit ?? ""] ?? 0);
	if (!(ms > 0)) {
		throw new UsageError(
			`${flag} must be a whole number above 0 with ms, s, m or h, like 15s, not ${JSON.stringify(text)}`,
		);
	}
	return ms;
};

const wholeAbove0 = (text: string, flag: string): number => {
	if (!/^\d+$/.test(text) || Number(text) === 0) {
		throw new UsageError(
			`${flag} must be a whole number above 0, not ${JSON.stringify(text)}`,
		);
	}
	return Number(text);
};

const emailFlag = (text: string): Email => {
	const email = emailOf(text);
	if (email === undefined) {
		throw new UsageError(
			`--operator-email must be a person's email, not ${JSON.stringify(text)}`,
		);
	}
	return email;
};

/** Cloudflare Access takes all three flags or none; `--operator-email` once per person. */
const accessOf = (values: {
	"access-team"?: string | undefined;
	"access-aud"?: string | undefined;
	"operator-email"?: string[] | undefined;
}) => {
	const {
		"access-team": team,
		"access-aud": aud,
		"operator-email": emails,
	} = values;
	if (team === undefined && aud === undefined && emails === undefined)
		return undefined;
	if (team === undefined || aud === undefined || emails === undefined) {
		throw new UsageError(
			"Cloudflare Access needs all of --access-team, --access-aud and --operator-email",
		);
	}
	return { team, aud, emails: emails.map(emailFlag) };
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
 * `aliquot serve`: the long-running Conductor. Each action names the person
 * it came from: whom Cloudflare Access vouched for, or, serving 127.0.0.1
 * only, the person `--operator` names. It holds the Ledger's writer
 * from start to SIGINT or SIGTERM, so a command that writes meanwhile is
 * refused by the writer lock, and closes it before it exits. Unless
 * `--no-schedule`, the Scheduler ticks meanwhile, and the Ledger closes only
 * once the Turns it started have finished. Every Run it starts is a warm
 * Run (ADR-0020), and it stops its warm containers before it exits.
 */
export const serveCommand: Command = {
	args: "[--port 8787] [--bind 127.0.0.1] [--access-team <team> --access-aud <aud> --operator-email <email>...] [--tick 15s] [--duty 30m] [--concurrency 2] [--budget <tokens>] [--no-schedule]",
	describe:
		"Hold the Ledger, serve the Operator's interface (Projections, Events over SSE, and actions), and schedule Turns every Tick",
	run: async (args, ctx) => {
		const { values } = parseArgs({
			args,
			options: {
				home: { type: "string" },
				port: { type: "string", default: "8787" },
				bind: { type: "string", default: LOOPBACK },
				"access-team": { type: "string" },
				"access-aud": { type: "string" },
				"operator-email": { type: "string", multiple: true },
				tick: { type: "string", default: "15s" },
				duty: { type: "string", default: "30m" },
				concurrency: { type: "string", default: "2" },
				budget: {
					type: "string",
					default: String(DEFAULT_ENERGY_BUDGET_TOKENS),
				},
				"no-schedule": { type: "boolean", default: false },
			},
		});
		const port = portOf(values.port);
		const access = accessOf(values);
		if (access === undefined && values.bind !== LOOPBACK) {
			throw new UsageError(
				`--bind ${values.bind} needs --access-team: without Cloudflare Access the Conductor serves ${LOOPBACK} only`,
			);
		}
		const options: SchedulerOptions = {
			tickMs: durationOf(values.tick, "--tick"),
			dutyMs: durationOf(values.duty, "--duty"),
			concurrency: wholeAbove0(values.concurrency, "--concurrency"),
			energyBudgetTokens: wholeAbove0(values.budget, "--budget"),
		};
		const schedule = !values["no-schedule"];
		const login = loginFrom(process.env);
		if (schedule && login.tag === "ApiKey") {
			throw new UsageError(
				`the Scheduler runs Turns on the subscription login only, not on ${loginText(login)}; unset it or pass --no-schedule`,
			);
		}
		const home = values.home === undefined ? ctx.home : resolve(values.home);
		if (!existsSync(join(UI_DIR, "index.html"))) {
			ctx.stderr.write(
				`The interface is not built; run \`pnpm -C conductor build\`. The API is served without it.\n`,
			);
		}

		const say = (line: string) => ctx.stdout.write(`${line}\n`);
		const people: People =
			access === undefined
				? { tag: "Local", email: personOf(ctx).email }
				: { tag: "Access", admit: cloudflareAccess(access, { say }) };
		const ledger = openLedger({ home, writer: true });
		const sandbox = openWarmSandbox();
		const restoreSandbox = useSandbox(sandbox);
		let signal: NodeJS.Signals;
		try {
			const model = schedule ? chosenModel() : undefined;
			const scheduler =
				model === undefined
					? undefined
					: openScheduler(ledger, {
							home,
							options,
							maxTurns: MAX_TURNS,
							login,
							modelFor: () => model.run,
							say,
						});
			const serving = await serve(ledger, {
				port,
				bind: values.bind,
				ui: UI_DIR,
				people,
				...(scheduler === undefined ? {} : { scheduler: scheduler.report }),
			});
			ctx.stdout.write(`Serving ${home} at ${serving.url}\n`);
			if (scheduler !== undefined && model !== undefined) {
				say(
					`Scheduling Turns on ${model.text}, on ${loginText(login)}: a Tick every ${values.tick}, standing duty every ${values.duty}, at most ${options.concurrency} Turns at once, an Energy budget of ${options.energyBudgetTokens} tokens`,
				);
				scheduler.start();
			}
			signal = await stopSignal();
			await scheduler?.stop();
			await serving.close();
		} finally {
			restoreSandbox();
			await sandbox.close();
			ledger.close();
		}
		ctx.stdout.write(`Stopped on ${signal}; the Ledger is closed\n`);
		return 0;
	},
};
