import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendRefused } from "../append-guard.js";
import type { NewEvent } from "../events.js";
import { canonicalJson, sha256Hex } from "../hash.js";
import {
	AgentId,
	ArtifactId,
	GateId,
	RubricId,
	Sha256,
	TaskId,
} from "../ids.js";
import { type Ledger, openMemoryLedger } from "../ledger.js";
import { scenario, scores } from "../test-support/scenario.js";
import { reviewSampled } from "../vitality/trust.js";

const operator = { tag: "Operator" } as const;
const odile = AgentId.parse("A-odile");
const rin = AgentId.parse("A-rin");
const T1 = TaskId.parse("T-1");
const output = ArtifactId.parse("a".repeat(64));

type TaskBody<K extends NewEvent["kind"]> = Extract<NewEvent, { kind: K }>;
const on = <K extends NewEvent["kind"]>(
	kind: K,
	payload: TaskBody<K>["payload"],
	actor: NewEvent["actor"] = operator,
) => ({ actor, task_id: T1, kind, payload }) as NewEvent;

const assigned = (assignee = odile) =>
	on("TaskAssigned", { task_id: T1, assignee });
const started = () => on("TaskStarted", { task_id: T1 });
const completed = (
	review: TaskBody<"TaskCompleted">["payload"]["review"],
	outputs = [output],
) => on("TaskCompleted", { task_id: T1, outputs, review });
const reviewRecorded = () =>
	on("ReviewRecorded", {
		task_id: T1,
		reviewer: operator,
		quality: 3,
		traceability: 3,
		boundary_adherence: 3,
		collaboration: 3,
		timeliness: 3,
		note: "",
	});

const G1 = GateId.parse("G-1");
const payloadHash = Sha256.parse(sha256Hex(canonicalJson({})));
const gateRequested = (task_id: TaskId | undefined): NewEvent => ({
	actor: { tag: "Agent", id: odile },
	...(task_id && { task_id }),
	kind: "GateRequested",
	payload: {
		gate_id: G1,
		kind: "WriteSystemOfRecord",
		payload: {},
		payload_hash: payloadHash,
		lifetime_s: 3600,
	},
});
const gateDecided = (task_id: TaskId | undefined): NewEvent => ({
	actor: operator,
	...(task_id && { task_id }),
	kind: "GateDecided",
	payload: {
		gate_id: G1,
		decided_by: operator,
		payload_hash: payloadHash,
		meaning: "approve",
		reason: "looks right",
	},
});

const proposed = (task_id = T1): NewEvent => ({
	actor: operator,
	task_id,
	kind: "TaskProposed",
	payload: {
		task_id,
		title: "Parse the Submission Form",
		goal: "Extract every field",
		inputs: [],
		rubric_id: RubricId.parse("default"),
		priority: 2,
		tat_class: "Rush1to2Days",
	},
});

let ledger: Ledger;

beforeEach(() => {
	ledger = openMemoryLedger();
});

afterEach(() => ledger.close());

const tasks = () => ledger.projections.tasks.tasks;

describe("TaskProjection", () => {
	it("folds TaskProposed into a Proposed Task carrying its TAT class and priority", () => {
		ledger.append(proposed());

		expect(tasks().get(T1)).toEqual({
			id: "T-1",
			title: "Parse the Submission Form",
			goal: "Extract every field",
			inputs: [],
			outputs: [],
			state: { tag: "Proposed" },
			rubric_id: "default",
			priority: 2,
			tat_class: "Rush1to2Days",
		});
	});

	it("drives a Task Proposed to Done through Review, one state per Event", () => {
		const states = [
			proposed(),
			assigned(),
			started(),
			completed({ tag: "Required", reviewer: operator }),
			reviewRecorded(),
			completed({ tag: "Reviewed" }, []),
		].map((event) => {
			ledger.append(event);
			return tasks().get(T1)?.state;
		});

		expect(states).toEqual([
			{ tag: "Proposed" },
			{ tag: "Assigned", assignee: "A-odile" },
			{ tag: "InProgress", assignee: "A-odile" },
			{ tag: "UnderReview", assignee: "A-odile", reviewer: operator },
			{ tag: "UnderReview", assignee: "A-odile", reviewer: operator },
			{ tag: "Done", assignee: "A-odile" },
		]);
		expect(ledger.all()).toHaveLength(6);
		expect(tasks().get(T1)?.outputs).toEqual([output]);
	});

	it("returns a handed-off Task to Assigned with the new assignee, and the Event records the old one", () => {
		ledger.append(proposed());
		ledger.append(assigned(odile));
		ledger.append(started());
		const handoff = ledger.append(
			on("TaskHandedOff", {
				task_id: T1,
				from: odile,
				to: rin,
				reason: "needs a Python reviewer",
			}),
		);

		expect(tasks().get(T1)?.state).toEqual({
			tag: "Assigned",
			assignee: "A-rin",
		});
		expect(handoff.payload).toMatchObject({ from: "A-odile", to: "A-rin" });
	});

	it("takes a Task skipped for Review from InProgress straight to Done", () => {
		// A Trusted Agent, so the Trust tier rules may skip a Task for Review.
		const s = scenario();
		try {
			for (let i = 0; i < 10; i++) s.reviewed(rin, scores(3));
			const t = s.skipped(rin); // T-11, which the 1 in 3 sample does not pick

			expect(reviewSampled(t, "Trusted")).toBe(false);
			expect(s.ledger.projections.tasks.tasks.get(t)).toMatchObject({
				state: { tag: "Done", assignee: rin },
				outputs: [output],
			});
		} finally {
			s.close();
		}
	});
});

describe("TaskProjection beyond the happy path", () => {
	const inProgress = () => {
		ledger.append(proposed());
		ledger.append(assigned());
		ledger.append(started());
	};

	it("blocks an InProgress Task on the Gate it requested and resumes it when that Gate is decided", () => {
		inProgress();
		ledger.append(gateRequested(T1));
		const blocked = tasks().get(T1)?.state;
		ledger.append(gateDecided(T1));

		expect(blocked).toEqual({
			tag: "Blocked",
			assignee: "A-odile",
			gate: "G-1",
		});
		expect(tasks().get(T1)?.state).toEqual({
			tag: "InProgress",
			assignee: "A-odile",
		});
	});

	it("leaves Tasks alone for a Gate that names no Task", () => {
		inProgress();
		ledger.append(gateRequested(undefined));
		ledger.append(gateDecided(undefined));

		expect(tasks().get(T1)?.state.tag).toBe("InProgress");
	});

	it("fails or escalates a Task from any live state", () => {
		const T2 = TaskId.parse("T-2");
		ledger.append(proposed());
		ledger.append(proposed(T2));
		ledger.append(on("TaskFailed", { task_id: T1, reason: "inputs missing" }));
		ledger.append({
			...on("TaskEscalated", { task_id: T2, to: operator, reason: "stuck" }),
			task_id: T2,
		});

		expect(tasks().get(T1)?.state).toEqual({
			tag: "Failed",
			reason: "inputs missing",
		});
		expect(tasks().get(T2)?.state).toEqual({ tag: "Escalated", to: operator });
	});
});

describe("the Task state machine at append", () => {
	it("refuses starting a Task that is not Assigned, naming its state, and writes nothing", () => {
		ledger.append(proposed());

		expect(() => ledger.append(started())).toThrow(
			new AppendRefused(
				"TaskStarted refused: T-1 is Proposed, expected Assigned",
			),
		);
		expect(ledger.all()).toHaveLength(1);
	});

	it("refuses completing a Task that is not InProgress or UnderReview, naming its state", () => {
		ledger.append(proposed());
		ledger.append(assigned());

		expect(() =>
			ledger.append(completed({ tag: "Skipped", reason: "Trusted tier" })),
		).toThrow(
			"TaskCompleted refused: T-1 is Assigned, expected InProgress for review Skipped",
		);
		expect(() => ledger.append(completed({ tag: "Reviewed" }))).toThrow(
			"TaskCompleted refused: T-1 is Assigned, expected UnderReview for review Reviewed",
		);
	});

	it("refuses a Hand-off from an Agent who does not hold the Task", () => {
		ledger.append(proposed());
		ledger.append(assigned(odile));
		ledger.append(started());

		expect(() =>
			ledger.append(
				on("TaskHandedOff", { task_id: T1, from: rin, to: rin, reason: "" }),
			),
		).toThrow("TaskHandedOff refused: T-1 is assigned to A-odile, not A-rin");
	});

	it("refuses failing a Task that is already Done", () => {
		ledger.append(proposed());
		ledger.append(assigned());
		ledger.append(started());
		ledger.append(completed({ tag: "Required", reviewer: operator }));
		ledger.append(reviewRecorded());
		ledger.append(completed({ tag: "Reviewed" }));

		expect(() =>
			ledger.append(on("TaskFailed", { task_id: T1, reason: "late" })),
		).toThrow(
			"TaskFailed refused: T-1 is Done, expected Proposed, Assigned, InProgress, UnderReview or Blocked",
		);
	});

	it("refuses a Gate request on behalf of a Task that is not InProgress", () => {
		ledger.append(proposed());

		expect(() => ledger.append(gateRequested(T1))).toThrow(
			"GateRequested refused: T-1 is Proposed, expected InProgress",
		);
	});

	it("refuses an Event for a Task that does not exist", () => {
		expect(() => ledger.append(assigned())).toThrow(
			"TaskAssigned refused: T-1 does not exist",
		);
	});

	it("refuses proposing a Task id that already exists", () => {
		ledger.append(proposed());

		expect(() => ledger.append(proposed())).toThrow(
			"TaskProposed refused: T-1 already exists and is Proposed",
		);
	});
});
