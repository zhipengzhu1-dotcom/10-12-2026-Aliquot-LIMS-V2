import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewEvent } from "../events.js";
import { AgentId, ArtifactId, RubricId, TaskId } from "../ids.js";
import { type Ledger, openLedger } from "../ledger.js";
import { fold } from "../reduce.js";
import { taskGuards } from "./guards.js";
import { TaskProjection } from "./projection.js";

const operator = { tag: "Operator" } as const;
const odile = AgentId.parse("A-odile");
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
});
