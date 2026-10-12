import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendRefused } from "../append-guard.js";
import type { NewEvent } from "../events.js";
import { canonicalJson, sha256Hex } from "../hash.js";
import {
	AgentId,
	ArtifactId,
	GateId,
	IsoTime,
	RubricId,
	Sha256,
	TaskId,
} from "../ids.js";
import { type Ledger, openLedger } from "../ledger.js";
import { fold } from "../reduce.js";
import { taskGuards } from "./guards.js";
import { TaskProjection } from "./projection.js";

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
const gateDecided = (gate_id = G1): NewEvent => ({
	actor: operator,
	kind: "GateDecided",
	payload: {
		gate_id,
		decided_by: operator,
		decided_at: IsoTime.parse("2026-10-12T10:00:00.000Z"),
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

let home: string;
let ledger: Ledger;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-task-"));
	ledger = openLedger({ home, writer: true, guards: taskGuards });
});

afterEach(() => {
	ledger.close();
	rmSync(home, { recursive: true, force: true });
});

const tasks = () =>
	fold(ledger.all(), TaskProjection.reduce, TaskProjection.init).tasks;

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
			{ tag: "Done" },
		]);
		expect(ledger.all()).toHaveLength(5);
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
		ledger.append(proposed());
		ledger.append(assigned());
		ledger.append(started());
		ledger.append(completed({ tag: "Skipped", reason: "Trusted, 1 in 3" }));

		expect(tasks().get(T1)).toMatchObject({
			state: { tag: "Done" },
			outputs: [output],
		});
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
		ledger.append(gateDecided());

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
		ledger.append(gateDecided());

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

	it("gives deep-equal Task maps from two folds of the same Ledger", () => {
		inProgress();
		ledger.append(gateRequested(T1));
		ledger.append(gateDecided());
		ledger.append(completed({ tag: "Required", reviewer: operator }));
		const events = ledger.all();

		const first = fold(events, TaskProjection.reduce, TaskProjection.init);
		const second = fold(events, TaskProjection.reduce, TaskProjection.init);

		expect(second).not.toBe(first);
		expect(second).toEqual(first);
		expect(first.tasks.size).toBe(1);
	});
});

describe("taskGuards", () => {
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
			"TaskCompleted (review Skipped) refused: T-1 is Assigned, expected InProgress",
		);
		expect(() => ledger.append(completed({ tag: "Reviewed" }))).toThrow(
			"TaskCompleted (review Reviewed) refused: T-1 is Assigned, expected UnderReview",
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
		ledger.append(completed({ tag: "Skipped", reason: "Senior" }));

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
