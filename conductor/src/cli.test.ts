import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLedger } from "./ledger.js";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));

type RunOptions = { input?: string; env?: Record<string, string> };

const runCli = (args: string[], options: RunOptions = {}) =>
	spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
		encoding: "utf8",
		input: options.input ?? "",
		env: { ...process.env, ALIQUOT_HOME: "", ...options.env },
	});

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-cli-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("aliquot cli", () => {
	it("prints usage naming the aliquot command when run with no arguments", () => {
		const result = runCli([]);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/^Usage: aliquot <command> \[options\]/);
		expect(result.stdout).toContain("ledger verify");
	});

	it("rejects an unknown command with usage on stderr", () => {
		const result = runCli(["--home", home, "ledger", "rewrite"]);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("unknown command: ledger rewrite");
	});
});

describe("aliquot ledger", () => {
	it("has no command that appends a raw Event", () => {
		const usage = runCli([]);
		const result = runCli(["--home", home, "ledger", "append"]);

		expect(usage.stdout).not.toContain("ledger append");
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("unknown command: ledger append");
	});

	it("verifies the chain a domain command wrote", () => {
		runCli(["--home", home, "org", "seed"]);

		const verified = runCli(["--home", home, "ledger", "verify"]);

		expect(verified.status).toBe(0);
		expect(verified.stdout).toBe("Ledger verified: 8 Events, chain intact\n");
	});

	it("fails verify and names the first broken seq after a row is edited", () => {
		runCli(["--home", home, "org", "seed"]);
		const db = new DatabaseSync(join(home, "ledger.sqlite"));
		db.exec(`UPDATE events SET ts = '2020-01-01T00:00:00.000Z' WHERE seq = 2`);
		db.close();

		const verified = runCli(["--home", home, "ledger", "verify"]);

		expect(verified.status).toBe(1);
		expect(verified.stderr).toBe(
			"Ledger broken at seq 2: hash does not match the Event's contents\n",
		);
	});

	it("refuses to append while another process holds the Ledger", () => {
		const holder = openLedger({ home, writer: true });
		try {
			const result = runCli(["--home", home, "org", "seed"]);
			expect(result.status).toBe(1);
			expect(result.stderr).toBe(
				`LedgerLocked: ${join(home, "ledger.sqlite.lock")} held by pid ${process.pid}\n`,
			);
		} finally {
			holder.close();
		}
	});

	it("uses ALIQUOT_HOME when --home is not given", () => {
		runCli(["org", "seed"], { env: { ALIQUOT_HOME: home } });
		const verified = runCli(["--home", home, "ledger", "verify"]);
		expect(verified.stdout).toBe("Ledger verified: 8 Events, chain intact\n");
	});
});
