import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { ArtifactId, type Sha256 } from "../ids.js";
import { say } from "../room/lifecycle.js";
import { seedRooms } from "../room/seed.js";
import { openArtifacts } from "../sandbox/artifacts.js";
import { buildImage, scriptsRoot } from "../sandbox/image.js";
import { dockerAvailable, requireDocker } from "../test-support/docker.js";
import {
	director,
	LAB,
	ODILE,
	OPERATOR,
	PRODUCT_TYPE,
	RECEIPT,
	REPORT_TO,
	receive,
	registerLabRoomScripts,
	replyTo,
	runScheduler,
	scripted,
	T0,
	WORK_ORDER,
} from "../test-support/lab-room.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import type { RunModel } from "../turn/model.js";
import { STAGES } from "../workflow/stages.js";
import { ensureScript, runWorkflow } from "../workflow/tracer.js";
import { messageArtifactId, PARSE_MESSAGE } from "./message.js";

// Each build gives its tag a new image id, so this process's tag is its own.
const IMAGE = `aliquot-sandbox:receiving-${process.pid}`;
const SEED_1 = fileURLToPath(
	new URL("../../../fixtures/submission-form-seed1.docx", import.meta.url),
);
const UNREADABLE = "Received some samples from Acme";
const ASKED =
	"I cannot log these yet: which product is it, and what are its Lot and Product Code?";
/** #60's receipt: every value but the Product Type and the Report To party. */
const NO_REPORT_TO =
	"Received 3 bottles of Vitamin C 500 mg capsules, Lot 2403A, Product Code VC500, finished product, from Acme Nutrition, regular TAT";

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

describe("receiving from chat, the Director's judgement on an unreadable Message", () => {
	it("gets the Director's reply in RM-lab naming what is missing, and no Task", async () => {
		const message = say(s.ledger, {
			actor: OPERATOR,
			room_id: LAB,
			body: UNREADABLE,
		});
		const odileModel = director(message, [
			{
				tool: "send_message",
				input: { room_id: LAB, reply_to: message.seq, body: ASKED },
			},
		]);

		await runScheduler(
			s,
			home,
			(agent) => (agent === ODILE ? odileModel : scripted([])),
			() => replyTo(s, message.seq) !== undefined,
		);

		expect(replyTo(s, message.seq)).toMatchObject({
			actor: { tag: "Agent", id: ODILE },
			payload: { room_id: LAB, body: ASKED },
		});
		expect(ASKED).toMatch(/product.*Lot.*Product Code/);
		expect(s.events().filter((e) => e.kind === "TaskProposed")).toEqual([]);
		expect(
			s.ledger.projections.artifacts.artifacts.has(messageArtifactId(message)),
			"the Message is not stored",
		).toBe(false);
		expect(s.ledger.verify().ok).toBe(true);
	});

	it("gets the Director's reply asking for the Product Type and the Report To party a receipt lacks, and no Task", async () => {
		const message = say(s.ledger, {
			actor: OPERATOR,
			room_id: LAB,
			body: NO_REPORT_TO,
		});
		// The Director asks for each labelled value its prompt names that the
		// Message does not label.
		const odileModel: RunModel = (request) => {
			const lacking = [
				...request.prompt.work.matchAll(
					/the ([A-Z][\w ]*?) after "([^"]+)"( with its [\w ,]+? and \w+)?/g,
				),
			]
				.filter(
					([, , label = ""]) =>
						!message.body.toLowerCase().includes(label.toLowerCase()),
				)
				.map(([, name, , parts]) => `the ${name}${parts ?? ""}`);
			return director(message, [
				{
					tool: "send_message",
					input: {
						room_id: LAB,
						reply_to: message.seq,
						body: `I cannot log these yet: please give ${lacking.join(" and ")}.`,
					},
				},
			])(request);
		};

		await runScheduler(
			s,
			home,
			(agent) => (agent === ODILE ? odileModel : scripted([])),
			() => replyTo(s, message.seq) !== undefined,
		);

		expect(replyTo(s, message.seq)).toMatchObject({
			actor: { tag: "Agent", id: ODILE },
			payload: {
				room_id: LAB,
				body: "I cannot log these yet: please give the Product Type and the Report To party with its company, Contact, Address and City.",
			},
		});
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
		registerLabRoomScripts(s, home, image);

		const message = await receive(s, home);

		const id = messageArtifactId(message);
		const events = s.events();
		expect(
			events.find((e) => e.kind === "TaskProposed"),
			"the Director proposes the Task on the Message",
		).toMatchObject({
			actor: { tag: "Agent", id: ODILE },
			payload: { inputs: [id] },
		});
		expect(
			events.find((e) => e.kind === "TaskAssigned"),
			"to the Specialist who works stage 2",
		).toMatchObject({
			actor: { tag: "Agent", id: ODILE },
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
		expect(record.report_to).toEqual({ ...REPORT_TO, phone: "", email: "" });
		expect(record.sample).toMatchObject({
			sample_description: "Vitamin C 500 mg capsules",
			lot: "2403A",
			product_code: "VC500",
			product_type: PRODUCT_TYPE,
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
			replyTo(s, message.seq),
			"the Specialist's reply in RM-lab",
		).toMatchObject({
			actor: { tag: "Agent", id: RECEIPT.worked_by },
			payload: {
				room_id: LAB,
				body: `Logged ${samples.join(", ")} on ${work_order}, due ${due_date}.`,
			},
		});
		expect(s.ledger.verify().ok).toBe(true);
	}, 180_000);

	it("logs a receipt on the latest toy LIMS database a home holds, so its Lab References and Work Order continue the sequence", async () => {
		registerLabRoomScripts(s, home, image);
		const fixture = await runWorkflow({
			ledger: s.ledger,
			home,
			formPath: SEED_1,
			plan: STAGES.slice(0, 3).map((stage) => {
				const script = ensureScript({
					ledger: s.ledger,
					home,
					stage,
					source: join(scriptsRoot, stage.script),
					image,
				});
				return { stage, script: { id: script.id, version: script.version } };
			}),
			timeoutMs: 60_000,
		});
		expect(fixture.stages.map((r) => r.state.tag)).toEqual([
			"Done",
			"Done",
			"Done",
		]);
		const artifacts = openArtifacts({ ledger: s.ledger, home });
		const latestDatabase = () => {
			const found = [...s.ledger.projections.artifacts.artifacts.values()]
				.filter((a) => a.artifact_type === "LimsDatabase")
				.at(-1);
			if (found === undefined) throw new Error("no LimsDatabase stored");
			return found.id;
		};
		const ordered = (id: ArtifactId) => {
			const db = new DatabaseSync(artifacts.path(id), { readOnly: true });
			const rows = db
				.prepare(
					"SELECT DISTINCT s.lab_reference, w.work_order FROM samples s LEFT JOIN work_orders w USING (lab_reference) ORDER BY s.lab_reference",
				)
				.all()
				.map((r) => `${r.lab_reference} ${r.work_order}`);
			db.close();
			return rows;
		};
		const carried = latestDatabase();
		expect(ordered(carried), "the Fixture's run").toEqual([
			"LR-2026-0001 WO-2026-0001",
			"LR-2026-0002 WO-2026-0001",
		]);

		const message = await receive(s, home);

		const [chat] = [...s.ledger.projections.proposals.proposedBy].flatMap(
			([task_id, by]) =>
				by.tag === "Agent" && by.id === ODILE ? [task_id] : [],
		);
		const [parsed, logged] = [...s.ledger.projections.runs.runs.values()]
			.filter((r) => r.task_id === chat)
			.flatMap((r) => (r.finished === undefined ? [] : [r.finished.run]));
		const record = parsed?.outputs.find(
			(o) =>
				s.ledger.projections.artifacts.artifacts.get(o)?.artifact_type ===
				"SubmissionRecord",
		);
		expect(
			logged && [logged.script.id, ...logged.inputs],
			"the chat Task's S-log_receipt Run carries the Fixture's database",
		).toEqual([`S-${RECEIPT.script}`, record, carried]);
		expect(ordered(latestDatabase())).toEqual([
			"LR-2026-0001 WO-2026-0001",
			"LR-2026-0002 WO-2026-0001",
			"LR-2026-0003 WO-2026-0002",
			"LR-2026-0004 WO-2026-0002",
			"LR-2026-0005 WO-2026-0002",
		]);
		expect(replyTo(s, message.seq)?.payload).toMatchObject({
			body: expect.stringMatching(
				/^Logged LR-2026-0003, LR-2026-0004, LR-2026-0005 on WO-2026-0002, due /,
			),
		});
		expect(s.ledger.verify().ok).toBe(true);
	}, 300_000);
});
