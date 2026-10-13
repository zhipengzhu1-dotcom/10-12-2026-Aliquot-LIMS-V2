import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { decideGate } from "../gate/lifecycle.js";
import { gateState } from "../gate/projection.js";
import { AgentId, type ArtifactId, GateId, type Sha256 } from "../ids.js";
import { say } from "../room/lifecycle.js";
import { seedRooms } from "../room/seed.js";
import { openArtifacts } from "../sandbox/artifacts.js";
import { buildImage } from "../sandbox/image.js";
import { serve } from "../serve/http.js";
import { dockerAvailable, requireDocker } from "../test-support/docker.js";
import {
	DONE,
	director,
	json,
	LAB,
	named,
	ODILE,
	OPERATOR,
	REPORT,
	RESULTS,
	type ReadArtifact,
	receive,
	registerLabRoomScripts,
	replyTo,
	reviewer,
	reviewerNamed,
	runScheduler,
	scripted,
	T0,
	VERIFICATION,
	written,
} from "../test-support/lab-room.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import type { RunModel } from "../turn/model.js";
import { pdfText } from "../workflow/evaluate.js";
import { messageArtifactId, PARSE_RESULTS_MESSAGE } from "./message.js";

// Each build gives its tag a new image id, so this process's tag is its own.
const IMAGE = `aliquot-sandbox:results-${process.pid}`;
const RESULTS_MESSAGE =
	"Lab Ref 26-0412, notebook NB-07 p.31. Container 1: 10.246 g for 20 capsules, 10.246 g taken. Container 2: 10.198 g for 20 capsules, 10.198 g taken. Container 3: 10.302 g for 20 capsules, 10.302 g taken.";
const UNREADABLE = "Results are in for Acme";
const PIA = AgentId.parse("A-pia");
const ANSELM = AgentId.parse("A-anselm");

let s: Scenario;
let home: string;
beforeEach(() => {
	s = scenario(T0);
	seedRooms(s.ledger);
	home = mkdtempSync(join(tmpdir(), "aliquot-results-"));
});
afterEach(() => {
	s.close();
	rmSync(home, { recursive: true, force: true });
});

/**
 * One Task the prompt lists as Assigned to the Agent: its lines as a model
 * reads them, and the input ids its Inputs line names.
 */
type Listed = {
	readonly id: string;
	readonly line: string;
	readonly inputs: readonly ArtifactId[];
};

/** The Tasks under "Assigned:" in the prompt's Your Tasks section. */
const assigned = (work: string): Listed[] => {
	const block = /\nAssigned:\n([\s\S]*?)(?:\n\n|$)/.exec(work)?.[1] ?? "";
	return block.split(/\n(?=- T-\d)/).flatMap((line) => {
		const head = /^- (T-\d+) [^\n]*\n {2}Inputs: ([^\n]*)/.exec(line);
		if (head === null) return [];
		const [, id = "", inputs = ""] = head;
		const ids = [...inputs.matchAll(/[0-9a-f]{64}/g)].map(
			([found]) => found as ArtifactId,
		);
		return [{ id, line, inputs: ids }];
	});
};

/** The text a Task's goal gives for the next stage's Task, and who works it. */
const handedOn = (goal: string, stage: number) => {
	const found = new RegExp(
		`propose a Task titled "Stage ${stage} ([^:]+): <the Work Order>" whose inputs are .*?, with the goal "(.*)", and assign it to (A-[a-z]+), who works stage ${stage}`,
	).exec(goal);
	if (found === null) throw new Error(`the goal hands on no stage ${stage}`);
	const [, name = "", next = "", worker = ""] = found;
	return { name, next, worker: AgentId.parse(worker) };
};

const latest = async (tool: ReturnType<typeof json>, artifact_type: string) =>
	(
		(await tool("list_artifacts", { artifact_type })) as { id: ArtifactId }[]
	).at(-1)?.id;

/**
 * The Director's judgement on a results Message, scripted the way a model
 * reads its prompt: the goal and the assignee are the ones its work
 * section gives for a results Message.
 */
const resultsDirector = (message: ReturnType<typeof say>): RunModel => {
	return async (request) => {
		const work = request.prompt.work;
		const told =
			/reports results is work too\. .*? with the goal: (.*?)\. Then assign it to (A-[a-z]+), who works stage 4\./.exec(
				work,
			);
		if (told === null) throw new Error("no results work in the prompt");
		const [, goal, assignee] = told;
		return director(message, [
			{
				tool: "propose_task",
				input: {
					title: "Results for Lab Ref 26-0412",
					goal,
					tat_class: "Regular",
					priority: 1,
					inputs: [messageArtifactId(message)],
				},
			},
			{ tool: "assign_task", input: { task_id: "T-2", assignee } },
		])(request);
	};
};

/**
 * The Specialist who works stage 4, scripted the way a model reads its
 * prompt: an assigned Task whose goal names S-parse_results_message on a
 * Message not stored yet is stored, read with the Work Order into the
 * weighings, worked through stage 4, handed on to stage 5 as the goal
 * says, and completed naming the reviewer the prompt names.
 */
const resultsSpecialist: RunModel = async ({ prompt, call }) => {
	const task = assigned(prompt.work).find((t) =>
		t.line.includes(`S-${PARSE_RESULTS_MESSAGE}`),
	);
	const seq =
		task && /Message seq (\d+) in RM-lab, not stored yet/.exec(task.line)?.[1];
	if (task === undefined || seq === undefined) return DONE;
	const tool = json(call);
	const task_id = task.id;

	await tool("start_task", { task_id });
	const { artifact: message } = await tool("store_message", {
		seq: Number(seq),
	});
	const workOrder = await latest(tool, "WorkOrder");
	const parsed = await tool("run_script", {
		script: `S-${PARSE_RESULTS_MESSAGE}`,
		inputs: [message.id, workOrder],
		task_id,
	});
	const [weighings] = (await written(call, parsed.run)) as ReadArtifact[];
	const computed = await tool("run_script", {
		script: `S-${RESULTS.script}`,
		inputs: [
			workOrder,
			weighings?.artifact.id,
			await latest(tool, "LimsDatabase"),
		],
		task_id,
	});
	const sheet = named(
		await written(call, computed.run),
		"result_worksheet.xlsx",
	);
	const verify = handedOn(task.line, VERIFICATION.number);
	const { task: next } = await tool("propose_task", {
		title: `Stage ${VERIFICATION.number} ${verify.name}: WO-2026-0001`,
		goal: verify.next,
		tat_class: "Regular",
		priority: 1,
		inputs: [sheet.artifact.id, weighings?.artifact.id],
	});
	await tool("assign_task", { task_id: next.id, assignee: verify.worker });
	await tool("complete_task", {
		task_id,
		outputs: [sheet.artifact.id],
		reviewer: reviewerNamed(prompt.work, task_id),
	});
	return DONE;
};

/** Stage 5's Specialist: runs the stage's Script on the Task's inputs and hands on to stage 6 as the goal says. */
const verifier: RunModel = async ({ prompt, call }) => {
	const task = assigned(prompt.work).find((t) =>
		t.line.startsWith(`- ${t.id} Stage ${VERIFICATION.number} `),
	);
	if (task === undefined) return DONE;
	const tool = json(call);
	const task_id = task.id;
	const weighings = task.inputs[1];

	await tool("start_task", { task_id });
	const verified = await tool("run_script", {
		script: `S-${VERIFICATION.script}`,
		inputs: task.inputs,
		task_id,
	});
	const [record] = (await written(call, verified.run)) as ReadArtifact[];
	const report = handedOn(task.line, REPORT.number);
	const { task: next } = await tool("propose_task", {
		title: `Stage ${REPORT.number} ${report.name}: WO-2026-0001`,
		goal: report.next,
		tat_class: "Regular",
		priority: 1,
		inputs: [
			record?.artifact.id,
			await latest(tool, "ReceivingLogRow"),
			weighings,
			await latest(tool, "LimsDatabase"),
		],
	});
	await tool("assign_task", { task_id: next.id, assignee: report.worker });
	await tool("complete_task", {
		task_id,
		outputs: [record?.artifact.id],
		reviewer: reviewerNamed(prompt.work, task_id),
	});
	return DONE;
};

/**
 * Stage 6's Specialist: renders the report, completes the Task, then does
 * what its Task line says: requests the ExternalMessage Gate and answers
 * the Message it names.
 */
const reporter: RunModel = async ({ prompt, call }) => {
	const task = assigned(prompt.work).find((t) =>
		t.line.includes("request an ExternalMessage Gate"),
	);
	const seq =
		task &&
		/reply to the Operator's Message seq (\d+) in RM-lab/.exec(task.line)?.[1];
	if (task === undefined || seq === undefined) return DONE;
	const tool = json(call);
	const task_id = task.id;

	await tool("start_task", { task_id });
	const rendered = await tool("run_script", {
		script: `S-${REPORT.script}`,
		inputs: task.inputs,
		task_id,
	});
	const outputs = await written(call, rendered.run);
	const pdf = named(outputs, "report_of_analysis.pdf").artifact.id;
	const xlsx = named(outputs, "report_of_analysis.xlsx").artifact.id;
	const sheet = JSON.parse(
		named(outputs, "report_of_analysis.json").text ?? "{}",
	).sheet as unknown[][];
	const lab_reference = sheet.find((row) => row[0] === "Lab Reference")?.[1];
	await tool("complete_task", {
		task_id,
		outputs: [pdf, xlsx],
		reviewer: reviewerNamed(prompt.work, task_id),
	});
	const { gate } = await tool("request_gate", {
		kind: "ExternalMessage",
		payload: { artifact_id: pdf, lab_reference },
	});
	await tool("send_message", {
		room_id: LAB,
		reply_to: Number(seq),
		body: `The Report of Analysis of ${lab_reference} waits on ${gate.id}: PDF ${pdf}, xlsx ${xlsx}.`,
	});
	return DONE;
};

describe("results from chat, the Director's judgement on an unreadable results Message", () => {
	it("gets the Director's reply in RM-lab asking for the Lab Reference, the notebook reference and the weighings, and no Task", async () => {
		const message = say(s.ledger, {
			actor: OPERATOR,
			room_id: LAB,
			body: UNREADABLE,
		});
		const odile: RunModel = (request) => {
			const asked =
				/asking for (the Lab Reference, the notebook reference and the weighings) it lacks/.exec(
					request.prompt.work,
				)?.[1];
			return director(message, [
				{
					tool: "send_message",
					input: {
						room_id: LAB,
						reply_to: message.seq,
						body: `I cannot record these results yet: please give ${asked}.`,
					},
				},
			])(request);
		};

		await runScheduler(
			s,
			home,
			(agent) => (agent === ODILE ? odile : scripted([])),
			() => replyTo(s, message.seq) !== undefined,
		);

		expect(replyTo(s, message.seq)).toMatchObject({
			actor: { tag: "Agent", id: ODILE },
			payload: {
				room_id: LAB,
				body: "I cannot record these results yet: please give the Lab Reference, the notebook reference and the weighings.",
			},
		});
		expect(s.events().filter((e) => e.kind === "TaskProposed")).toEqual([]);
		expect(s.ledger.verify().ok).toBe(true);
	});
});

const suite = dockerAvailable
	? "results from chat (Docker)"
	: "results from chat: SKIPPED because `docker info` failed; start Docker to run these";

describe.skipIf(!requireDocker())(suite, () => {
	let image: Sha256;
	beforeAll(async () => {
		({ id: image } = await buildImage({ tag: IMAGE }));
	}, 600_000);
	afterAll(() => {
		spawnSync("docker", ["rmi", IMAGE], { stdio: "ignore" });
	});

	it("after receiving, works a results Message through the Director's Task, parse_results_message and stages 4 to 6 to an ExternalMessage Gate the Operator approves, every Task Done", async () => {
		registerLabRoomScripts(s, home, image);
		const supervisors = (agent: AgentId) =>
			agent === PIA || agent === ANSELM ? reviewer(agent) : scripted([]);
		await receive(s, home, supervisors);

		const message = say(s.ledger, {
			actor: OPERATOR,
			room_id: LAB,
			body: RESULTS_MESSAGE,
		});
		const models: ReadonlyMap<AgentId, RunModel> = new Map([
			[ODILE, resultsDirector(message)],
			[RESULTS.worked_by, resultsSpecialist],
			[VERIFICATION.worked_by, verifier],
			[REPORT.worked_by, reporter],
		]);
		const tasks = () => [...s.ledger.projections.tasks.tasks.values()];
		const gate = () =>
			s.ledger.projections.gates.gates.get(GateId.parse("G-1"));
		await runScheduler(
			s,
			home,
			(agent) => models.get(agent) ?? supervisors(agent),
			() =>
				replyTo(s, message.seq) !== undefined &&
				gate() !== undefined &&
				tasks().every((t) => t.state.tag === "Done"),
			{ from: s.now().toISOString(), ticks: 80 },
		);

		const id = messageArtifactId(message);
		const events = s.events();
		expect(
			events.find(
				(e) => e.kind === "TaskProposed" && e.payload.task_id === "T-2",
			),
			"the Director proposes the results Task on the Message",
		).toMatchObject({
			actor: { tag: "Agent", id: ODILE },
			payload: { inputs: [id] },
		});
		expect(
			events.find(
				(e) => e.kind === "TaskAssigned" && e.payload.task_id === "T-2",
			),
			"to the Specialist who works stage 4",
		).toMatchObject({
			actor: { tag: "Agent", id: ODILE },
			payload: { assignee: RESULTS.worked_by },
		});

		const finished = [...s.ledger.projections.runs.runs.values()].slice(3);
		const runs = finished.flatMap((r) =>
			r.finished === undefined ? [] : [r.finished.run],
		);
		expect(
			finished.map(
				(r) =>
					`${r.finished?.run.script.id} ${r.task_id} exit ${r.finished?.run.exit_code}`,
			),
		).toEqual([
			`S-${PARSE_RESULTS_MESSAGE} T-2 exit 0`,
			`S-${RESULTS.script} T-2 exit 0`,
			`S-${VERIFICATION.script} T-3 exit 0`,
			`S-${REPORT.script} T-4 exit 0`,
		]);
		const artifacts = openArtifacts({ ledger: s.ledger, home });
		const [parsed, computed, , rendered] = runs;
		const output = (run: typeof parsed, filename: string) => {
			const found = run?.outputs.find(
				(o) =>
					s.ledger.projections.artifacts.artifacts.get(o)?.filename ===
					filename,
			);
			if (found === undefined) throw new Error(`no ${filename}`);
			return found;
		};
		expect(
			JSON.parse(artifacts.read(output(parsed, "weighings.json")).toString()),
			"the weighings hold the three containers the Message gives",
		).toEqual(
			[10.246, 10.198, 10.302].map((weight, i) => ({
				container: i + 1,
				weight_of_20_g: weight,
				weight_taken_g: weight,
				notebook_reference: "NB-07 p.31",
			})),
		);
		const worksheet = JSON.parse(
			artifacts.read(output(computed, "result_worksheet.json")).toString(),
		);
		expect(worksheet.sheet[3].slice(0, 2), "the worksheet header").toEqual([
			"Notebook Reference",
			"NB-07 p.31",
		]);
		const pdf = output(rendered, "report_of_analysis.pdf");
		const xlsx = output(rendered, "report_of_analysis.xlsx");
		expect(pdfText(artifacts.read(pdf)).split("\n")).toContain("NB-07 p.31");

		expect(
			events
				.filter((e) => e.kind === "EvaluationRecorded")
				.map(
					(e) =>
						`stage ${e.payload.stage} ${e.payload.task_id} ${e.payload.passed}`,
				),
		).toEqual([
			"stage 2 T-1 true",
			"stage 3 T-1 true",
			"stage 4 T-2 true",
			"stage 5 T-3 true",
			"stage 6 T-4 true",
		]);
		expect(
			tasks().map((t) => `${t.id} ${t.state.tag}`),
			"every Task Done",
		).toEqual(["T-1 Done", "T-2 Done", "T-3 Done", "T-4 Done"]);
		expect(
			tasks().map((t) => ("assignee" in t.state ? t.state.assignee : "")),
		).toEqual([
			"A-bram",
			RESULTS.worked_by,
			VERIFICATION.worked_by,
			REPORT.worked_by,
		]);

		const opened = gate();
		expect(opened).toMatchObject({
			kind: "ExternalMessage",
			requester: { tag: "Agent", id: REPORT.worked_by },
			payload: { artifact_id: pdf, lab_reference: "LR-2026-0001" },
		});
		expect(opened && gateState(opened, s.now())).toBe("Open");
		expect(
			replyTo(s, message.seq),
			"the reply in RM-lab names the Gate",
		).toMatchObject({
			actor: { tag: "Agent", id: REPORT.worked_by },
			payload: {
				room_id: LAB,
				body: `The Report of Analysis of LR-2026-0001 waits on G-1: PDF ${pdf}, xlsx ${xlsx}.`,
			},
		});

		decideGate(s.ledger, {
			gate_id: GateId.parse("G-1"),
			payload_hash: opened?.payload_hash ?? ("" as Sha256),
			meaning: "approve",
			reason: "The report agrees with the notebook",
		});
		const serving = await serve(s.ledger, {
			port: 0,
			bind: "127.0.0.1",
			ui: ".",
		});
		try {
			const { gates } = (await (
				await fetch(`${serving.url}/api/gates`)
			).json()) as {
				gates: Record<string, { decision?: { meaning: string } }>;
			};
			expect(
				gates["G-1"]?.decision,
				"the Gates view's source shows G-1 approved",
			).toMatchObject({ meaning: "approve" });
		} finally {
			await serving.close();
		}
		expect(s.ledger.verify().ok).toBe(true);
	}, 400_000);
});
