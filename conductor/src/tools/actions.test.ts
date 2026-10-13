import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AgentId,
	type ArtifactId,
	type RunId,
	Sha256,
	type TaskId,
} from "../ids.js";
import { openMemoryLedger } from "../ledger.js";
import { revise } from "../org/lifecycle.js";
import {
	ACTION_OF_ROSTER_TEXT,
	rosterDefinitions,
	seedOrg,
} from "../org/seed.js";
import { finishRun, startRun, store } from "../sandbox/lifecycle.js";
import { memoryStorage } from "../storage.js";
import { assign, propose, start } from "../task/lifecycle.js";
import { forge } from "../test-support/forge.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import { finishTurn, startTurn } from "../turn/lifecycle.js";
import { Action } from "../types/action.js";
import type { Actor } from "../types/actor.js";
import type { ArtifactType } from "../types/artifact.js";
import { sample } from "../vitality/lifecycle.js";
import { checkStages, type Stage } from "../workflow/stages.js";
import type { ToolCall } from "./actions.js";
import { callTool, refusalOf } from "./hook.js";
import { toolContext } from "./tool.js";

const operator: Actor = { tag: "Operator" };
const id = (slug: string) => AgentId.parse(`A-${slug}`);
const self = (slug: string): Actor => ({ tag: "Agent", id: id(slug) });
const passed = () => ({ score: 1, passed: true, findings: [] });

/** The six stages of the toy workflow, as the overview plans them. */
const STAGES: readonly Stage[] = checkStages(
	(
		[
			[
				"Submission",
				"parse_submission",
				"SubmissionForm",
				"SubmissionRecord",
				"rin",
			],
			["Receipt", "log_receipt", "SubmissionRecord", "ReceivingLogRow", "bram"],
			[
				"Work Order",
				"create_work_order",
				"ReceivingLogRow",
				"WorkOrder",
				"bram",
			],
			["Results", "compute_results", "WorkOrder", "ResultWorksheet", "rin"],
			[
				"Verification",
				"verify_results",
				"ResultWorksheet",
				"VerificationRecord",
				"bram",
			],
			[
				"Report",
				"render_roa",
				"VerificationRecord",
				"ReportOfAnalysis",
				"ines",
			],
		] as const
	).map(([name, script, input, output, worked_by], i) => ({
		number: i + 1,
		name,
		script,
		inputs: [input],
		carried: [],
		outputs: [output],
		worked_by: id(worked_by),
		reviewed_by: id(i < 3 ? "pia" : "anselm"),
		evaluate: passed,
	})),
);

let s: Scenario;
beforeEach(() => {
	s = scenario("2026-10-12T09:00:00.000Z");
});
afterEach(() => s.close());

let bytes = 0;
/** An Artifact of `type` the Operator stored, or a Run produced. */
const artifact = (
	artifact_type: ArtifactType,
	produced_by: { tag: "Run"; id: RunId } | { tag: "Operator" } = {
		tag: "Operator",
	},
): ArtifactId =>
	store(
		s.ledger,
		{ actor: operator },
		{
			sha256: Sha256.parse((++bytes).toString(16).padStart(64, "0")),
			media_type: "application/octet-stream",
			artifact_type,
			produced_by,
			lineage: [],
		},
	).artifact.id;

/** A Task on `inputs`, proposed by `by` and, when named, assigned to `to`. */
const task = (
	inputs: readonly ArtifactId[],
	{ by = operator, to }: { by?: Actor; to?: string } = {},
): TaskId => {
	const task_id = propose(s.ledger, {
		actor: by,
		title: "Work",
		goal: "",
		tat_class: "Regular",
		priority: 1,
		inputs,
	}).task.id;
	if (to !== undefined) {
		assign(s.ledger, { actor: operator, task_id, assignee: id(to) });
	}
	return task_id;
};

/** `slug`'s Charter forbids exactly `actions`, by the Operator's Revision. */
const forbid = (slug: string, actions: Action[]) => {
	const agent = s.ledger.projections.org.agents.get(id(slug));
	if (agent === undefined) throw new Error(`${slug} is not seeded`);
	const { definition } = agent;
	revise(s.ledger, {
		actor: operator,
		definition: {
			...definition,
			version: definition.version + 1,
			charter: { ...definition.charter, forbidden: actions },
			revised_by: operator,
			revision_reason: "Test Charter",
		},
	});
};

/** The hook's verdict on `slug` calling `name` with `input`, recording nothing. */
const verdict = (slug: string, name: string, input: object) =>
	refusalOf(
		{ agent: id(slug), stages: STAGES, name, input } as ToolCall,
		s.ledger.projections,
	);

/** `slug` calls `name` through the hook; a refusal is recorded. */
const call = (slug: string, name: string, input: object) =>
	callTool(
		toolContext({
			ledger: s.ledger,
			home: "/nonexistent",
			agent: id(slug),
			stages: STAGES,
		}),
		name,
		input,
	);

const lastEvent = () => s.events().at(-1);

describe("the relational Actions", () => {
	it("AcceptOwnProposal refuses assign_task and start_task on a Task the caller proposed, and passes another Agent's", async () => {
		forbid("pia", ["AcceptOwnProposal"]);
		const mabels = task([], { by: self("mabel") });

		expect(
			verdict("pia", "assign_task", { task_id: mabels, assignee: id("rin") }),
		).toBeUndefined();
		expect(
			await call("mabel", "assign_task", {
				task_id: mabels,
				assignee: id("rin"),
			}),
		).toEqual({
			tag: "Refused",
			text: `assign_task refused: A-mabel's Charter forbids AcceptOwnProposal: A-mabel proposed ${mabels}`,
		});
		expect(lastEvent()).toMatchObject({
			kind: "ActionRefused",
			actor: { tag: "Conductor" },
			task_id: mabels,
			payload: {
				agent: "A-mabel",
				tool: "assign_task",
				action: "AcceptOwnProposal",
				task_id: mabels,
			},
		});
	});

	it("AssignLabWork refuses propose_task and assign_task for a workflow stage, and passes work that is no stage's", async () => {
		const form = artifact("SubmissionForm");
		const other = artifact("Other");
		const stageTask = task([form]);

		expect(
			verdict("mabel", "propose_task", {
				title: "Plan",
				goal: "",
				tat_class: "Regular",
				priority: 1,
				inputs: [other],
			}),
		).toBeUndefined();
		expect(
			verdict("mabel", "assign_task", {
				task_id: task([other]),
				assignee: id("rin"),
			}),
		).toBeUndefined();
		expect(
			verdict("mabel", "propose_task", {
				title: "Parse",
				goal: "",
				tat_class: "Regular",
				priority: 1,
				inputs: [form],
			}),
		).toEqual({
			action: "AssignLabWork",
			reason:
				"A-mabel's Charter forbids AssignLabWork: propose_task gives out stage 1 Submission's work",
		});
		expect(
			(
				await call("mabel", "assign_task", {
					task_id: stageTask,
					assignee: id("rin"),
				})
			).text,
		).toBe(
			"assign_task refused: A-mabel's Charter forbids AssignLabWork: assign_task gives out stage 1 Submission's work",
		);
	});

	it("DoLabWork refuses run_script of a stage Script and complete_task on a stage Task, and passes other work", async () => {
		const form = artifact("SubmissionForm");
		const lab = task([form], { to: "thorne" });
		const audit = task([], { to: "thorne" });
		start(s.ledger, { actor: self("thorne"), task_id: lab });
		start(s.ledger, { actor: self("thorne"), task_id: audit });

		expect(
			verdict("thorne", "complete_task", { task_id: audit }),
		).toBeUndefined();
		expect(
			verdict("thorne", "run_script", {
				script: "S-lineage_check",
				inputs: [form],
			}),
		).toBeUndefined();
		expect(
			verdict("thorne", "run_script", {
				script: "S-parse_submission",
				inputs: [form],
				task_id: lab,
			}),
		).toEqual({
			action: "DoLabWork",
			reason:
				"A-thorne's Charter forbids DoLabWork: run_script works stage 1 Submission",
		});
		expect((await call("thorne", "complete_task", { task_id: lab })).text).toBe(
			"complete_task refused: A-thorne's Charter forbids DoLabWork: complete_task works stage 1 Submission",
		);
	});

	it("TouchResults refuses stages 4 to 6 and passes stages 1 to 3", async () => {
		const intake = task([artifact("SubmissionForm")], { to: "pia" });
		const results = task([artifact("WorkOrder")], { to: "pia" });
		start(s.ledger, { actor: self("pia"), task_id: intake });
		start(s.ledger, { actor: self("pia"), task_id: results });

		expect(
			verdict("pia", "complete_task", { task_id: intake }),
		).toBeUndefined();
		expect(
			verdict("pia", "run_script", { script: "S-log_receipt", inputs: [] }),
		).toBeUndefined();
		expect(
			verdict("pia", "run_script", { script: "S-render_roa", inputs: [] }),
		).toEqual({
			action: "TouchResults",
			reason:
				"A-pia's Charter forbids TouchResults: run_script works stage 6 Report",
		});
		expect(
			(await call("pia", "complete_task", { task_id: results })).text,
		).toBe(
			"complete_task refused: A-pia's Charter forbids TouchResults: complete_task works stage 4 Results",
		);
	});

	it("VerifyOwnTeamRun refuses run_script of stage 5 on a Result Worksheet from the caller's team, and passes an Agent off that team", async () => {
		forbid("thorne", ["VerifyOwnTeamRun"]);
		const results = task([artifact("WorkOrder")], { to: "rin" });
		start(s.ledger, { actor: self("rin"), task_id: results });
		const script = s.ledger.projections.scripts.scripts.values().next()
			.value?.[0];
		if (script === undefined)
			throw new Error("the scenario registers a Script");
		const ref = { id: script.id, version: script.version };
		const { run_id } = startRun(s.ledger, {
			actor: self("rin"),
			task_id: results,
			script: ref,
			inputs: [],
		});
		const worksheet = artifact("ResultWorksheet", { tag: "Run", id: run_id });
		finishRun(s.ledger, {
			actor: self("rin"),
			run: {
				id: run_id,
				script: ref,
				inputs: [],
				outputs: [worksheet],
				exit_code: 0,
				stdout_ref: worksheet,
				stderr_ref: worksheet,
				duration_ms: 1,
			},
		});
		const verify = { script: "S-verify_results", inputs: [worksheet] };

		expect(verdict("thorne", "run_script", verify)).toBeUndefined();
		expect(
			verdict("anselm", "run_script", {
				script: "S-compute_results",
				inputs: [worksheet],
			}),
		).toBeUndefined();
		expect((await call("anselm", "run_script", verify)).text).toBe(
			`run_script refused: A-anselm's Charter forbids VerifyOwnTeamRun: run_script verifies Artifact ${worksheet} of ${run_id} on ${results}, worked by A-rin of A-anselm's team`,
		);
		forbid("bram", ["VerifyOwnTeamRun"]);
		expect(
			verdict("bram", "run_script", verify)?.action,
			"Bram and Rin report to the same Supervisors",
		).toBe("VerifyOwnTeamRun");
	});
});

describe("flat Mood", () => {
	it("accepts start_task from an Agent whose fatigue the Mood table, not in force, reads as overloaded", async () => {
		const energyBudgetTokens = 800_000;
		const t1 = task([], { to: "rin" });
		const { turn } = startTurn(s.ledger, {
			agent: id("rin"),
			model: "claude-sonnet-5-5",
			energyBudgetTokens,
		});
		finishTurn(s.ledger, {
			turn_id: turn.started.turn_id,
			usage: {
				input_tokens: 90_000,
				output_tokens: 0,
				cache_creation_tokens: 0,
				cache_read_tokens: 0,
				cost_usd: 0,
			},
			outcome: { tag: "Completed" },
			tool_calls: 3,
		});
		const { vitality } = sample(s.ledger, {
			actor: operator,
			agent: id("rin"),
			now: s.now(),
			energyBudgetTokens,
		});
		expect(vitality.fatigue, "90,000 tokens of a 100,000 share").toBe(0.9);
		startTurn(s.ledger, {
			agent: id("rin"),
			model: "claude-sonnet-5-5",
			energyBudgetTokens,
		});

		expect(await call("rin", "start_task", { task_id: t1 })).toMatchObject({
			tag: "Done",
		});
		expect(lastEvent()).toMatchObject({
			kind: "TaskStarted",
			payload: { task_id: t1 },
		});
		expect(s.events().filter((e) => e.kind === "ActionRefused")).toEqual([]);
		expect(s.ledger.verify().ok).toBe(true);
	});

	it("accepts a call from a resting Agent when its Charter allows the Action", async () => {
		s.ledger.append({
			actor: self("mabel"),
			kind: "RestOrdered",
			payload: { agent_id: id("ines"), action: "begin", reason: "Long week" },
		});

		expect(verdict("ines", "read_tasks", {})).toBeUndefined();
		expect(await call("ines", "read_tasks", {})).toMatchObject({
			tag: "Done",
		});
		expect(s.events().filter((e) => e.kind === "ActionRefused")).toEqual([]);
	});
});

describe("the Charter's Actions", () => {
	it("refuses a resting Agent's call for the Action its Charter forbids, as any Agent's", () => {
		s.ledger.append({
			actor: self("mabel"),
			kind: "RestOrdered",
			payload: { agent_id: id("odile"), action: "begin", reason: "Rest" },
		});

		expect(
			verdict("odile", "read_artifact", { artifact_id: "a".repeat(64) })
				?.action,
		).toBe("TouchArtifact");
	});

	it("refuses, at the seed, a definition that forbids anything but an Action, naming it", () => {
		const ledger = openMemoryLedger();
		const [odile] = rosterDefinitions();
		if (odile === undefined) throw new Error("the roster is empty");

		expect(() =>
			seedOrg(ledger, [
				{
					...odile,
					charter: {
						...odile.charter,
						forbidden: ["RunScript", "Run Scripts"],
					},
				},
			]),
		).toThrow(
			`AgentRecruited refused: A-odile's Charter forbids "Run Scripts", which is not an Action; the Actions are ${Action.options.join(", ")}`,
		);
		expect(ledger.all()).toEqual([]);
		ledger.close();
	});
});

describe("a Ledger seeded before the Action vocabulary", () => {
	/** The roster as a seed before this vocabulary recorded it: the overview's phrases. */
	const legacyLedger = () => {
		const phrases = new Map(
			Object.entries(ACTION_OF_ROSTER_TEXT).map(([text, action]) => [
				action,
				text,
			]),
		);
		const storage = memoryStorage();
		forge(
			storage,
			rosterDefinitions().map((definition) => ({
				actor: operator,
				kind: "AgentRecruited",
				payload: {
					...definition,
					charter: {
						...definition.charter,
						forbidden: definition.charter.forbidden.map(
							(a) => phrases.get(a as Action) ?? a,
						),
					},
				},
			})),
		);
		return openMemoryLedger({ storage });
	};

	it("still opens, keeps the phrases, and its Charters still forbid their Actions", async () => {
		const ledger = legacyLedger();
		const odile = ledger.projections.org.agents.get(id("odile"))?.definition;

		expect(odile?.charter.forbidden).toEqual([
			"Run Scripts",
			"Touch Artifacts directly",
			"Decide Gates",
		]);
		expect(
			await callTool(
				toolContext({ ledger, home: "/nonexistent", agent: id("odile") }),
				"run_script",
				{
					script: "S-parse_submission",
					inputs: [],
				},
			),
		).toEqual({
			tag: "Refused",
			text: "run_script refused: A-odile's Charter forbids RunScript: run_script performs it",
		});
		ledger.close();
	});

	it("lets a Revision carry the phrases over, and refuses one that adds a phrase", () => {
		const ledger = legacyLedger();
		const odile = ledger.projections.org.agents.get(id("odile"))?.definition;
		if (odile === undefined) throw new Error("Odile is forged");
		const next = (forbidden: string[]) => ({
			...odile,
			version: 2,
			capacity: 4,
			charter: { ...odile.charter, forbidden },
			revision_reason: "Capacity",
		});

		expect(() =>
			revise(ledger, {
				actor: operator,
				definition: next([...odile.charter.forbidden, "Fly drones"]),
			}),
		).toThrow(
			`AgentDefinitionRevised refused: A-odile's Charter forbids "Fly drones", which is not an Action`,
		);
		expect(
			revise(ledger, {
				actor: operator,
				definition: next(odile.charter.forbidden),
			}).agent.definition.capacity,
		).toBe(4);
		ledger.close();
	});
});
