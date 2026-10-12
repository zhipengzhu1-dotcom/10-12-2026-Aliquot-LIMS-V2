import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewEvent } from "../events.js";
import { canonicalJson, sha256Hex } from "../hash.js";
import { AgentId, GateId } from "../ids.js";
import { openLedger } from "../ledger.js";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

const aliquot = (args: string[], input = "") =>
	spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--home", home, ...args],
		{
			encoding: "utf8",
			input,
			env: { ...process.env, ALIQUOT_HOME: "" },
		},
	);

const runCli = (args: string[], input = "") =>
	aliquot(["gate", ...args], input);

const deploy = { target: "receiving-screen", version: "1.2.0" };
// sha256 of {"target":"receiving-screen","version":"1.2.0"}, from shasum.
const deployHash =
	"644b4ff33f551679c2cafd567934dd65cb8ea3d3c6bae02b1d676fafc67892e5";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-gate-cli-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** Write Gate requests whose ts lies `agoMs` before the wall clock. */
const requestedAgo = (
	requests: { agoMs: number; event: (n: number) => NewEvent }[],
) => {
	let ts = new Date();
	const ledger = openLedger({ home, writer: true, clock: () => ts });
	try {
		requests.forEach(({ agoMs, event }, i) => {
			ts = new Date(Date.now() - agoMs);
			ledger.append(event(i + 1));
		});
	} finally {
		ledger.close();
	}
};

const gateRequest =
	(
		kind: "Deploy" | "RetireAgent",
		payload: Record<string, string>,
		lifetime_s = 86400,
	) =>
	(n: number): NewEvent => ({
		actor: { tag: "Agent", id: AgentId.parse("A-bram") },
		kind: "GateRequested",
		payload: {
			gate_id: GateId.parse(`G-${n}`),
			kind,
			payload,
			payload_hash: sha256Hex(canonicalJson(payload)),
			lifetime_s,
		},
	});

const HOUR = 3600_000;

describe("aliquot gate", () => {
	it("requests, lists and decides a Gate end to end", () => {
		const file = join(home, "payload.json");
		writeFileSync(file, JSON.stringify(deploy));
		for (const step of [
			[
				"propose",
				"--title",
				"Deploy",
				"--goal",
				"Ship it",
				"--tat",
				"Regular",
				"--priority",
				"1",
			],
			["assign", "T-1", "A-bram"],
			["start", "T-1", "--as", "A-bram"],
		]) {
			expect(aliquot(["task", ...step]).status).toBe(0);
		}

		const requested = runCli([
			"request",
			"--kind",
			"Deploy",
			"--payload",
			file,
			"--task",
			"T-1",
			"--as",
			"A-bram",
		]);
		expect(requested.stderr).toBe("");
		expect(requested.status).toBe(0);
		expect(requested.stdout).toBe(`G-1 ${deployHash}\n`);
		expect(aliquot(["task", "list"]).stdout).toMatch(
			/^Blocked \(1\)\n {2}T-1 /m,
		);

		const fromStdin = runCli(
			["request", "--kind", "RetireAgent", "--payload", "-"],
			JSON.stringify({ agent_id: "A-rin" }),
		);
		expect(fromStdin.stdout).toMatch(/^G-2 [0-9a-f]{64}\n$/);

		const open = runCli(["list"]);
		expect(open.status).toBe(0);
		expect(open.stdout).toMatch(/^ID +KIND +REQUESTER +AGE +PAYLOAD\n/);
		expect(open.stdout).toMatch(/\nG-1 +Deploy +A-bram +\d+s +\{"target"/);
		expect(open.stdout).toMatch(/\nG-2 +RetireAgent +Operator +\d+s +\{/);

		const decided = runCli([
			"decide",
			"G-1",
			"--approve",
			"--reason",
			"diff checked",
		]);
		expect(decided.stderr).toBe("");
		expect(decided.status).toBe(0);
		const event = JSON.parse(decided.stdout);
		expect(event).toMatchObject({
			seq: 6,
			actor: { tag: "Operator" },
			task_id: "T-1",
			kind: "GateDecided",
			payload: {
				gate_id: "G-1",
				decided_by: { tag: "Operator" },
				decided_at: event.ts,
				payload_hash: deployHash,
				meaning: "approve",
				reason: "diff checked",
			},
		});

		expect(aliquot(["task", "list"]).stdout).toMatch(
			/^InProgress \(1\)\n {2}T-1 /m,
		);

		const after = runCli(["list"]);
		expect(after.stdout).not.toContain("G-1");
		expect(after.stdout).toContain("G-2");
		expect(runCli(["list", "--all"]).stdout).toMatch(
			/\nG-1 +Approved +Deploy /,
		);
	});

	it("lists each open Gate's kind, requester, age and a one-line payload summary", () => {
		const long = { note: "x".repeat(200) };
		requestedAgo([
			{ agoMs: 2 * HOUR + 5 * 60_000, event: gateRequest("Deploy", deploy) },
			{ agoMs: 3 * 24 * HOUR, event: gateRequest("Deploy", long, 4 * 86400) },
		]);

		const { stdout, status } = runCli(["list"]);
		expect(status).toBe(0);
		const lines = stdout.trimEnd().split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[1]?.split(/ {2,}/)).toEqual([
			"G-1",
			"Deploy",
			"A-bram",
			"2h 5m",
			'{"target":"receiving-screen","version":"1.2.0"}',
		]);
		const summary = lines[2]?.split(/ {2,}/).at(-1) ?? "";
		expect(lines[2]?.split(/ {2,}/)[3]).toBe("3d 0h");
		expect(summary).toHaveLength(60);
		expect(summary.endsWith("…")).toBe(true);
	});

	it("shows a Gate past its lifetime as Expired without writing an Event, and refuses to decide it", () => {
		requestedAgo([
			{ agoMs: 2 * HOUR, event: gateRequest("Deploy", deploy, 3600) },
		]);

		expect(runCli(["list"]).stdout).toBe("No open Gates\n");
		expect(runCli(["list", "--all"]).stdout).toMatch(
			/\nG-1 +Expired +Deploy +A-bram +2h 0m /,
		);
		const refused = runCli(["decide", "G-1", "--approve", "--reason", "late"]);
		expect(refused.status).toBe(1);
		expect(refused.stderr).toMatch(/^AppendRefused: Gate G-1 expired at /);

		const ledger = openLedger({ home, writer: false });
		try {
			expect(ledger.all().map((e) => e.kind)).toEqual(["GateRequested"]);
		} finally {
			ledger.close();
		}
	});

	it("shows a Gate's full payload", () => {
		requestedAgo([{ agoMs: 60_000, event: gateRequest("Deploy", deploy) }]);
		const { stdout, status } = runCli(["show", "G-1"]);
		expect(status).toBe(0);
		expect(stdout).toContain("state: Open\n");
		expect(stdout).toContain(`payload_hash: ${deployHash}\n`);
		expect(stdout).toContain(
			'{\n  "target": "receiving-screen",\n  "version": "1.2.0"\n}\n',
		);
	});

	it("refuses a decision that both approves and rejects", () => {
		requestedAgo([{ agoMs: 60_000, event: gateRequest("Deploy", deploy) }]);
		const result = runCli([
			"decide",
			"G-1",
			"--approve",
			"--reject",
			"--reason",
			"unsure",
		]);
		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(/exactly one of --approve or --reject/);
	});
});
