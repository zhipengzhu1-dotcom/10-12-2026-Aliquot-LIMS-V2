import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId } from "../ids.js";
import { openLedger } from "../ledger.js";
import { type Scenario, scenario, scores } from "../test-support/scenario.js";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const rin = AgentId.parse("A-rin");

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

/** A seeded Ledger in `home`, after `build`, closed for the command line. */
const seeded = (build: (s: Scenario) => void = () => {}) => {
	const s = scenario(undefined, { home });
	build(s);
	s.close();
};

const lastEvent = () => {
	const ledger = openLedger({ home, writer: false });
	try {
		return ledger.all().at(-1);
	} finally {
		ledger.close();
	}
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

	it("assign assigns a Proposed Task", () => {
		seeded((s) => s.task(rin, { start: false }));

		expect(ok("task", "assign", "T-1", "A-odile")).toBe(
			"T-1 Assigned (assignee A-odile)\n",
		);
	});

	it("start refuses a Task that is not Assigned, naming its state, and starts one that is", () => {
		seeded((s) => {
			s.task(rin);
			s.task(rin, { start: false });
		});

		const again = aliquot("task", "start", "T-1");
		expect(again.status).toBe(1);
		expect(again.stderr).toBe(
			"AppendRefused: TaskStarted refused: T-1 is InProgress, expected Assigned\n",
		);
		expect(ok("task", "start", "T-2", "--as", "A-rin")).toBe(
			"T-2 InProgress (assignee A-rin)\n",
		);
	});

	it("handoff hands an InProgress Task to another Agent", () => {
		seeded((s) => s.task(rin));

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

	it("complete skips Review when the Trust tier allows it, refuses a sampled Task with no --reviewer saying it was sampled, and sends it to the reviewer named", () => {
		// Rin is Trusted after 10 reviewed Tasks; the sample leaves T-11 out and picks T-15.
		seeded((s) => {
			for (let i = 0; i < 10; i++) s.reviewed(rin, scores(3));
			s.task(rin);
			for (let i = 0; i < 3; i++) s.task(rin, { start: false });
			s.task(rin);
		});

		expect(ok("task", "complete", "T-11", "--as", "A-rin")).toBe(
			"T-11 Done (assignee A-rin)\n",
		);
		expect(lastEvent()?.payload).toMatchObject({
			review: {
				tag: "Skipped",
				reason: "not sampled for Review at tier Trusted",
			},
		});
		const unnamed = aliquot("task", "complete", "T-15", "--as", "A-rin");
		expect(unnamed.status).toBe(1);
		expect(unnamed.stderr).toBe(
			"AppendRefused: TaskCompleted refused: T-15 is sampled for Review, as 1 in 3 Tasks of A-rin at Trusted are; its completion names a reviewer\n",
		);
		expect(
			ok("task", "complete", "T-15", "--reviewer", "A-pia", "--as", "A-rin"),
		).toBe("T-15 UnderReview (assignee A-rin, reviewer A-pia)\n");
		expect(lastEvent()?.payload).toMatchObject({
			review: { tag: "Required", reviewer: { tag: "Agent", id: "A-pia" } },
		});
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

	it("list groups Tasks by state with TAT class, priority and assignee, and says so when there are none", () => {
		expect(ok("task", "list")).toBe("No Tasks\n");
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
