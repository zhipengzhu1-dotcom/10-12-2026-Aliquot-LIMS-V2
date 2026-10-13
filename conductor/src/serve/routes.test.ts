import { describe, expect, it } from "vitest";
import { sha256Hex } from "../hash.js";
import { AgentId, ArtifactId, Sha256 } from "../ids.js";
import { store } from "../sandbox/lifecycle.js";
import { scenario, scores } from "../test-support/scenario.js";
import { finishTurn, startTurn } from "../turn/lifecycle.js";
import type { ArtifactType } from "../types/artifact.js";
import { PROJECTION_ROUTES } from "./routes.js";

const rin = AgentId.parse("A-rin");

describe("the routes the Flow and Performance views read", () => {
	it("stages serves the stage table with each stage's Script id", () => {
		expect(PROJECTION_ROUTES.stages()).toEqual([
			{
				number: 1,
				name: "Submission",
				script: "parse_submission",
				script_id: "S-parse_submission",
				inputs: ["SubmissionForm"],
				carried: [],
				outputs: ["SubmissionRecord"],
				worked_by: "A-rin",
				reviewed_by: "A-pia",
			},
		]);
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
