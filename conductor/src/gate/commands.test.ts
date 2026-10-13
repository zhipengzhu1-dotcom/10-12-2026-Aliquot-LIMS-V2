import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../command.js";
import { AgentId } from "../ids.js";
import { openLedger } from "../ledger.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import type { Actor } from "../types/actor.js";
import { gateCommands } from "./commands.js";
import { requestGate } from "./lifecycle.js";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

const runCli = (...args: string[]) =>
	spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--home", home, "gate", ...args],
		{
			encoding: "utf8",
			env: { ...process.env, ALIQUOT_HOME: "" },
		},
	);

const bram: Actor = { tag: "Agent", id: AgentId.parse("A-bram") };
const deploy = { target: "receiving-screen", version: "1.2.0" };
// sha256 of {"target":"receiving-screen","version":"1.2.0"}, from shasum.
const deployHash =
	"644b4ff33f551679c2cafd567934dd65cb8ea3d3c6bae02b1d676fafc67892e5";

const HOUR = 3600_000;

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-gate-cli-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/**
 * A seeded Ledger in `home` whose clock starts `agoMs` before the wall
 * clock, after `build`, closed for the command line.
 */
const seeded = <T>(agoMs: number, build: (s: Scenario) => T): T => {
	const s = scenario(new Date(Date.now() - agoMs).toISOString(), { home });
	try {
		return build(s);
	} finally {
		s.close();
	}
};

/** Bram's Deploy Gate, requested `agoMs` before the wall clock. */
const deployRequested = (agoMs = 60_000) =>
	seeded(agoMs, (s) =>
		requestGate(s.ledger, { actor: bram, kind: "Deploy", payload: deploy }),
	);

const events = () => {
	const ledger = openLedger({ home, writer: false });
	try {
		return ledger.all();
	} finally {
		ledger.close();
	}
};

/** Run a `gate` command in process, as the dispatcher would, with `input` on stdin. */
const inProcess = async (name: string, args: string[], input = "") => {
	const stdout = new PassThrough();
	const out: Buffer[] = [];
	stdout.on("data", (chunk: Buffer) => out.push(chunk));
	const ctx: CommandContext = {
		home,
		stdin: Readable.from([input]),
		stdout,
		stderr: new PassThrough().resume(),
	};
	const code = await gateCommands[name]?.run(args, ctx);
	return { code, stdout: Buffer.concat(out).toString("utf8") };
};

describe("aliquot gate", () => {
	it("request --task blocks the Task through the Task lifecycle, naming the Task's previous Event as its cause", () => {
		const { task_id, started } = seeded(0, (s) => ({
			task_id: s.task(AgentId.parse("A-bram")),
			started: s.events().at(-1),
		}));
		const file = join(home, "payload.json");
		writeFileSync(file, JSON.stringify(deploy));

		const requested = runCli(
			...["request", "--kind", "Deploy", "--payload", file],
			...["--task", "T-1", "--as", "A-bram"],
		);

		expect(requested.stderr).toBe("");
		expect(requested.status).toBe(0);
		expect(requested.stdout).toBe(`G-1 ${deployHash}\n`);
		expect(started?.kind).toBe("TaskStarted");
		expect(events().at(-1)).toMatchObject({
			kind: "GateRequested",
			actor: bram,
			task_id,
			causation_id: started?.seq,
			payload: { gate_id: "G-1", payload_hash: deployHash },
		});
		const ledger = openLedger({ home, writer: false });
		try {
			expect(ledger.projections.tasks.tasks.get(task_id)).toMatchObject({
				state: { tag: "Blocked", assignee: "A-bram", gate: "G-1" },
			});
		} finally {
			ledger.close();
		}
	});

	it("list shows each open Gate's kind, requester, age and a one-line payload summary, and --all shows an expired one as Expired", () => {
		const long = { note: "x".repeat(200) };
		seeded(3 * 24 * HOUR, (s) => {
			requestGate(s.ledger, {
				actor: bram,
				kind: "Deploy",
				payload: long,
				lifetime_s: 4 * 86400,
			});
			s.at(new Date(Date.now() - 2 * HOUR - 5 * 60_000).toISOString());
			requestGate(s.ledger, { actor: bram, kind: "Deploy", payload: deploy });
			s.at(new Date(Date.now() - 2 * HOUR).toISOString());
			requestGate(s.ledger, {
				actor: bram,
				kind: "Deploy",
				payload: deploy,
				lifetime_s: 3600,
			});
		});

		const open = runCli("list");
		const all = runCli("list", "--all");

		expect(open.status).toBe(0);
		const lines = open.stdout.trimEnd().split("\n");
		expect(lines[0]).toMatch(/^ID +KIND +REQUESTER +AGE +HASH +PAYLOAD$/);
		expect(lines).toHaveLength(3);
		const summary = lines[1]?.split(/ {2,}/) ?? [];
		expect(summary[3]).toBe("3d 0h");
		expect(summary.at(-1)).toHaveLength(60);
		expect(summary.at(-1)?.endsWith("…")).toBe(true);
		expect(lines[2]?.split(/ {2,}/)).toEqual([
			"G-2",
			"Deploy",
			"A-bram",
			"2h 5m",
			deployHash,
			'{"target":"receiving-screen","version":"1.2.0"}',
		]);
		expect(all.stdout).toMatch(/\nG-3 +Expired +Deploy +A-bram +2h 0m /);
	});

	it("show prints a Gate's full payload and its hash", () => {
		deployRequested();

		const { stdout, status } = runCli("show", "G-1");

		expect(status).toBe(0);
		expect(stdout).toContain("state: Open\n");
		expect(stdout).toContain(`payload_hash: ${deployHash}\n`);
		expect(stdout).toContain(
			'{\n  "target": "receiving-screen",\n  "version": "1.2.0"\n}\n',
		);
	});

	it("decide records the Operator's decision on the hash the Operator checked and prints the decision Event", () => {
		const requested = deployRequested();

		const decided = runCli(
			...["decide", "G-1", "--approve", "--hash", deployHash],
			...["--reason", "diff checked"],
		);

		expect(decided.stderr).toBe("");
		expect(decided.status).toBe(0);
		const event = JSON.parse(decided.stdout);
		expect(event).toEqual(events().at(-1));
		expect(event).toMatchObject({
			seq: requested.seq + 1,
			actor: { tag: "Operator" },
			causation_id: requested.seq,
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
	});
});

describe("gate commands in process", () => {
	it("request reads the payload from stdin for -", async () => {
		const result = await inProcess(
			"request",
			["--kind", "RetireAgent", "--payload", "-"],
			JSON.stringify({ agent_id: "A-rin" }),
		);

		expect(result).toEqual({
			code: 0,
			stdout: expect.stringMatching(/^G-1 [0-9a-f]{64}\n$/),
		});
	});

	it("decide refuses a decision without the hash the Operator checked, or that both approves and rejects", async () => {
		const decide = (...args: string[]) =>
			inProcess("decide", ["G-1", ...args, "--reason", "ok"]);

		await expect(decide("--approve")).rejects.toThrow(
			"gate decide needs --hash, the payload hash shown by gate show",
		);
		await expect(
			decide("--approve", "--reject", "--hash", deployHash),
		).rejects.toThrow("gate decide takes exactly one of --approve or --reject");
	});
});
