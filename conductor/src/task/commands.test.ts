import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLedger } from "../ledger.js";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

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

const propose = (title: string, tat: string, priority: string) =>
	ok(
		"task",
		"propose",
		"--title",
		title,
		"--goal",
		`Do: ${title}`,
		"--tat",
		tat,
		"--priority",
		priority,
	).trim();

const ledgerEvents = () => {
	const ledger = openLedger({ home, writer: false });
	try {
		return ledger.all();
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
	it("drives a Task Proposed to Done through Review, one Event per step", () => {
		const id = propose("Parse the Submission Form", "Rush1to2Days", "2");
		ok("task", "assign", id, "A-odile");
		ok("task", "start", id, "--as", "A-odile");
		ok(
			"task",
			"complete",
			id,
			"--review-required",
			"--reviewer",
			"A-rin",
			"--as",
			"A-odile",
		);
		ok("task", "complete", id, "--reviewed", "--as", "A-rin");

		expect(id).toBe("T-1");
		expect(ledgerEvents().map((e) => [e.kind, e.task_id, e.actor])).toEqual([
			["TaskProposed", "T-1", { tag: "Operator" }],
			["TaskAssigned", "T-1", { tag: "Operator" }],
			["TaskStarted", "T-1", { tag: "Agent", id: "A-odile" }],
			["TaskCompleted", "T-1", { tag: "Agent", id: "A-odile" }],
			["TaskCompleted", "T-1", { tag: "Agent", id: "A-rin" }],
		]);
		expect(ok("task", "list")).toBe(
			"Done (1)\n  T-1  Parse the Submission Form  TAT Rush1to2Days  priority 2\n",
		);
	});

	it("refuses starting a Task that is not Assigned, naming its state", () => {
		const id = propose("Weigh the containers", "Regular", "1");

		const result = aliquot("task", "start", id);

		expect(result.status).toBe(1);
		expect(result.stderr).toBe(
			"AppendRefused: TaskStarted refused: T-1 is Proposed, expected Assigned\n",
		);
		expect(ledgerEvents()).toHaveLength(1);
	});

	it("lists Tasks grouped by state with TAT class, priority and assignee", () => {
		propose("Parse the Submission Form", "Rush1to2Days", "2");
		propose("Weigh the containers", "Regular", "1");
		propose("Check the Receiving Log", "Rush3to4Days", "3");
		ok("task", "assign", "T-1", "A-odile");
		ok("task", "start", "T-1");
		ok(
			"task",
			"handoff",
			"T-1",
			"A-rin",
			"--reason",
			"needs a second pair of eyes",
		);
		ok("task", "assign", "T-3", "A-odile");
		ok("task", "start", "T-3");
		ok(
			"task",
			"complete",
			"T-3",
			"--skip-review",
			"--reason",
			"Trusted tier, 1 in 3",
		);

		expect(ledgerEvents().at(-4)?.payload).toMatchObject({
			from: "A-odile",
			to: "A-rin",
		});
		expect(ok("task", "list")).toBe(
			[
				"Proposed (1)",
				"  T-2  Weigh the containers  TAT Regular  priority 1",
				"Assigned (1)",
				"  T-1  Parse the Submission Form  TAT Rush1to2Days  priority 2  assignee A-rin",
				"Done (1)",
				"  T-3  Check the Receiving Log  TAT Rush3to4Days  priority 3",
				"",
			].join("\n"),
		);
	});

	it("fails and escalates Tasks", () => {
		propose("Parse the Submission Form", "Regular", "1");
		propose("Weigh the containers", "Regular", "1");
		ok("task", "fail", "T-1", "--reason", "form unreadable");
		ok("task", "escalate", "T-2", "--to", "Operator", "--reason", "no balance");

		expect(ok("task", "list")).toBe(
			[
				"Escalated (1)",
				"  T-2  Weigh the containers  TAT Regular  priority 1",
				"Failed (1)",
				"  T-1  Parse the Submission Form  TAT Regular  priority 1",
				"",
			].join("\n"),
		);
	});

	it("says so when there are no Tasks", () => {
		expect(ok("task", "list")).toBe("No Tasks\n");
	});

	it("rejects a TAT class outside the three the Submission Form codes", () => {
		const result = aliquot(
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

		expect(result.status).toBe(2);
		expect(result.stderr).toContain(
			"--tat must be Regular, Rush1to2Days or Rush3to4Days",
		);
	});
});
