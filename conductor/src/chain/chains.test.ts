import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { AppendRefused } from "../append-guard.js";
import type { Event } from "../events.js";
import { decideGate } from "../gate/lifecycle.js";
import { gateState } from "../gate/projection.js";
import { ArtifactId, GateId, type Seq, type Sha256 } from "../ids.js";
import { say } from "../room/lifecycle.js";
import { seedRooms } from "../room/seed.js";
import { openArtifacts } from "../sandbox/artifacts.js";
import { buildImage, scriptsRoot } from "../sandbox/image.js";
import { plan } from "../scheduler/plan.js";
import { serve } from "../serve/http.js";
import { dockerAvailable, requireDocker } from "../test-support/docker.js";
import {
	LAB,
	OPERATOR,
	PRODUCT_TYPE,
	READABLE,
	RECEIPT,
	REPORT,
	RESULTS,
	registerLabRoomScripts,
	T0,
	VERIFICATION,
	WORK_ORDER,
} from "../test-support/lab-room.js";
import {
	TEST_OPERATOR,
	TEST_OPERATOR_EMAIL,
} from "../test-support/operator.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import { PARSE_MESSAGE, PARSE_RESULTS_MESSAGE } from "../tools/message.js";
import { STAGES } from "../workflow/stages.js";
import { ensureScript, runWorkflow } from "../workflow/tracer.js";
import { chainKindOf, openChains, REPLY_BOUND_MS } from "./chains.js";

// Each build gives its tag a new image id, so this process's tag is its own.
const IMAGE = `aliquot-sandbox:chains-${process.pid}`;
const SEED_1 = fileURLToPath(
	new URL("../../../fixtures/submission-form-seed1.docx", import.meta.url),
);
const RESULTS_MESSAGE =
	"Lab Ref 26-0412, notebook NB-07 p.31. Container 1: 10.246 g for 20 capsules, 10.246 g taken. Container 2: 10.198 g for 20 capsules, 10.198 g taken. Container 3: 10.302 g for 20 capsules, 10.302 g taken.";
const NO_PRODUCT_TYPE = READABLE.replace(`Product Type ${PRODUCT_TYPE}, `, "");
const NO_NOTEBOOK = RESULTS_MESSAGE.replace("notebook NB-07 p.31. ", "");
const SCHEDULER = {
	tickMs: 15_000,
	dutyMs: 30 * 60_000,
	concurrency: 2,
	energyBudgetTokens: 1_000_000,
};

let s: Scenario;
let home: string;
beforeEach(() => {
	s = scenario(T0);
	seedRooms(s.ledger, TEST_OPERATOR);
	home = mkdtempSync(join(tmpdir(), "aliquot-chains-"));
});
afterEach(() => {
	s.close();
	rmSync(home, { recursive: true, force: true });
});

/** The Scheduler's decisions to start, or skip for the cap, a Turn for new Messages. */
const wokenByMessages = () =>
	plan(s.ledger.projections, s.now(), SCHEDULER, new Map()).filter(
		(d) =>
			(d.tag === "Start" || d.tag === "Skip") && d.why.includes("new Message"),
	);

describe("which Messages the Conductor takes for a Chain", () => {
	it("routes a receipt and results by their words, and leaves any other Message to the Agents", () => {
		expect(chainKindOf(READABLE)).toBe("Receipt");
		expect(chainKindOf("Received some samples from Acme")).toBe("Receipt");
		expect(chainKindOf(RESULTS_MESSAGE)).toBe("Results");
		expect(chainKindOf(NO_NOTEBOOK)).toBe("Results");
		expect(chainKindOf("Results are in for Acme")).toBe("Results");
		expect(chainKindOf("Who is on Probation this week?")).toBeUndefined();
	});

	it("stores a Message it takes as the Conductor's, so the Scheduler wakes no Agent for it or its reply, and wakes them for one it leaves", async () => {
		const engine = openChains({ ledger: s.ledger, home });
		const question = say(s.ledger, {
			actor: OPERATOR,
			room_id: LAB,
			body: "Who is on Probation this week?",
		});
		expect(engine.take(question)).toBe(false);
		expect(wokenByMessages().length, "a question wakes the Agents").toBe(8);

		const receipt = say(s.ledger, {
			actor: OPERATOR,
			room_id: LAB,
			body: READABLE,
		});
		expect(engine.take(receipt)).toBe(true);
		expect(
			s
				.events()
				.find((e) => e.kind === "ArtifactStored" && e.seq > receipt.seq),
		).toMatchObject({
			actor: { tag: "Conductor" },
			causation_id: receipt.seq,
			payload: { artifact_type: "Other", produced_by: { tag: "Operator" } },
		});
		expect(s.ledger.projections.chains.taken.get(receipt.seq)).toBe(LAB);
		await engine.settled();
		expect(
			s.ledger.projections.rooms.messages.at(-1),
			"the Conductor's reply, here that no Script is registered",
		).toMatchObject({
			actor: { tag: "Conductor" },
			causation_id: receipt.seq,
			body: expect.stringMatching(
				/^I cannot receive these yet: .*S-parse_message/,
			),
		});
		const woken = wokenByMessages();
		expect(woken).toHaveLength(8);
		expect(
			woken.filter(
				(d) =>
					!d.why.includes("; 1 new Message") &&
					!d.why.startsWith("1 new Message"),
			),
			"only the question counts, not the receipt or the reply",
		).toEqual([]);
	});

	it("refuses an Operator's Artifact stored by the Conductor whose cause is not an Operator's Message", () => {
		const said = say(s.ledger, {
			actor: { tag: "Agent", id: RECEIPT.worked_by },
			room_id: LAB,
			body: "Received 3 bottles",
		});
		expect(() =>
			openArtifacts({ ledger: s.ledger, home }).store(
				Buffer.from("not a Message"),
				{
					artifact_type: "Other",
					media_type: "text/plain",
					produced_by: TEST_OPERATOR,
					lineage: [],
				},
				{ actor: { tag: "Conductor" }, cause: said.seq },
			),
		).toThrow(/the Conductor stores only an Operator's Message/);
		expect(s.ledger.projections.chains.taken.size).toBe(0);
	});

	it("refuses a Message from the Conductor that answers no Message it took", () => {
		const question = say(s.ledger, {
			actor: OPERATOR,
			room_id: LAB,
			body: "Who is on Probation this week?",
		});
		expect(() =>
			say(s.ledger, {
				actor: { tag: "Conductor" },
				room_id: LAB,
				body: "Nobody",
				reply_to: question.seq,
			}),
		).toThrow(AppendRefused);
		expect(() =>
			say(s.ledger, { actor: { tag: "Conductor" }, room_id: LAB, body: "Hi" }),
		).toThrow(/names no cause/);
	});
});

const suite = dockerAvailable
	? "the Conductor's Chains (Docker)"
	: "the Conductor's Chains: SKIPPED because `docker info` failed; start Docker to run these";

describe.skipIf(!requireDocker())(suite, () => {
	let image: Sha256;
	beforeAll(async () => {
		({ id: image } = await buildImage({ tag: IMAGE }));
	}, 600_000);
	afterAll(() => {
		spawnSync("docker", ["rmi", IMAGE], { stdio: "ignore" });
	});

	/**
	 * The serve with the Conductor's Chains on the scenario's Ledger, and how
	 * the Operator says a Message in the Chat view: through `room-say`, timing
	 * the Conductor's reply from the Operator's MessageSent.
	 */
	const serving = async () => {
		const engine = openChains({ ledger: s.ledger, home });
		const server = await serve(s.ledger, {
			port: 0,
			bind: "127.0.0.1",
			ui: ".",
			people: { tag: "Local", email: TEST_OPERATOR_EMAIL },
			chains: engine,
		});
		const sayInChat = async (body: string) => {
			const appended = new Map<Seq, number>();
			const stop = s.ledger.onAppend((e) =>
				appended.set(e.seq, performance.now()),
			);
			try {
				const response = await fetch(`${server.url}/api/actions/room-say`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ room_id: LAB, body }),
				});
				expect(response.status).toBe(200);
				const { seq } = (await response.json()) as { seq: Seq };
				await engine.settled();
				const reply = s
					.events()
					.find(
						(e) =>
							e.kind === "MessageSent" &&
							e.actor.tag === "Conductor" &&
							e.causation_id === seq,
					);
				const ms =
					reply === undefined
						? Number.POSITIVE_INFINITY
						: (appended.get(reply.seq) ?? 0) - (appended.get(seq) ?? 0);
				return { seq, reply, ms };
			} finally {
				stop();
			}
		};
		return { sayInChat, close: () => server.close() };
	};

	/** Stages 1 to 3 on the Fixture, so the home holds a toy LIMS database. */
	const holdDatabase = async () => {
		await runWorkflow({
			ledger: s.ledger,
			home,
			operator: TEST_OPERATOR,
			formPath: SEED_1,
			plan: STAGES.slice(0, 3).map((stage) => {
				const script = ensureScript({
					ledger: s.ledger,
					home,
					operator: TEST_OPERATOR,
					stage,
					source: join(scriptsRoot, stage.script),
					image,
				});
				return { stage, script: { id: script.id, version: script.version } };
			}),
			timeoutMs: 60_000,
		});
	};

	const runsAfter = (seq: Seq) =>
		s
			.events()
			.flatMap((e) =>
				e.kind === "RunStarted" && e.seq > seq
					? [`${e.payload.script.id} ${e.task_id ?? "no Task"}`]
					: [],
			);

	const evaluationsAfter = (seq: Seq) =>
		s
			.events()
			.flatMap((e) =>
				e.kind === "EvaluationRecorded" && e.seq > seq
					? [`stage ${e.payload.stage} ${e.payload.passed}`]
					: [],
			);

	/** Every Event the Conductor appended after `seq` leads back to `seq` by its causes. */
	const leadsBackTo = (seq: Seq) => {
		const events = new Map<Seq, Event>(s.events().map((e) => [e.seq, e]));
		const orphans = [...events.values()]
			.filter((e) => e.seq > seq && e.actor.tag === "Conductor")
			.filter((e) => {
				let cause = e.causation_id;
				while (cause !== undefined && cause > seq) {
					cause = events.get(cause)?.causation_id;
				}
				return cause !== seq;
			});
		return orphans.map((e) => `${e.seq} ${e.kind}`);
	};

	it("logs the README's receipt on a home holding a toy LIMS database and replies with the Lab References and the due date within the bound, with no Turn", async () => {
		registerLabRoomScripts(s, home, image);
		await holdDatabase();
		const chat = await serving();
		try {
			const { seq, reply, ms } = await chat.sayInChat(READABLE);

			expect(reply?.payload).toMatchObject({
				room_id: LAB,
				body: expect.stringMatching(
					/^Logged LR-2026-0003, LR-2026-0004, LR-2026-0005 on WO-2026-0002, due \d{4}-\d{2}-\d{2}\.$/,
				),
			});
			expect(ms, `the reply came ${ms} ms after the Message`).toBeLessThan(
				REPLY_BOUND_MS,
			);
			expect(runsAfter(seq)).toEqual([
				`S-${PARSE_MESSAGE} no Task`,
				`S-${RECEIPT.script} T-4`,
				`S-${WORK_ORDER.script} T-4`,
			]);
			const after = s.events().filter((e) => e.seq > seq);
			expect(evaluationsAfter(seq)).toEqual([
				`stage ${RECEIPT.number} true`,
				`stage ${WORK_ORDER.number} true`,
			]);
			expect(
				after
					.filter((e) => e.kind.startsWith("Task"))
					.map((e) => `${e.kind} ${e.actor.tag}`),
				"one Task, proposed, assigned and completed by the Conductor",
			).toEqual([
				"TaskProposed Conductor",
				"TaskAssigned Conductor",
				"TaskStarted Conductor",
				"TaskCompleted Conductor",
			]);
			expect(after.filter((e) => e.kind === "TurnStarted")).toEqual([]);
			expect(wokenByMessages()).toEqual([]);
			expect(leadsBackTo(seq)).toEqual([]);
			expect(s.ledger.verify().ok).toBe(true);
		} finally {
			await chat.close();
		}
	}, 300_000);

	it("works the results Message after it through stages 4 to 6 to an open ExternalMessage Gate naming the PDF, replies with the Gate within the bound, and the Operator approves it", async () => {
		registerLabRoomScripts(s, home, image);
		const chat = await serving();
		try {
			await chat.sayInChat(READABLE);
			const { seq, reply, ms } = await chat.sayInChat(RESULTS_MESSAGE);

			expect(runsAfter(seq)).toEqual([
				`S-${PARSE_RESULTS_MESSAGE} no Task`,
				`S-${RESULTS.script} T-2`,
				`S-${VERIFICATION.script} T-2`,
				`S-${REPORT.script} T-2`,
			]);
			const gate = s.ledger.projections.gates.gates.get(GateId.parse("G-1"));
			expect(gate).toMatchObject({
				kind: "ExternalMessage",
				requester: { tag: "Conductor" },
				payload: { lab_reference: "LR-2026-0001" },
			});
			expect(gate && gateState(gate, s.now())).toBe("Open");
			const pdf = ArtifactId.parse(
				(gate?.payload as { artifact_id?: string } | undefined)?.artifact_id,
			);
			expect(s.ledger.projections.artifacts.artifacts.get(pdf)?.filename).toBe(
				"report_of_analysis.pdf",
			);
			expect(reply?.payload).toMatchObject({
				room_id: LAB,
				body: expect.stringMatching(
					new RegExp(
						`^The Report of Analysis of LR-2026-0001 waits on G-1: PDF ${pdf}, xlsx [0-9a-f]{64}\\.$`,
					),
				),
			});
			expect(ms, `the reply came ${ms} ms after the Message`).toBeLessThan(
				REPLY_BOUND_MS,
			);
			expect(evaluationsAfter(seq)).toEqual([
				"stage 4 true",
				"stage 5 true",
				"stage 6 true",
			]);
			expect(s.events().filter((e) => e.kind === "TurnStarted")).toEqual([]);
			expect(leadsBackTo(seq)).toEqual([]);

			decideGate(s.ledger, {
				actor: TEST_OPERATOR,
				gate_id: GateId.parse("G-1"),
				payload_hash: gate?.payload_hash ?? ("" as Sha256),
				meaning: "approve",
				reason: "The report agrees with the notebook",
			});
			const decided = s.ledger.projections.gates.gates.get(GateId.parse("G-1"));
			expect(decided && gateState(decided, s.now())).toBe("Approved");
			expect(s.ledger.verify().ok).toBe(true);
		} finally {
			await chat.close();
		}
	}, 300_000);

	it.each([
		{
			what: "a receipt with no Product Type",
			before: [] as string[],
			body: NO_PRODUCT_TYPE,
			script: PARSE_MESSAGE,
			answer: "I cannot receive these yet: the Message names no Product Type.",
		},
		{
			what: "results with no notebook reference",
			before: [READABLE],
			body: NO_NOTEBOOK,
			script: PARSE_RESULTS_MESSAGE,
			answer:
				"I cannot record these results yet: the Message names no notebook reference.",
		},
	])(
		"answers $what naming what is missing, with no Run beyond the refused parse",
		async ({ before, body, script, answer }) => {
			registerLabRoomScripts(s, home, image);
			const chat = await serving();
			try {
				for (const earlier of before) await chat.sayInChat(earlier);
				const tasks = s.ledger.projections.tasks.tasks.size;
				const { seq, reply } = await chat.sayInChat(body);

				expect(reply?.payload).toMatchObject({ room_id: LAB, body: answer });
				expect(runsAfter(seq)).toEqual([`S-${script} no Task`]);
				expect(s.ledger.projections.tasks.tasks.size, "no Task").toBe(tasks);
				expect(leadsBackTo(seq)).toEqual([]);
				expect(wokenByMessages()).toEqual([]);
				expect(s.ledger.verify().ok).toBe(true);
			} finally {
				await chat.close();
			}
		},
		300_000,
	);
});
