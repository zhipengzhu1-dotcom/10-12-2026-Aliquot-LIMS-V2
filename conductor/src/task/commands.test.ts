import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../command.js";
import { AgentId } from "../ids.js";
import { openLedger } from "../ledger.js";
import { type Scenario, scenario, scores } from "../test-support/scenario.js";
import { finishTurn, startTurn } from "../turn/lifecycle.js";
import { sample } from "../vitality/lifecycle.js";
import { taskCommands } from "./commands.js";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const rin = AgentId.parse("A-rin");
const ines = AgentId.parse("A-ines");

let home: string;

const aliquot = (...args: string[]) =>
	spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--home", home, ...args],
		{
			encoding: "utf8",
			env: { ...process.env, ALIQUOT_HOME: "" },
		},
	);

/** Run a command that must succeed and return its stdout. */
const ok = (...args: string[]) => {
	const result = aliquot(...args);
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
	return result.stdout;
};

/** Run a command the Ledger must refuse and return the refusal it prints. */
const refused = (...args: string[]) => {
	const result = aliquot(...args);
	expect(result.stdout).toBe("");
	expect(result.status).toBe(1);
	const [name, ...refusal] = result.stderr.trimEnd().split(": ");
	expect(name).toBe("AppendRefused");
	return refusal.join(": ");
};

/**
 * A-ines spends 80,000 tokens in a Turn six hours ago and is sampled then:
 * 80,000 of the 125,000 tokens each of 8 Agents gets under the default
 * Energy budget puts fatigue at 0.64, so its latest sample is strained. A
 * sample taken now leaves that Turn outside the 5-hour window.
 */
const strainedSixHoursAgo = (s: Scenario) => {
	const energyBudgetTokens = 1_000_000;
	s.at(new Date(Date.now() - 6 * 3_600_000).toISOString());
	const { turn } = startTurn(s.ledger, {
		agent: ines,
		model: "claude-opus-5-5",
		energyBudgetTokens,
	});
	finishTurn(s.ledger, {
		turn_id: turn.started.turn_id,
		usage: {
			input_tokens: 80_000,
			output_tokens: 0,
			cache_creation_tokens: 0,
			cache_read_tokens: 0,
			cost_usd: 0.05,
		},
		outcome: { tag: "Completed" },
		tool_calls: 1,
	});
	const { vitality } = sample(s.ledger, {
		actor: { tag: "Operator" },
		agent: ines,
		now: s.now(),
		energyBudgetTokens,
	});
	expect(vitality.fatigue).toBe(0.64);
};

/** A seeded Ledger in `home`, after `build`, closed for the command line. */
const seeded = (build: (s: Scenario) => void = () => {}) => {
	const s = scenario(undefined, { home });
	build(s);
	s.close();
};

const events = () => {
	const ledger = openLedger({ home, writer: false });
	try {
		return ledger.all();
	} finally {
		ledger.close();
	}
};
const lastEvent = () => events().at(-1);

/** Run a `task` command in process, as the dispatcher would, and return its stdout. */
const inProcess = async (name: string, ...args: string[]) => {
	const stdout = new PassThrough();
	const out: Buffer[] = [];
	stdout.on("data", (chunk: Buffer) => out.push(chunk));
	const stderr = new PassThrough().resume();
	const ctx: CommandContext = {
		home,
		stdin: Readable.from([]),
		stdout,
		stderr,
	};
	const code = await taskCommands[name]?.run(args, ctx);
	return { code, stdout: Buffer.concat(out).toString("utf8") };
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-task-cli-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("aliquot task", () => {
	it("propose prints the new Task's id and refuses a TAT class outside the three the Submission Form codes", () => {
		const urgent = aliquot(
			"task",
			"propose",
			"--title",
			"x",
			"--goal",
			"y",
			"--tat",
			"Urgent",
			"--priority",
			"1",
		);
		expect(urgent.status).toBe(2);
		expect(urgent.stderr).toContain(
			"--tat must be Regular, Rush1to2Days or Rush3to4Days",
		);

		expect(
			ok(
				"task",
				"propose",
				"--title",
				"Parse the Submission Form",
				"--goal",
				"Extract every field",
				"--tat",
				"Rush1to2Days",
				"--priority",
				"2",
			),
		).toBe("T-1\n");
		expect(lastEvent()).toMatchObject({
			actor: { tag: "Operator" },
			kind: "TaskProposed",
			payload: {
				task_id: "T-1",
				title: "Parse the Submission Form",
				rubric_id: "default",
				tat_class: "Rush1to2Days",
				priority: 2,
			},
		});
	});

	it("assign assigns a Proposed Task, and is refused to an Agent strained or worse until Rest ends or a fresh sample", () => {
		seeded((s) => {
			s.task(rin, { start: false });
			strainedSixHoursAgo(s);
		});

		expect(ok("task", "assign", "T-1", "A-odile")).toBe(
			"T-1 Assigned (assignee A-odile)\n",
		);

		expect(refused("task", "assign", "T-1", "A-ines")).toBe(
			"TaskAssigned refused: A-ines is strained and may not accept a Task",
		);
		expect(ok("vitality", "sample", "A-ines")).toMatch(/ fatigue=0\.00 /);
		expect(ok("task", "assign", "T-1", "A-ines")).toBe(
			"T-1 Assigned (assignee A-ines)\n",
		);

		ok("vitality", "rest", "A-bram", "--begin", "--reason", "fatigue 0.92");
		expect(refused("task", "assign", "T-1", "A-bram")).toBe(
			"TaskAssigned refused: A-bram is resting and may not accept a Task",
		);
		ok("vitality", "rest", "A-bram", "--end", "--reason", "fatigue 0.41");
		expect(ok("task", "assign", "T-1", "A-bram")).toBe(
			"T-1 Assigned (assignee A-bram)\n",
		);
	});

	it("start starts an Assigned Task", () => {
		seeded((s) => s.task(rin, { start: false }));

		expect(ok("task", "start", "T-1", "--as", "A-rin")).toBe(
			"T-1 InProgress (assignee A-rin)\n",
		);
	});

	it("handoff hands an InProgress Task to another Agent, and is refused to an Agent strained or worse", () => {
		seeded((s) => {
			s.task(rin);
			strainedSixHoursAgo(s);
		});

		expect(
			refused("task", "handoff", "T-1", "A-ines", "--reason", "too much"),
		).toBe(
			"TaskHandedOff refused: A-ines is strained and may not accept a Task",
		);
		expect(ok("vitality", "sample", "A-ines")).toMatch(/ fatigue=0\.00 /);
		expect(
			ok("task", "handoff", "T-1", "A-ines", "--reason", "second opinion"),
		).toBe("T-1 Assigned (assignee A-ines)\n");
		expect(lastEvent()?.payload).toEqual({
			task_id: "T-1",
			from: "A-rin",
			to: "A-ines",
			reason: "second opinion",
		});
	});

	it("complete sends a sampled Task to its reviewer and closes it after the Review, each Event of the chain naming the one before it", () => {
		seeded();
		const before = events().length;
		ok(
			"task",
			"propose",
			"--title",
			"Parse the Submission Form",
			"--goal",
			"Extract every field",
			"--tat",
			"Regular",
			"--priority",
			"1",
		);
		ok("task", "assign", "T-1", "A-rin");
		ok("task", "start", "T-1", "--as", "A-rin");
		expect(
			refused(
				"task",
				"complete",
				"T-1",
				"--reviewer",
				"A-odile",
				"--as",
				"A-rin",
			),
		).toBe(
			"TaskCompleted refused: A-rin is a Specialist on Probation, reviewed by a Supervisor (A-pia or A-anselm), the Auditor (A-thorne) or a Senior or Mentor Agent (none); A-odile may not review T-1",
		);
		expect(
			ok("task", "complete", "T-1", "--reviewer", "A-pia", "--as", "A-rin"),
		).toBe("T-1 UnderReview (assignee A-rin, reviewer A-pia)\n");
		ok(
			"vitality",
			"review",
			"T-1",
			...["--quality", "3", "--traceability", "3", "--boundary", "3"],
			...["--collaboration", "3", "--timeliness", "3"],
			...["--note", "Clean work", "--as", "A-pia"],
		);

		expect(ok("task", "complete", "T-1", "--as", "A-pia")).toBe(
			"T-1 Done (assignee A-rin)\n",
		);
		const chain = events().slice(before);
		expect(chain.map((e) => [e.kind, e.causation_id])).toEqual([
			["TaskProposed", undefined],
			...chain.slice(1).map((e, i) => [e.kind, chain[i]?.seq]),
		]);
		expect(chain.map((e) => e.kind)).toEqual([
			"TaskProposed",
			"TaskAssigned",
			"TaskStarted",
			"TaskCompleted",
			"ReviewRecorded",
			"TaskCompleted",
		]);
	});

	it("fail fails a live Task with its reason", () => {
		seeded((s) => s.task(rin));

		expect(ok("task", "fail", "T-1", "--reason", "form unreadable")).toBe(
			"T-1 Failed (reason form unreadable)\n",
		);
	});

	it("escalate escalates a live Task to the Operator", () => {
		seeded((s) => s.task(rin));

		expect(
			ok(
				"task",
				"escalate",
				"T-1",
				"--to",
				"Operator",
				"--reason",
				"no balance",
			),
		).toBe("T-1 Escalated (to Operator)\n");
	});

	it("list groups Tasks by state with TAT class, priority and assignee", () => {
		seeded((s) => {
			s.reviewed(rin, scores(3));
			s.task(rin, { start: false });
		});

		expect(ok("task", "list")).toBe(
			[
				"Assigned (1)",
				"  T-2  Task 2  TAT Regular  priority 1  assignee A-rin",
				"Done (1)",
				"  T-1  Task 1  TAT Regular  priority 1  assignee A-rin",
				"",
			].join("\n"),
		);
	});
});

describe("task commands in process", () => {
	it("complete says the Review was skipped and the reviewer unused when the Trust tier leaves the Task out of the sample", async () => {
		// Rin is Trusted after 10 reviewed Tasks; the 1 in 3 sample leaves T-11 out.
		seeded((s) => {
			for (let i = 0; i < 10; i++) s.reviewed(rin, scores(3));
			s.task(rin);
		});

		const done = await inProcess(
			"complete",
			...["T-11", "--reviewer", "A-pia", "--as", "A-rin"],
		);

		expect(done).toEqual({
			code: 0,
			stdout:
				"T-11 Done (assignee A-rin)\n" +
				"Review skipped: T-11 was not sampled for Review at tier Trusted, so the reviewer A-pia is unused\n",
		});
	});

	it("list says so when there are no Tasks", async () => {
		expect(await inProcess("list")).toEqual({ code: 0, stdout: "No Tasks\n" });
	});
});
