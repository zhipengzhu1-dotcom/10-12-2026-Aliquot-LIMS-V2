import {
	type ChildProcessWithoutNullStreams,
	spawn,
	spawnSync,
} from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLedger } from "../ledger.js";
import { seedOrg } from "../org/seed.js";
import { LAB_ROOM, seedRooms } from "../room/seed.js";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const env = { ...process.env, ALIQUOT_HOME: "" };

let home: string;
let child: ChildProcessWithoutNullStreams | undefined;

const aliquot = (...args: string[]) =>
	spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--home", home, ...args],
		{
			encoding: "utf8",
			env,
		},
	);

/** `aliquot serve` in its own process, once it says where it serves. */
const startServe = async (
	flags: readonly string[] = ["--no-schedule"],
	extraEnv: Record<string, string> = {},
) => {
	const started = spawn(
		process.execPath,
		["--import", "tsx", cli, "--home", home, "serve", "--port", "0", ...flags],
		{ env: { ...env, ...extraEnv } },
	);
	child = started;
	let stdout = "";
	let stderr = "";
	started.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	const url = await new Promise<string>((done, fail) => {
		started.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
			const serving = /at (http:\/\/\S+)\n/.exec(stdout)?.[1];
			if (serving !== undefined) done(serving);
		});
		started.on("exit", (code) =>
			fail(new Error(`serve exited ${code}: ${stderr}`)),
		);
	});
	const stopped = new Promise<{ code: number | null; stdout: string }>((done) =>
		started.on("exit", (code) => done({ code, stdout })),
	);
	return { url, pid: started.pid, stopped };
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-serve-cli-"));
	const ledger = openLedger({ home, writer: true });
	seedOrg(ledger);
	ledger.close();
});

afterEach(() => {
	if (child?.exitCode === null) child.kill("SIGKILL");
	child = undefined;
	rmSync(home, { recursive: true, force: true });
});

describe("aliquot serve", () => {
	it("serves the Org Projection and holds the writer lock until SIGTERM", async () => {
		const { url, pid, stopped } = await startServe();

		const org = await (await fetch(`${url}/api/org`)).json();
		const locked = aliquot("org", "pause", "A-rin", "--reason", "Tired");
		child?.kill("SIGTERM");
		const exit = await stopped;
		const after = aliquot("org", "pause", "A-rin", "--reason", "Tired");

		expect(org).toMatchObject({
			agents: { "A-rin": { definition: { name: "Rin" } } },
		});
		expect(locked.status).toBe(1);
		expect(locked.stderr).toBe(
			`LedgerLocked: ${join(home, "ledger.sqlite.lock")} held by pid ${pid}\n`,
		);
		expect(exit.code).toBe(0);
		expect(exit.stdout).toContain("Stopped on SIGTERM; the Ledger is closed\n");
		expect(existsSync(join(home, "ledger.sqlite.lock"))).toBe(false);
		expect(after.stdout).toBe("Paused A-rin\n");
	});

	it("/api/ledger/verify returns the verdict ledger verify prints", async () => {
		const { url } = await startServe();
		const verify = async () =>
			(await (await fetch(`${url}/api/ledger/verify`)).json()) as
				| { ok: true; count: number }
				| { ok: false; seq: number; reason: string };

		const intact = await verify();
		const intactCli = aliquot("ledger", "verify");
		const db = new DatabaseSync(join(home, "ledger.sqlite"));
		db.exec(`UPDATE events SET payload = '{"forged":true}' WHERE seq = 4`);
		db.close();
		const broken = await verify();
		const brokenCli = aliquot("ledger", "verify");

		expect(intact).toEqual({ ok: true, count: 8 });
		expect(intactCli.stdout).toBe("Ledger verified: 8 Events, chain intact\n");
		expect(broken).toEqual({
			ok: false,
			seq: 4,
			reason: "hash does not match the Event's contents",
		});
		expect(brokenCli.stderr).toBe(
			"Ledger broken at seq 4: hash does not match the Event's contents\n",
		);
	});

	it("schedules Turns every Tick, prints a line per decision, and serves the last Tick at /api/scheduler", async () => {
		const model = join(home, "scripted.json");
		writeFileSync(
			model,
			JSON.stringify({
				calls: [],
				usage_per_round: {
					input_tokens: 10,
					output_tokens: 1,
					cache_creation_tokens: 0,
					cache_read_tokens: 0,
					cost_usd: 0,
				},
				stop: { tag: "Completed" },
			}),
		);
		const { url, stopped } = await startServe(
			["--tick", "200ms", "--concurrency", "1"],
			{ ALIQUOT_SCRIPTED_MODEL: model },
		);

		let report: { last: { decisions: { verb: string }[] } | null } = {
			last: null,
		};
		for (let i = 0; i < 50 && report.last === null; i += 1) {
			report = (await (
				await fetch(`${url}/api/scheduler`)
			).json()) as typeof report;
		}
		child?.kill("SIGTERM");
		const exit = await stopped;
		const turns = aliquot("turn", "list").stdout;

		expect(report).toMatchObject({
			options: {
				tickMs: 200,
				dutyMs: 1_800_000,
				concurrency: 1,
				energyBudgetTokens: 1_000_000,
			},
		});
		expect(report.last?.decisions.length).toBeGreaterThan(0);
		expect(exit.code).toBe(0);
		expect(exit.stdout).toMatch(
			/^scheduler \d{4}-\d\d-\d\dT\S+Z A-mabel start standing duty, no Turn yet$/m,
		);
		expect(exit.stdout).toMatch(
			/^scheduler \S+ A-mabel finished TN-1 Completed/m,
		);
		expect(turns).toMatch(/^TN-1 A-mabel .* outcome=Completed$/m);
		expect(turns, "every Turn finished before the Ledger closed").not.toContain(
			"outcome=open",
		);
		expect(aliquot("ledger", "verify").status).toBe(0);
	});

	it("a Message said while serving as tools/serve.sh serves leads to a TurnStarted", async () => {
		const serveSh = readFileSync(
			fileURLToPath(new URL("../../../tools/serve.sh", import.meta.url)),
			"utf8",
		);
		const serveFlags = /^node .* serve (.*)$/m.exec(serveSh)?.[1] ?? "";
		const ledger = openLedger({ home, writer: true });
		seedRooms(ledger);
		ledger.close();
		const model = join(home, "scripted.json");
		writeFileSync(
			model,
			JSON.stringify({
				calls: [],
				usage_per_round: {
					input_tokens: 10,
					output_tokens: 1,
					cache_creation_tokens: 0,
					cache_read_tokens: 0,
					cost_usd: 0,
				},
				stop: { tag: "Completed" },
			}),
		);
		const { url, stopped } = await startServe(
			["--tick", "200ms", "--concurrency", "8"],
			{ ALIQUOT_SCRIPTED_MODEL: model },
		);

		const said = await fetch(`${url}/api/actions/room-say`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ room_id: LAB_ROOM.id, body: "Morning, all" }),
		});
		let decisions = "";
		for (let i = 0; i < 100 && !decisions.includes("new Message"); i += 1) {
			await new Promise((done) => setTimeout(done, 100));
			decisions += await (await fetch(`${url}/api/scheduler`)).text();
		}
		child?.kill("SIGTERM");
		const exit = await stopped;

		expect(
			serveFlags.replace("${no_schedule:+--no-schedule}", ""),
			"serve.sh passes --no-schedule only when its own flag asks",
		).not.toContain("--no-schedule");
		expect(said.status).toBe(200);
		const started = /^scheduler \S+ (A-\w+) start .*new Message/m.exec(
			exit.stdout,
		)?.[1];
		expect(started).toBeDefined();
		expect(aliquot("turn", "list", "--agent", started ?? "").stdout).toMatch(
			new RegExp(`^TN-\\d+ ${started} `, "m"),
		);
	});

	it("--no-schedule serves without scheduling: no Turn, and /api/scheduler says the Scheduler is off", async () => {
		const { url, stopped } = await startServe();

		const res = await fetch(`${url}/api/scheduler`);
		const body = await res.text();
		child?.kill("SIGTERM");
		const exit = await stopped;

		expect(res.status).toBe(404);
		expect(body).toBe("the Scheduler is off: aliquot serve --no-schedule\n");
		expect(exit.stdout).not.toContain("scheduler ");
		expect(aliquot("turn", "list").stdout).toBe("No Turns\n");
	});

	it("refuses a --tick without a unit", () => {
		const refused = aliquot("serve", "--tick", "15");

		expect(refused.status).toBe(2);
		expect(refused.stderr).toMatch(
			/^UsageError: --tick must be a whole number above 0 with ms, s, m or h, like 15s, not "15"\n/,
		);
	});

	it("refuses --bind 0.0.0.0 without Cloudflare Access", () => {
		const refused = aliquot("serve", "--bind", "0.0.0.0");

		expect(refused.status).toBe(2);
		expect(refused.stderr).toMatch(
			/^UsageError: --bind 0\.0\.0\.0 needs --access-team: without Cloudflare Access the Conductor serves 127\.0\.0\.1 only\n/,
		);
	});

	it("refuses Cloudflare Access without its audience and the Operator's email", () => {
		const refused = aliquot("serve", "--access-team", "aliquot-lab");

		expect(refused.status).toBe(2);
		expect(refused.stderr).toMatch(
			/^UsageError: Cloudflare Access needs all of --access-team, --access-aud and --operator-email\n/,
		);
	});
});
