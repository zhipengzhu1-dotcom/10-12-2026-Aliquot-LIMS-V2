import { describe, expect, it } from "vitest";
import { FLOW_SOURCES, flowPage, ROW_PX } from "./flow.js";

const FORM = "f".repeat(64);
const RECORD = "e".repeat(64);
const RECEIPT = "d".repeat(64);
const OTHER_FORM = "c".repeat(64);

const stages = [
	{ number: 1, name: "Submission", script_id: "S-parse_submission" },
	{ number: 2, name: "Receipt", script_id: "S-log_receipt" },
];

const task = (
	id: string,
	state: Record<string, unknown>,
	artifacts: { inputs?: string[]; outputs?: string[] } = {},
) => ({
	id,
	title: `Work on ${id}`,
	goal: "",
	inputs: artifacts.inputs ?? [],
	outputs: artifacts.outputs ?? [],
	state,
	rubric_id: "RB-default",
	priority: 1,
	tat_class: "Regular",
});

const run = (seq: number, task_id: string, script: string) => ({
	started: {
		run_id: `R-${seq}`,
		script: { id: script, version: 1 },
		inputs: [],
	},
	seq,
	task_id,
});

const produced = (lineage: string[]) => [{ seq: 1, record: { lineage } }];

/** Tasks in several states across two stages, the no-stage lane, and two Lots of Lineage. */
const data = (events: unknown[] = []) => ({
	stages,
	tasks: {
		tasks: {
			"T-1": task(
				"T-1",
				{ tag: "Done", assignee: "A-rin" },
				{ inputs: [FORM], outputs: [RECORD] },
			),
			"T-2": task(
				"T-2",
				{ tag: "InProgress", assignee: "A-bram" },
				{ inputs: [RECORD] },
			),
			"T-3": task("T-3", { tag: "Proposed" }, { inputs: [OTHER_FORM] }),
			"T-4": task("T-4", { tag: "Failed", reason: "exit 1" }),
			"T-5": task(
				"T-5",
				{
					tag: "UnderReview",
					assignee: "A-bram",
					reviewer: { tag: "Operator" },
				},
				{ inputs: [RECEIPT] },
			),
			"T-6": task(
				"T-6",
				{ tag: "Assigned", assignee: "A-rin" },
				{ inputs: [FORM] },
			),
		},
	},
	runs: {
		runs: {
			"R-1": run(14, "T-1", "S-parse_submission"),
			"R-2": run(30, "T-2", "S-log_receipt"),
			"R-3": run(40, "T-4", "S-copy"),
			"R-4": run(50, "T-5", "S-parse_submission"),
			"R-5": run(60, "T-5", "S-log_receipt"),
		},
	},
	artifacts: {
		productions: {
			[FORM]: produced([]),
			[RECORD]: produced([FORM]),
			[RECEIPT]: produced([RECORD]),
			[OTHER_FORM]: produced([]),
		},
	},
	lots: { [RECORD]: "LOT-7" },
	"ledger?limit=1000": { events, next: null },
});

/** Each lane's key and the Task ids of its cards, in order. */
const lanes = (page: string) =>
	Object.fromEntries(
		[
			...page.matchAll(
				/<section class="lane" data-lane="([^"]+)">(.*?)<\/section>/gs,
			),
		].map(([, key, body]) => [
			key,
			[...(body ?? "").matchAll(/data-task="([^"]+)"/g)].map(([, id]) => id),
		]),
	);

describe("the Flow view", () => {
	it("reads the stage table, the Tasks, their Runs, Lineage, Lots and the Ledger", () => {
		expect(FLOW_SOURCES).toEqual([
			"stages",
			"tasks",
			"runs",
			"artifacts",
			"lots",
			"ledger?limit=1000",
		]);
	});

	it("puts each Task in the lane of the stage whose Script its latest Run ran", () => {
		const page = flowPage(data(), new URLSearchParams());

		expect(lanes(page)).toEqual({
			"1": ["T-1"],
			"2": ["T-2", "T-5"],
			none: ["T-3", "T-4", "T-6"],
		});
		expect(page).toContain(
			'<h2>1 Submission <span class="count">1</span></h2>',
		);
		expect(page).toContain('<h2>No stage <span class="count">3</span></h2>');
	});

	it("shows each card's id, title, state, assignee and TAT class", () => {
		const page = flowPage(data(), new URLSearchParams());
		const t2 = /<a class="card"[^>]*data-task="T-2"[^>]*>(.*?)<\/a>/s.exec(
			page,
		)?.[1];

		expect(t2).toContain("<b>T-2</b>");
		expect(t2).toContain(
			'<span class="state" data-state="InProgress">InProgress</span>',
		);
		expect(t2).toContain("Work on T-2");
		expect(t2).toContain("A-bram · Regular");
	});

	it("filters the cards by Task id", () => {
		const page = flowPage(data(), new URLSearchParams("task=T-5"));

		expect(lanes(page)).toEqual({ "1": [], "2": ["T-5"], none: [] });
		expect(page).toContain('name="task" value="T-5"');
	});

	it("filters the cards by the Lot of the SubmissionRecord in their Lineage", () => {
		const page = flowPage(data(), new URLSearchParams("lot=LOT-7"));

		expect(lanes(page)).toEqual({
			"1": ["T-1"],
			"2": ["T-2", "T-5"],
			none: ["T-6"],
		});
		expect(page).toContain('<option value="LOT-7" selected>LOT-7</option>');
	});

	it("shows Ledger strings as text, not markup", () => {
		const json = data();
		json.tasks.tasks["T-3"].title = "<img src=x onerror=alert(1)>";
		json.lots[RECORD] = '"><script>alert(1)</script>';

		const page = flowPage(json, new URLSearchParams());

		expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(page).not.toContain("<img");
		expect(page).not.toContain("<script>");
	});
});

/** The stage 1 chain of README.md's Workflow tracer table, seq 1 to 22. */
const STAGE_1_CHAIN: readonly [number, string, number | undefined][] = [
	...Array.from(
		{ length: 8 },
		(_, i) =>
			[i + 1, "AgentRecruited", undefined] as [number, string, undefined],
	),
	[9, "ScriptRegistered", undefined],
	[10, "ArtifactStored", undefined],
	[11, "TaskProposed", 10],
	[12, "TaskAssigned", 11],
	[13, "TaskStarted", 12],
	[14, "RunStarted", 13],
	[15, "ArtifactStored", 14],
	[16, "ArtifactStored", 14],
	[17, "ArtifactStored", 14],
	[18, "RunFinished", 14],
	[19, "EvaluationRecorded", 18],
	[20, "TaskCompleted", 19],
	[21, "ReviewRecorded", 20],
	[22, "TaskCompleted", 21],
];

const scores = (n: number) => ({
	quality: n,
	traceability: n,
	boundary_adherence: n,
	collaboration: n,
	timeliness: n,
});

/** The payload fields the panel's rows read, by seq. */
const PAYLOADS: Readonly<Record<number, Record<string, unknown>>> = {
	10: {
		artifact_type: "SubmissionForm",
		filename: "submission-form-seed1.docx",
	},
	11: {
		task_id: "T-1",
		title: "Stage 1 Submission: submission-form-seed1.docx",
	},
	12: { task_id: "T-1", assignee: "A-rin" },
	13: { task_id: "T-1" },
	14: { run_id: "R-1", script: { id: "S-parse_submission", version: 1 } },
	15: { artifact_type: "SubmissionRecord", filename: "submission.json" },
	16: { artifact_type: "Other", filename: "stdout" },
	17: { artifact_type: "Other", filename: "stderr" },
	18: { id: "R-1", exit_code: 0 },
	19: { eval_id: "E-1", task_id: "T-1", score: 1, passed: true },
	20: { task_id: "T-1", review: { tag: "Required" } },
	21: { task_id: "T-1", ...scores(3) },
	22: { task_id: "T-1", review: { tag: "Reviewed" } },
};

const chainEvents = STAGE_1_CHAIN.map(([seq, kind, causation_id]) => ({
	seq,
	kind,
	ts: "2026-10-12T09:00:00.000Z",
	actor:
		seq === 21 || seq === 22
			? { tag: "Agent", id: "A-pia" }
			: { tag: "Operator" },
	...(seq >= 11 && { task_id: "T-1" }),
	...(causation_id !== undefined && { causation_id }),
	payload: PAYLOADS[seq] ?? {},
}));

describe("the Task's Event panel", () => {
	const page = flowPage(data(chainEvents), new URLSearchParams("open=T-1"));
	const rows = [...page.matchAll(/<li data-seq="(\d+)"/g)].map(([, s]) =>
		Number(s),
	);
	const arrows = [
		...page.matchAll(
			/<path data-from="(\d+)" data-to="(\d+)" d="M [\d.]+ ([\d.]+) C [\d.]+ [\d.]+ [\d.]+ [\d.]+ [\d.]+ ([\d.]+)"/g,
		),
	].map(([, from, to, y1, y2]) => ({
		from: Number(from),
		to: Number(to),
		y1: Number(y1),
		y2: Number(y2),
	}));

	it("lists the Task's Events in seq order after the cause it starts from", () => {
		expect(rows).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
		expect(page).toContain('<li data-seq="10" class="outside">');
	});

	it("draws one arrow from each Event to the Event it names as cause", () => {
		expect(arrows.map(({ from, to }) => [from, to])).toEqual([
			[11, 10],
			[12, 11],
			[13, 12],
			[14, 13],
			[15, 14],
			[16, 14],
			[17, 14],
			[18, 14],
			[19, 18],
			[20, 19],
			[21, 20],
			[22, 21],
		]);
	});

	it("starts each arrow at its Event's row and ends it at its cause's row", () => {
		const middle = (seq: number) => rows.indexOf(seq) * ROW_PX + ROW_PX / 2;

		for (const { from, to, y1, y2 } of arrows) {
			expect([y1, y2], `arrow ${from} to ${to}`).toEqual([
				middle(from),
				middle(to),
			]);
		}
	});

	it("says on each row who appended the Event and what it did", () => {
		expect(page).toContain(
			'<li data-seq="19"><span class="seq">19</span> <span class="kind">EvaluationRecorded</span> <span class="actor">Operator</span> <span class="detail">E-1 score 1.000, passed</span> <span class="cause">cause 18</span></li>',
		);
		expect(page).toContain(
			'<span class="kind">ReviewRecorded</span> <span class="actor">A-pia</span> <span class="detail">3 3 3 3 3</span>',
		);
	});

	it("closes back to the filtered Flow view", () => {
		const filtered = flowPage(
			data(chainEvents),
			new URLSearchParams("lot=LOT-7&open=T-1"),
		);

		expect(filtered).toContain('<a href="#/flow?lot=LOT-7">Close</a>');
		expect(filtered).toContain('href="#/flow?lot=LOT-7&amp;open=T-2"');
	});
});
