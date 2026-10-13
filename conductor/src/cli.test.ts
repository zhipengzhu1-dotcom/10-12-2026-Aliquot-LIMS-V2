import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// HumanCoached has no domain guard, so it appends to an empty Ledger.
const coached = (note: string) =>
	JSON.stringify({
		actor: { tag: "Operator" },
		kind: "HumanCoached",
		payload: { agent_id: "A-odile", note },
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
		expect(result.stdout).toContain("ledger append");
		expect(result.stdout).toContain("ledger verify");
	});

	it("rejects an unknown command with usage on stderr", () => {
		const result = runCli(["--home", home, "ledger", "rewrite"]);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("unknown command: ledger rewrite");
	});
});

describe("aliquot ledger", () => {
	it("appends Events from a file and from stdin, then verifies the chain", () => {
		const file = join(home, "event.json");
		writeFileSync(file, coached("from a file"));

		const fromFile = runCli(["--home", home, "ledger", "append", file]);
		const fromStdin = runCli(["--home", home, "ledger", "append"], {
			input: coached("from stdin"),
		});
		const verified = runCli(["--home", home, "ledger", "verify"]);

		expect(fromFile.stderr).toBe("");
		expect(fromFile.status).toBe(0);
		expect(JSON.parse(fromFile.stdout)).toMatchObject({
			seq: 1,
			kind: "HumanCoached",
			payload: { note: "from a file" },
		});
		expect(fromStdin.status).toBe(0);
		expect(JSON.parse(fromStdin.stdout)).toMatchObject({ seq: 2 });
		expect(verified.status).toBe(0);
		expect(verified.stdout).toBe("Ledger verified: 2 Events, chain intact\n");
	});

	it("refuses an Event with an unknown kind and writes nothing", () => {
		runCli(["--home", home, "ledger", "append"], { input: coached("first") });

		const refused = runCli(["--home", home, "ledger", "append"], {
			input: JSON.stringify({
				actor: { tag: "Operator" },
				kind: "AgentDanced",
				payload: {},
			}),
		});
		const verified = runCli(["--home", home, "ledger", "verify"]);

		expect(refused.status).toBe(1);
		expect(refused.stderr).toMatch(
			/^AppendRefused: AgentDanced refused: not a valid Event: /,
		);
		expect(refused.stderr).toContain("AgentDanced");
		expect(verified.stdout).toBe("Ledger verified: 1 Event, chain intact\n");
	});

	it("reports a body that is not JSON", () => {
		const result = runCli(["--home", home, "ledger", "append"], {
			input: "{oops",
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/^error: the Event body is not JSON/);
	});

	it("fails verify and names the first broken seq after a row is edited", () => {
		for (const reason of ["a", "b", "c"]) {
			runCli(["--home", home, "ledger", "append"], { input: coached(reason) });
		}
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
			const result = runCli(["--home", home, "ledger", "append"], {
				input: coached("blocked"),
			});
			expect(result.status).toBe(1);
			expect(result.stderr).toBe(
				`LedgerLocked: ${join(home, "ledger.sqlite.lock")} held by pid ${process.pid}\n`,
			);
		} finally {
			holder.close();
		}
	});

	it("uses ALIQUOT_HOME when --home is not given", () => {
		runCli(["ledger", "append"], {
			input: coached("env"),
			env: { ALIQUOT_HOME: home },
		});
		const verified = runCli(["--home", home, "ledger", "verify"]);
		expect(verified.stdout).toBe("Ledger verified: 1 Event, chain intact\n");
	});
});
