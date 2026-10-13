import {
	type ChildProcessWithoutNullStreams,
	spawn,
	spawnSync,
} from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLedger } from "../ledger.js";
import { seedOrg } from "../org/seed.js";

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
const startServe = async () => {
	const started = spawn(
		process.execPath,
		["--import", "tsx", cli, "--home", home, "serve", "--port", "0"],
		{ env },
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
