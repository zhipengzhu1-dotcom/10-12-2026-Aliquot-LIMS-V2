import { join } from "node:path";
import {
	AgentId,
	type ArtifactId,
	RoomId,
	type Seq,
	type Sha256,
} from "../ids.js";
import { say } from "../room/lifecycle.js";
import type { Message } from "../room/projection.js";
import { scriptsRoot } from "../sandbox/image.js";
import { registerScript } from "../sandbox/scripts.js";
import { openScheduler, type Said } from "../scheduler/scheduler.js";
import {
	messageArtifactId,
	PARSE_MESSAGE,
	PARSE_RESULTS_MESSAGE,
} from "../tools/message.js";
import type { ModelRequest, RunModel, ScriptedModel } from "../turn/model.js";
import { NO_USAGE, scriptedModel } from "../turn/model.js";
import type { Task } from "../types/task.js";
import { STAGES, type Stage } from "../workflow/stages.js";
import { ensureScript } from "../workflow/tracer.js";
import { TEST_OPERATOR } from "./operator.js";
import type { Scenario } from "./scenario.js";

/**
 * The Lab Room flow on the scripted model: the Agents' models that read their
 * prompts the way a model would, and the Scheduler that gives them Turns.
 */

export const T0 = "2026-10-13T09:30:00.000Z";
const TICK_MS = 15_000;
export const LAB = RoomId.parse("RM-lab");
export const ODILE = AgentId.parse("A-odile");
export const OPERATOR = { tag: "Operator" } as const;

const stage = (n: number): Stage => {
	const found = STAGES[n - 1];
	if (found === undefined) throw new Error(`the stage table has no stage ${n}`);
	return found;
};
export const RECEIPT = stage(2);
export const WORK_ORDER = stage(3);
export const RESULTS = stage(4);
export const VERIFICATION = stage(5);
export const REPORT = stage(6);

export const REPORT_TO = {
	company: "Acme Nutrition",
	contact: "Dana Reyes",
	address: "12 Harbor Road",
	city: "Portland, OR 97201",
} as const;
export const PRODUCT_TYPE = "60 ct HDPE bottle";
/** A receipt that states every value the Report of Analysis is rendered from. */
export const READABLE = `Received 3 bottles of Vitamin C 500 mg capsules, Lot 2403A, Product Code VC500, Product Type ${PRODUCT_TYPE}, finished product, from Acme Nutrition, regular TAT. Report to: ${REPORT_TO.company}; Contact: ${REPORT_TO.contact}; Address: ${REPORT_TO.address}; City: ${REPORT_TO.city}`;

export const scripted = (calls: ScriptedModel["calls"]): RunModel =>
	scriptedModel({
		calls,
		usage_per_round: { ...NO_USAGE, input_tokens: 100 },
		stop: { tag: "Completed" },
	});

/**
 * The Director's judgement, scripted: on the Turn whose prompt lists the
 * Operator's Message by its Artifact id, it makes `calls`; on any other
 * Turn, none.
 */
export const director =
	(message: Message, calls: ScriptedModel["calls"]): RunModel =>
	(request: ModelRequest) =>
		scripted(
			request.prompt.work.includes(
				`- seq ${message.seq}, Artifact ${messageArtifactId(message)}: ${message.body}`,
			)
				? calls
				: [],
		)(request);

export type ReadArtifact = {
	readonly artifact: {
		readonly id: ArtifactId;
		readonly artifact_type: string;
		readonly filename?: string;
	};
	readonly text?: string;
};

type Call = ModelRequest["call"];

/** Call a Tool and parse its result, failing the Turn on a refusal. */
export const json = (call: Call) => async (tool: string, input: object) => {
	const outcome = await call(tool, input);
	if (outcome.tag !== "Done") throw new Error(`${tool}: ${outcome.text}`);
	return JSON.parse(outcome.text);
};

/** The latest Artifact of a type in the Ledger, as `list_artifacts` lists it. */
export const latest = async (
	tool: ReturnType<typeof json>,
	artifact_type: string,
): Promise<ArtifactId | undefined> =>
	(
		(await tool("list_artifacts", { artifact_type })) as { id: ArtifactId }[]
	).at(-1)?.id;

/** Every Artifact a Run wrote, read back. */
export const written = (
	call: Call,
	run: { outputs: ArtifactId[] },
): Promise<ReadArtifact[]> =>
	Promise.all(
		run.outputs.map((artifact_id) =>
			json(call)("read_artifact", { artifact_id }),
		),
	);

export const named = (artifacts: readonly ReadArtifact[], filename: string) => {
	const found = artifacts.find((a) => a.artifact.filename === filename);
	if (found === undefined) throw new Error(`no ${filename}`);
	return found;
};

/** The reviewer the prompt's Task line names, as a model reads it. */
export const reviewerNamed = (work: string, task_id: string) =>
	new RegExp(
		`- ${task_id} [\\s\\S]*?naming a reviewer, such as (A-[a-z]+)`,
	).exec(work)?.[1];

export const DONE = {
	outcome: { tag: "Completed" as const },
	usage: NO_USAGE,
};

/**
 * Stage 2's Specialist, scripted the way a model reads its prompt: a Task
 * whose input is a Message not stored yet is stored, parsed, logged on the
 * latest toy LIMS database when its goal names one, and given a Work
 * Order, then completed naming the reviewer the prompt names, and answered
 * in RM-lab with each Lab Reference and the due date.
 */
export const receivingSpecialist: RunModel = async ({ prompt, call }) => {
	const task =
		/- (T-\d+) (.*)\n {2}Inputs: [0-9a-f]{64} \(the Operator's Message seq (\d+) in RM-lab, not stored yet/.exec(
			prompt.work,
		);
	if (task === null) return DONE;
	const [, task_id = "", goal = "", seq] = task;
	const tool = json(call);

	await tool("start_task", { task_id });
	const { artifact: stored } = await tool("store_message", {
		seq: Number(seq),
	});
	const parsed = await tool("run_script", {
		script: `S-${PARSE_MESSAGE}`,
		inputs: [stored.id],
		task_id,
	});
	const record = named(
		await written(call, parsed.run),
		"submission_record.json",
	);
	const carried = goal.includes("the latest toy LIMS database")
		? await Promise.all(RECEIPT.carried.map((type) => latest(tool, type)))
		: [];
	const receipt = await tool("run_script", {
		script: `S-${RECEIPT.script}`,
		inputs: [record.artifact.id, ...carried.filter((id) => id !== undefined)],
		task_id,
	});
	const logged = await written(call, receipt.run);
	const rows = JSON.parse(named(logged, "receipt.json").text ?? "{}").rows as
		| string[][]
		| undefined;
	const workOrder = await tool("run_script", {
		script: `S-${WORK_ORDER.script}`,
		inputs: [
			named(logged, "receiving_log_row.xlsx").artifact.id,
			named(logged, "lims.sqlite").artifact.id,
		],
		task_id,
	});
	const ordered = await written(call, workOrder.run);
	const header = JSON.parse(named(ordered, "work_order.json").text ?? "{}")
		.header as Record<string, string>;
	await tool("complete_task", {
		task_id,
		outputs: [
			named(logged, "receiving_log_row.xlsx").artifact.id,
			named(ordered, "work_order.xlsx").artifact.id,
		],
		reviewer: reviewerNamed(prompt.work, task_id),
	});
	await tool("send_message", {
		room_id: LAB,
		reply_to: Number(seq),
		body: `Logged ${(rows ?? []).map((row) => row[0]).join(", ")} on ${header["Work Order"]}, due ${header["Due Date"]}.`,
	});
	return DONE;
};

/**
 * A Supervisor, scripted: no prompt section lists the Tasks it must review
 * (the Scheduler's reviewer gap), so on any Turn it reads the Tasks UnderReview to
 * it, records a Review of each and completes it.
 */
export const reviewer =
	(self: AgentId): RunModel =>
	async ({ call }) => {
		const tool = json(call);
		const waiting = (await tool("read_tasks", {
			state: "UnderReview",
		})) as Task[];
		for (const task of waiting) {
			const { state } = task;
			if (state.tag !== "UnderReview") continue;
			if (state.reviewer.tag !== "Agent" || state.reviewer.id !== self) {
				continue;
			}
			await tool("review_task", {
				task_id: task.id,
				quality: 3,
				traceability: 3,
				boundary_adherence: 3,
				collaboration: 3,
				timeliness: 3,
				note: "Checked against the Evaluation",
			});
			await tool("complete_task", { task_id: task.id });
		}
		return DONE;
	};

/**
 * Register the Scripts the Lab Room flow runs that `workflow run` does not:
 * `parse_message` and `parse_results_message`, then stages 2 to 6 as
 * `workflow run` registers them.
 */
export const registerLabRoomScripts = (
	s: Scenario,
	home: string,
	image: Sha256,
) => {
	const parsers = [
		[PARSE_MESSAGE, RECEIPT.worked_by, ["Other"], ["SubmissionRecord"]],
		[
			PARSE_RESULTS_MESSAGE,
			RESULTS.worked_by,
			["Other", "WorkOrder"],
			["Other"],
		],
	] as const;
	for (const [name, owner_agent, input_types, output_types] of parsers) {
		registerScript({
			ledger: s.ledger,
			home,
			actor: OPERATOR,
			name,
			scriptDir: join(scriptsRoot, name),
			owner_agent,
			input_types: [...input_types],
			output_types: [...output_types],
			image_digest: image,
		});
	}
	for (const stage of STAGES.slice(1)) {
		ensureScript({
			ledger: s.ledger,
			home,
			stage,
			source: join(scriptsRoot, stage.script),
			image,
			operator: TEST_OPERATOR,
		});
	}
};

/**
 * Tick the Scheduler with its landed defaults on the scenario's clock, one
 * Tick every 15 s from `from`, until `until` holds or `ticks` Ticks have
 * run.
 */
export const runScheduler = async (
	s: Scenario,
	home: string,
	modelFor: (agent: AgentId) => RunModel,
	until: () => boolean,
	{ from = T0, ticks = 30 }: { from?: string; ticks?: number } = {},
): Promise<Said[]> => {
	const scheduler = openScheduler(s.ledger, {
		home,
		options: {
			tickMs: TICK_MS,
			dutyMs: 30 * 60_000,
			concurrency: 2,
			energyBudgetTokens: 1_000_000,
		},
		maxTurns: 20,
		login: { tag: "Subscription" },
		modelFor,
		say: () => {},
	});
	const said: Said[] = [];
	for (let tick = 0; tick < ticks && !until(); tick++) {
		s.at(new Date(Date.parse(from) + tick * TICK_MS).toISOString());
		said.push(...scheduler.tick().decisions);
		await scheduler.settled();
	}
	return said;
};

/**
 * The Director's judgement on a receipt, scripted the way a model reads its
 * prompt: on the Turn whose prompt lists `message`, it proposes a Task on
 * it with the goal its work section gives for received Samples, and
 * assigns it to the Agent that section names.
 */
const receivingDirector =
	(message: Message): RunModel =>
	async ({ prompt, call }) => {
		const listed = `- seq ${message.seq}, Artifact ${messageArtifactId(message)}: ${message.body}`;
		if (!prompt.work.includes(listed)) return DONE;
		const told =
			/reports received Samples is work\. .*? with the goal: (.*?)\. Then assign it to (A-[a-z]+), who works stage 2\./.exec(
				prompt.work,
			);
		if (told === null) throw new Error("no receiving work in the prompt");
		const [, goal, assignee] = told;
		const tool = json(call);
		const { task } = await tool("propose_task", {
			title: "Receive Lot 2403A from the Lab Room",
			goal,
			tat_class: "Regular",
			priority: 1,
			inputs: [messageArtifactId(message)],
		});
		await tool("assign_task", { task_id: task.id, assignee });
		return DONE;
	};

/**
 * The Operator reports `READABLE` in RM-lab, the Director proposes a Task
 * on it and assigns it to stage 2's Specialist, who enters the Samples in
 * the Receiving Log and opens the Work Order; the Scheduler runs until the
 * Specialist replies.
 */
export const receive = async (
	s: Scenario,
	home: string,
	others: (agent: AgentId) => RunModel = () => scripted([]),
): Promise<Message> => {
	const message = say(s.ledger, {
		actor: OPERATOR,
		room_id: LAB,
		body: READABLE,
	});
	const odile = receivingDirector(message);
	await runScheduler(
		s,
		home,
		(agent) =>
			agent === ODILE
				? odile
				: agent === RECEIPT.worked_by
					? receivingSpecialist
					: others(agent),
		() => replyTo(s, message.seq) !== undefined,
	);
	return message;
};

/** An Agent's Message in reply to the one at `seq`. */
export const replyTo = (s: Scenario, seq: Seq) =>
	s
		.events()
		.find(
			(e) =>
				e.kind === "MessageSent" &&
				e.causation_id === seq &&
				e.actor.tag === "Agent",
		);
