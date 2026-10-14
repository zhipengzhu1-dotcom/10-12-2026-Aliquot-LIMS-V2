import { describe, expect, it } from "vitest";
import { sha256Hex } from "../hash.js";
import { AgentId, ArtifactId, RoomId, Sha256 } from "../ids.js";
import { open, say } from "../room/lifecycle.js";
import { seedRooms } from "../room/seed.js";
import { store } from "../sandbox/lifecycle.js";
import { fail } from "../task/lifecycle.js";
import { TEST_OPERATOR } from "../test-support/operator.js";
import { scenario, scores } from "../test-support/scenario.js";
import { finishTurn, startTurn } from "../turn/lifecycle.js";
import type { ArtifactType } from "../types/artifact.js";
import { STAGES } from "../workflow/stages.js";
import { PROJECTION_ROUTES } from "./routes.js";

const rin = AgentId.parse("A-rin");

describe("the route the Chat view reads", () => {
	it("chat serves RM-lab's Messages in seq order with each sayer's name, and no other Room's", () => {
		const s = scenario("2026-10-12T09:00:00.000Z");
		seedRooms(s.ledger, TEST_OPERATOR);
		open(s.ledger, {
			id: RoomId.parse("RM-side"),
			name: "Side",
			purpose: "Elsewhere",
			membership: { tag: "Listed", agents: [rin] },
			opened_by: { tag: "Operator" },
		});
		const lab = RoomId.parse("RM-lab");
		const first = say(s.ledger, {
			actor: TEST_OPERATOR,
			room_id: lab,
			body: "Received 3 bottles",
		});
		say(s.ledger, {
			actor: { tag: "Agent", id: rin },
			room_id: RoomId.parse("RM-side"),
			body: "Not in the Lab Room",
		});
		const reply = say(s.ledger, {
			actor: { tag: "Agent", id: rin },
			room_id: lab,
			body: "Logged",
			reply_to: first.seq,
		});

		expect(PROJECTION_ROUTES.chat(s.ledger.projections)).toEqual({
			room: "RM-lab",
			messages: [
				{
					seq: first.seq,
					ts: "2026-10-12T09:00:00.000Z",
					said_by: "Operator",
					name: "operator@lab.test",
					body: "Received 3 bottles",
				},
				{
					seq: reply.seq,
					ts: "2026-10-12T09:00:00.000Z",
					said_by: "A-rin",
					name: "Rin",
					body: "Logged",
					reply_to: first.seq,
				},
			],
		});
		s.close();
	});
});

describe("the routes the Flow and Performance views read", () => {
	it("stages serves every row of the stage table with its Script id and without its Evaluation", () => {
		const served = PROJECTION_ROUTES.stages();

		expect(served).toHaveLength(STAGES.length);
		expect(served).toEqual(
			STAGES.map((stage) => ({
				number: stage.number,
				name: stage.name,
				script: stage.script,
				script_id: `S-${stage.script}`,
				inputs: stage.inputs,
				...(stage.optional_inputs && {
					optional_inputs: stage.optional_inputs,
				}),
				carried: stage.carried,
				outputs: stage.outputs,
				worked_by: stage.worked_by,
				reviewed_by: stage.reviewed_by,
			})),
		);
		expect(served[1]?.optional_inputs).toEqual(["ReceivingLog"]);
		expect(served[0]?.script_id).toBe("S-parse_submission");
	});

	it("lots serves the Lot each SubmissionRecord names, read from its bytes", () => {
		const s = scenario();
		const blobs = new Map<string, Buffer>();
		const stored = (artifact_type: ArtifactType, text: string) => {
			const bytes = Buffer.from(text);
			const sha256 = Sha256.parse(sha256Hex(bytes));
			blobs.set(sha256, bytes);
			store(
				s.ledger,
				{ actor: { tag: "Operator" } },
				{
					sha256,
					media_type: "application/json",
					artifact_type,
					produced_by: { tag: "Operator" },
					lineage: [],
				},
			);
			return ArtifactId.parse(sha256);
		};
		const record = stored(
			"SubmissionRecord",
			JSON.stringify({ sample: { lot: "LOT-0042" } }),
		);
		stored("SubmissionRecord", JSON.stringify({ sample: { lot: "" } }));
		stored("SubmissionRecord", "not JSON");
		stored("Other", JSON.stringify({ sample: { lot: "LOT-9" } }));
		const read = (id: ArtifactId) => {
			const bytes = blobs.get(id);
			if (bytes === undefined) throw new Error(`no blob ${id}`);
			return bytes;
		};

		const lots = PROJECTION_ROUTES.lots(s.ledger.projections, s.now(), read);

		expect(Object.fromEntries(lots)).toEqual({ [record]: "LOT-0042" });
	});

	it("reviews serves every Review with its assignee and the Merit after it", () => {
		const s = scenario();
		const first = s.reviewed(rin, scores(3));
		const second = s.reviewed(rin, scores(1));

		const rows = PROJECTION_ROUTES.reviews(s.ledger.projections);

		expect(rows).toEqual([
			expect.objectContaining({
				task_id: first,
				reviewer: "A-pia",
				assignee: "A-rin",
				quality: 3,
				timeliness: 3,
				note: "",
				merit: 3,
			}),
			expect.objectContaining({
				task_id: second,
				reviewer: "A-pia",
				assignee: "A-rin",
				quality: 1,
				timeliness: 1,
				merit: 2,
			}),
		]);
		const reviewSeqs = s
			.events()
			.filter((e) => e.kind === "ReviewRecorded")
			.map((e) => [e.seq, e.ts]);
		expect(rows.map((r) => [r.seq, r.at])).toEqual(reviewSeqs);
	});

	it("reviews names the Agent a Review counted toward after its Task fails", () => {
		const s = scenario();
		const task_id = s.submitted(rin);
		s.review(task_id, scores(2));
		fail(s.ledger, {
			actor: { tag: "Operator" },
			task_id,
			reason: "Sample spoiled",
		});

		const rows = PROJECTION_ROUTES.reviews(s.ledger.projections);

		expect(rows).toEqual([
			expect.objectContaining({ task_id, assignee: "A-rin", merit: 2 }),
		]);
	});

	it("reviews serves an Agent's counted Reviews past the 20-Task Merit window", () => {
		const s = scenario();
		const first = s.reviewed(rin, scores(0));
		for (let i = 0; i < 20; i++) s.reviewed(rin, scores(3));

		const rows = PROJECTION_ROUTES.reviews(s.ledger.projections);

		const reviewSeqs = s
			.events()
			.filter((e) => e.kind === "ReviewRecorded")
			.map((e) => e.seq);
		expect(rows.map((r) => [r.assignee, r.seq])).toEqual(
			reviewSeqs.map((seq) => ["A-rin", seq]),
		);
		expect(rows[0], "the Review outside the window").toEqual(
			expect.objectContaining({ task_id: first, merit: 0 }),
		);
		expect(rows.at(-1)?.merit, "Merit over the last 20 Tasks").toBe(3);
	});

	it("budget serves the society's tokens in the trailing 5 hours against the Energy budget", () => {
		const s = scenario("2026-10-12T03:00:00.000Z");
		const turn = (agent: string, at: string, input_tokens: number) => {
			const { turn } = startTurn(s.ledger, {
				agent: AgentId.parse(agent),
				model: "claude-opus-5-5",
				energyBudgetTokens: 1_000_000,
			});
			s.at(at);
			finishTurn(s.ledger, {
				turn_id: turn.started.turn_id,
				usage: {
					input_tokens,
					output_tokens: 100,
					cache_creation_tokens: 10,
					cache_read_tokens: 5000,
					cost_usd: 0.01,
				},
				outcome: { tag: "Completed" },
				tool_calls: 0,
			});
		};
		turn("A-rin", "2026-10-12T03:30:00.000Z", 90_000);
		turn("A-ines", "2026-10-12T08:00:00.000Z", 1000);
		turn("A-rin", "2026-10-12T08:30:00.000Z", 2000);

		const now = new Date("2026-10-12T09:00:00.000Z");
		expect(PROJECTION_ROUTES.budget(s.ledger.projections, now)).toEqual({
			from: "2026-10-12T04:00:00.000Z",
			to: "2026-10-12T09:00:00.000Z",
			tokens: 1000 + 110 + 2000 + 110,
			budget: 1_000_000,
		});
	});
});
