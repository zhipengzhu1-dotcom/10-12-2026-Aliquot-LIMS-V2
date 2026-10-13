import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { AgentId, ArtifactId, RoomId, type Seq, type Sha256 } from "../ids.js";
import { say } from "../room/lifecycle.js";
import type { Message } from "../room/projection.js";
import { seedRooms } from "../room/seed.js";
import { openArtifacts } from "../sandbox/artifacts.js";
import { buildImage, scriptsRoot } from "../sandbox/image.js";
import { registerScript } from "../sandbox/scripts.js";
import { openScheduler, type Said } from "../scheduler/scheduler.js";
import { dockerAvailable, requireDocker } from "../test-support/docker.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import type { ModelRequest, RunModel, ScriptedModel } from "../turn/model.js";
import { NO_USAGE, scriptedModel } from "../turn/model.js";
import { STAGES } from "../workflow/stages.js";
import { ensureScript } from "../workflow/tracer.js";
import { messageArtifactId, PARSE_MESSAGE } from "./message.js";

// Each build gives its tag a new image id, so this process's tag is its own.
const IMAGE = `aliquot-sandbox:receiving-${process.pid}`;
const T0 = "2026-10-13T09:30:00.000Z";
const TICK_MS = 15_000;
const lab = RoomId.parse("RM-lab");
const odile = AgentId.parse("A-odile");
const operator = { tag: "Operator" } as const;
const [, RECEIPT, WORK_ORDER] = STAGES;
if (RECEIPT === undefined || WORK_ORDER === undefined) {
	throw new Error("the stage table has no stage 2 or 3");
}
const READABLE =
	"Received 3 bottles of Vitamin C 500 mg capsules, Lot 2403A, Product Code VC500, finished product, from Acme Nutrition, regular TAT";
const UNREADABLE = "Received some samples from Acme";
const ASKED =
	"I cannot log these yet: which product is it, and what are its Lot and Product Code?";

const scripted = (calls: ScriptedModel["calls"]): RunModel =>
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
const director =
	(message: Message, calls: ScriptedModel["calls"]): RunModel =>
	(request: ModelRequest) =>
		scripted(
			request.prompt.work.includes(
				`- seq ${message.seq}, Artifact ${messageArtifactId(message)}: ${message.body}`,
			)
				? calls
				: [],
		)(request);

type ReadArtifact = {
	readonly artifact: {
		readonly id: ArtifactId;
		readonly artifact_type: string;
		readonly filename?: string;
	};
	readonly text?: string;
};

/**
 * Stage 2's Specialist, scripted the way a model reads its prompt: a Task
 * whose input is a Message not stored yet is stored, parsed, logged and
 * given a Work Order, then completed naming the reviewer the prompt names,
 * and answered in RM-lab with each Lab Reference and the due date.
 */
const specialist: RunModel = async ({ prompt, call }) => {
	const done = { outcome: { tag: "Completed" as const }, usage: NO_USAGE };
	const task =
		/- (T-\d+) .*\n {2}Inputs: [0-9a-f]{64} \(the Operator's Message seq (\d+) in RM-lab, not stored yet/.exec(
			prompt.work,
		);
	if (task === null) return done;
	const [, task_id, seq] = task;
	const json = async (tool: string, input: object) => {
		const outcome = await call(tool, input);
		if (outcome.tag !== "Done") throw new Error(`${tool}: ${outcome.text}`);
		return JSON.parse(outcome.text);
	};
	const written = async (run: {
		outputs: ArtifactId[];
	}): Promise<ReadArtifact[]> =>
		Promise.all(
			run.outputs.map((artifact_id) => json("read_artifact", { artifact_id })),
		);
	const of = (artifacts: readonly ReadArtifact[], filename: string) => {
		const found = artifacts.find((a) => a.artifact.filename === filename);
		if (found === undefined) throw new Error(`no ${filename}`);
		return found;
	};

	await json("start_task", { task_id });
	const { artifact: stored } = await json("store_message", {
		seq: Number(seq),
	});
	const parsed = await json("run_script", {
		script: `S-${PARSE_MESSAGE}`,
		inputs: [stored.id],
		task_id,
	});
	const record = of(await written(parsed.run), "submission_record.json");
	const receipt = await json("run_script", {
		script: `S-${RECEIPT.script}`,
		inputs: [record.artifact.id],
		task_id,
	});
	const logged = await written(receipt.run);
	const rows = JSON.parse(of(logged, "receipt.json").text ?? "{}").rows as
		| string[][]
		| undefined;
	const workOrder = await json("run_script", {
		script: `S-${WORK_ORDER.script}`,
		inputs: [
			of(logged, "receiving_log_row.xlsx").artifact.id,
			of(logged, "lims.sqlite").artifact.id,
		],
		task_id,
	});
	const ordered = await written(workOrder.run);
	const header = JSON.parse(of(ordered, "work_order.json").text ?? "{}")
		.header as Record<string, string>;
	await json("complete_task", {
		task_id,
		outputs: [
			of(logged, "receiving_log_row.xlsx").artifact.id,
			of(ordered, "work_order.xlsx").artifact.id,
		],
		reviewer: /naming a reviewer, such as (A-[a-z]+)/.exec(prompt.work)?.[1],
	});
	await json("send_message", {
		room_id: lab,
		reply_to: Number(seq),
		body: `Logged ${(rows ?? []).map((row) => row[0]).join(", ")} on ${header["Work Order"]}, due ${header["Due Date"]}.`,
	});
	return done;
};

let s: Scenario;
let home: string;
beforeEach(() => {
	s = scenario(T0);
	seedRooms(s.ledger);
	home = mkdtempSync(join(tmpdir(), "aliquot-receiving-"));
});
afterEach(() => {
	s.close();
	rmSync(home, { recursive: true, force: true });
});

/**
 * Tick the Scheduler with its landed defaults on a set clock, one Tick
 * every 15 s, until `until` holds or 30 Ticks have run.
 */
const runScheduler = async (
	modelFor: (agent: AgentId) => RunModel,
	until: () => boolean,
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
	for (let tick = 0; tick < 30 && !until(); tick++) {
		s.at(new Date(Date.parse(T0) + tick * TICK_MS).toISOString());
		said.push(...scheduler.tick().decisions);
		await scheduler.settled();
	}
	return said;
};

const replyTo = (seq: Seq) =>
	s
		.events()
		.find(
			(e) =>
				e.kind === "MessageSent" &&
				e.causation_id === seq &&
				e.actor.tag === "Agent",
		);

describe("receiving from chat, the Director's judgement on an unreadable Message", () => {
	it("gets the Director's reply in RM-lab naming what is missing, and no Task", async () => {
		const message = say(s.ledger, {
			actor: operator,
			room_id: lab,
			body: UNREADABLE,
		});
		const odileModel = director(message, [
			{
				tool: "send_message",
				input: { room_id: lab, reply_to: message.seq, body: ASKED },
			},
		]);

		await runScheduler(
			(agent) => (agent === odile ? odileModel : scripted([])),
			() => replyTo(message.seq) !== undefined,
		);

		expect(replyTo(message.seq)).toMatchObject({
			actor: { tag: "Agent", id: odile },
			payload: { room_id: lab, body: ASKED },
		});
		expect(ASKED).toMatch(/product.*Lot.*Product Code/);
		expect(s.events().filter((e) => e.kind === "TaskProposed")).toEqual([]);
		expect(
			s.ledger.projections.artifacts.artifacts.has(messageArtifactId(message)),
			"the Message is not stored",
		).toBe(false);
		expect(s.ledger.verify().ok).toBe(true);
	});
});

const suite = dockerAvailable
	? "receiving from chat (Docker)"
	: "receiving from chat: SKIPPED because `docker info` failed; start Docker to run these";

describe.skipIf(!requireDocker())(suite, () => {
	let image: Sha256;
	beforeAll(async () => {
		({ id: image } = await buildImage({ tag: IMAGE }));
	}, 600_000);
	afterAll(() => {
		spawnSync("docker", ["rmi", IMAGE], { stdio: "ignore" });
	});

	it("logs the Samples a readable Message reports through the Director's Task, parse_message and stages 2 and 3, and the Specialist replies with each Lab Reference", async () => {
		registerScript({
			ledger: s.ledger,
			home,
			actor: operator,
			name: PARSE_MESSAGE,
			scriptDir: join(scriptsRoot, PARSE_MESSAGE),
			owner_agent: RECEIPT.worked_by,
			input_types: ["Other"],
			output_types: ["SubmissionRecord"],
			image_digest: image,
		});
		for (const stage of [RECEIPT, WORK_ORDER]) {
			ensureScript({
				ledger: s.ledger,
				home,
				stage,
				source: join(scriptsRoot, stage.script),
				image,
			});
		}
		const message = say(s.ledger, {
			actor: operator,
			room_id: lab,
			body: READABLE,
		});
		const id = messageArtifactId(message);
		const odileModel = director(message, [
			{
				tool: "propose_task",
				input: {
					title: "Receive Lot 2403A from the Lab Room",
					goal: "Store the Message, run S-parse_message on it, run stages 2 and 3, and reply with each Lab Reference and the due date",
					tat_class: "Regular",
					priority: 1,
					inputs: [id],
				},
			},
			{
				tool: "assign_task",
				input: { task_id: "T-1", assignee: RECEIPT.worked_by },
			},
		]);

		await runScheduler(
			(agent) =>
				agent === odile
					? odileModel
					: agent === RECEIPT.worked_by
						? specialist
						: scripted([]),
			() => replyTo(message.seq) !== undefined,
		);

		const events = s.events();
		expect(
			events.find((e) => e.kind === "TaskProposed"),
			"the Director proposes the Task on the Message",
		).toMatchObject({
			actor: { tag: "Agent", id: odile },
			payload: { inputs: [id] },
		});
		expect(
			events.find((e) => e.kind === "TaskAssigned"),
			"to the Specialist who works stage 2",
		).toMatchObject({
			actor: { tag: "Agent", id: odile },
			payload: { task_id: "T-1", assignee: RECEIPT.worked_by },
		});
		expect(
			events.find((e) => e.kind === "ArtifactStored" && e.payload.id === id),
			"the Specialist stores the Message as Other, caused by its MessageSent",
		).toMatchObject({
			actor: { tag: "Agent", id: RECEIPT.worked_by },
			causation_id: message.seq,
			payload: { artifact_type: "Other", lineage: [] },
		});

		const runs = [...s.ledger.projections.runs.runs.values()].flatMap((r) =>
			r.finished === undefined ? [] : [r.finished.run],
		);
		expect(runs.map((r) => `${r.script.id} exit ${r.exit_code}`)).toEqual([
			`S-${PARSE_MESSAGE} exit 0`,
			`S-${RECEIPT.script} exit 0`,
			`S-${WORK_ORDER.script} exit 0`,
		]);
		const artifacts = openArtifacts({ ledger: s.ledger, home });
		const [parsed, logged, ordered] = runs;
		const typed = (run: typeof parsed, type: string) =>
			run?.outputs.find((o) =>
				s.ledger.projections.artifacts.productions
					.get(o)
					?.some((p) => p.record.artifact_type === type),
			) ?? ArtifactId.parse("0".repeat(64));
		const record = JSON.parse(
			artifacts.read(typed(parsed, "SubmissionRecord")).toString(),
		);
		expect(record.submitted_by.company).toBe("Acme Nutrition");
		expect(record.sample).toMatchObject({
			sample_description: "Vitamin C 500 mg capsules",
			lot: "2403A",
			product_code: "VC500",
			no_of_containers: "3",
			sample_type: "FP",
			tat_code: "1",
			tat_class: "Regular",
		});
		expect(
			events
				.filter((e) => e.kind === "EvaluationRecorded")
				.map((e) => `stage ${e.payload.stage} ${e.payload.task_id}`),
		).toEqual([
			`stage ${RECEIPT.number} T-1`,
			`stage ${WORK_ORDER.number} T-1`,
		]);

		const before = typed(logged, "LimsDatabase");
		const next = typed(ordered, "LimsDatabase");
		expect(next, "stage 3 writes the next database version").not.toBe(before);
		const db = new DatabaseSync(artifacts.path(next), { readOnly: true });
		const samples = db
			.prepare(
				"SELECT lab_reference FROM samples WHERE lot = '2403A' ORDER BY lab_reference",
			)
			.all()
			.map((r) => String(r.lab_reference));
		const orders = db
			.prepare("SELECT DISTINCT work_order, due_date FROM work_orders")
			.all();
		db.close();
		expect(samples).toEqual(["LR-2026-0001", "LR-2026-0002", "LR-2026-0003"]);
		expect(orders).toHaveLength(1);
		const [{ work_order, due_date } = {}] = orders;

		expect(
			replyTo(message.seq),
			"the Specialist's reply in RM-lab",
		).toMatchObject({
			actor: { tag: "Agent", id: RECEIPT.worked_by },
			payload: {
				room_id: lab,
				body: `Logged ${samples.join(", ")} on ${work_order}, due ${due_date}.`,
			},
		});
		expect(s.ledger.verify().ok).toBe(true);
	}, 180_000);
});
