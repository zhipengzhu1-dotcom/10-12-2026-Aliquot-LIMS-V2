import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendRefused } from "../append-guard.js";
import {
	AgentId,
	type ArtifactId,
	ScriptId,
	Sha256,
	type TaskId,
} from "../ids.js";
import { finishRun, startRun, store } from "../sandbox/lifecycle.js";
import { assign, handOff, propose, start } from "../task/lifecycle.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import type { Actor } from "../types/actor.js";
import type { ArtifactType } from "../types/artifact.js";

const operator: Actor = { tag: "Operator" };
const rin = AgentId.parse("A-rin");
const bram = AgentId.parse("A-bram");
const ines = AgentId.parse("A-ines");

let s: Scenario;
beforeEach(() => {
	s = scenario();
});
afterEach(() => s.close());

/** An Artifact of `type` that a Run of `task_id`, worked by `agent`, wrote. */
const written = (
	task_id: TaskId,
	agent: AgentId,
	type: ArtifactType,
	fill: string,
): ArtifactId => {
	const actor: Actor = { tag: "Agent", id: agent };
	const script = s.ledger.projections.scripts.scripts
		.get(ScriptId.parse("S-copy"))
		?.at(0);
	if (!script) throw new Error("the scenario registers S-copy");
	const { run_id } = startRun(s.ledger, {
		actor,
		task_id,
		script,
		inputs: [],
	});
	const { artifact } = store(
		s.ledger,
		{ actor },
		{
			sha256: Sha256.parse(fill.repeat(64)),
			media_type: "application/octet-stream",
			artifact_type: type,
			produced_by: { tag: "Run", id: run_id },
			lineage: [],
		},
	);
	finishRun(s.ledger, {
		actor,
		run: {
			id: run_id,
			script: { id: script.id, version: script.version },
			inputs: [],
			outputs: [artifact.id],
			exit_code: 0,
			stdout_ref: artifact.id,
			stderr_ref: artifact.id,
			duration_ms: 1,
		},
	});
	return artifact.id;
};

/** Rin's stage 4 Task and the Result Worksheet its Run wrote. */
const results = () => {
	const task_id = s.task(rin);
	return { task_id, worksheet: written(task_id, rin, "ResultWorksheet", "c") };
};

const proposed = (title: string, inputs: readonly ArtifactId[]) =>
	propose(s.ledger, {
		actor: operator,
		title,
		goal: "Run verify_results and pass the stage 5 Evaluation",
		inputs,
		tat_class: "Regular",
		priority: 1,
	}).task.id;

describe("the Verifier rule", () => {
	it("refuses a stage 5 Task to the assignee of the stage 4 Task whose Run wrote its Result Worksheet, naming both Tasks and the Agent, and writes nothing", () => {
		const stage4 = results();
		const stage5 = proposed("Stage 5 Verification: seed1.docx", [
			stage4.worksheet,
		]);
		const before = s.events().length;

		expect(() =>
			assign(s.ledger, { actor: operator, task_id: stage5, assignee: rin }),
		).toThrow(
			new AppendRefused(
				`TaskAssigned refused: A-rin was assigned ${stage4.task_id}, whose Run wrote the Result Worksheet that ${stage5} verifies; a Verifier is never the author of the Result Worksheet`,
			),
		);
		expect(s.events()).toHaveLength(before);
		expect(
			assign(s.ledger, { actor: operator, task_id: stage5, assignee: bram })
				.task.state,
		).toEqual({ tag: "Assigned", assignee: bram });
	});

	it("refuses a Hand-off of a stage 5 Task to the worksheet's author", () => {
		const stage4 = results();
		const stage5 = proposed("Stage 5 Verification: seed1.docx", [
			stage4.worksheet,
		]);
		assign(s.ledger, { actor: operator, task_id: stage5, assignee: bram });
		start(s.ledger, { actor: { tag: "Agent", id: bram }, task_id: stage5 });

		expect(() =>
			handOff(s.ledger, {
				actor: { tag: "Agent", id: bram },
				task_id: stage5,
				to: rin,
				reason: "Rin knows the worksheet",
			}),
		).toThrow(
			`TaskHandedOff refused: A-rin was assigned ${stage4.task_id}, whose Run wrote the Result Worksheet that ${stage5} verifies`,
		);
		expect(
			handOff(s.ledger, {
				actor: { tag: "Agent", id: bram },
				task_id: stage5,
				to: ines,
				reason: "Ines is free",
			}).task.state,
		).toEqual({ tag: "Assigned", assignee: ines });
	});

	it("refuses an Agent that was assigned the stage 4 Task before a Hand-off moved it on", () => {
		const task_id = s.task(rin);
		handOff(s.ledger, {
			actor: { tag: "Agent", id: rin },
			task_id,
			to: ines,
			reason: "Rin is busy",
		});
		start(s.ledger, { actor: { tag: "Agent", id: ines }, task_id });
		const worksheet = written(task_id, ines, "ResultWorksheet", "c");
		const stage5 = proposed("Stage 5 Verification: seed1.docx", [worksheet]);

		expect(() =>
			assign(s.ledger, { actor: operator, task_id: stage5, assignee: rin }),
		).toThrow(`A-rin was assigned ${task_id}`);
	});

	it("lets the worksheet's author take a Task that is not a Verification, and a Verification whose inputs hold no worksheet of theirs", () => {
		const stage4 = results();
		const other = written(s.task(rin), rin, "Other", "d");
		const report = proposed("Stage 6 Report: seed1.docx", [stage4.worksheet]);
		const unrelated = proposed("Stage 5 Verification: seed2.docx", [other]);

		expect(
			assign(s.ledger, { actor: operator, task_id: report, assignee: rin }).task
				.state,
		).toEqual({ tag: "Assigned", assignee: rin });
		expect(
			assign(s.ledger, { actor: operator, task_id: unrelated, assignee: rin })
				.task.state,
		).toEqual({ tag: "Assigned", assignee: rin });
	});
});
