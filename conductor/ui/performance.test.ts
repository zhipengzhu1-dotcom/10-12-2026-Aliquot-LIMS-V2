import { describe, expect, it } from "vitest";
import { type ReviewRow, reviewsCsv } from "./csv.js";
import { PERFORMANCE_SOURCES, performancePage } from "./performance.js";

const review = (
	seq: number,
	task_id: string,
	reviewer: string,
	assignee: string,
	scores: [number, number, number, number, number],
	merit: number | null,
): ReviewRow => {
	const [quality, traceability, boundary_adherence, collaboration, timeliness] =
		scores;
	return {
		seq,
		at: `2026-10-12T09:${String(seq).padStart(2, "0")}:00.000Z`,
		task_id,
		reviewer,
		assignee,
		quality,
		traceability,
		boundary_adherence,
		collaboration,
		timeliness,
		merit,
	};
};

const REVIEWS: readonly ReviewRow[] = [
	review(21, "T-1", "A-pia", "A-rin", [3, 3, 3, 3, 3], 3),
	review(30, "T-2", "A-pia", "A-rin", [1, 3, 3, 3, 3], 2.8),
	review(35, "T-3", "A-anselm", "A-ines", [2, 2, 2, 2, 2], 2),
	review(40, "T-4", "A-thorne", "A-bram", [0, 0, 0, 0, 0], null),
];

const AGENTS = [
	"A-odile",
	"A-mabel",
	"A-thorne",
	"A-pia",
	"A-anselm",
	"A-rin",
	"A-ines",
	"A-bram",
];

const page = performancePage({
	org: {
		agents: Object.fromEntries(
			AGENTS.map((id) => [id, { definition: { id } }]),
		),
	},
	reviews: REVIEWS,
	budget: {
		from: "2026-10-12T04:00:00.000Z",
		to: "2026-10-12T09:00:00.000Z",
		tokens: 850_000,
		budget: 1_000_000,
	},
	tasks: {
		tasks: {
			"T-1": { state: { tag: "Done" } },
			"T-2": { state: { tag: "Done" } },
			"T-3": { state: { tag: "InProgress" } },
			"T-4": { state: { tag: "Failed" } },
		},
	},
});

describe("the Performance view", () => {
	it("reads the Org, the Reviews, the Energy budget and the Tasks", () => {
		expect(PERFORMANCE_SOURCES).toEqual(["org", "reviews", "budget", "tasks"]);
	});

	it("plots one point per counted Review at the assignee's Merit after it", () => {
		const marks = [
			...page.matchAll(
				/<circle class="point" cx="[\d.]+" cy="([\d.]+)" r="5" data-agent="([^"]+)" data-seq="(\d+)" data-merit="([\d.]+)"/g,
			),
		].map(([, cy, agent, seq, merit]) => ({
			agent,
			seq: Number(seq),
			merit: Number(merit),
			cy: Number(cy),
		}));

		expect(marks.map(({ agent, seq, merit }) => [agent, seq, merit])).toEqual([
			["A-rin", 21, 3],
			["A-rin", 30, 2.8],
			["A-ines", 35, 2],
		]);
		// The plot runs from y 212 (Merit 0) up to y 12 (Merit 3).
		for (const { merit, cy } of marks) {
			expect(cy).toBeCloseTo(212 - (200 * merit) / 3);
		}
	});

	it("gives the mean of each rubric dimension per Agent over its counted Reviews", () => {
		const means = Object.fromEntries(
			[...page.matchAll(/<tr data-agent="([^"]+)">(.*?)<\/tr>/gs)].map(
				([, agent, row]) => [
					agent,
					Object.fromEntries(
						[
							...(row ?? "").matchAll(
								/data-dimension="(\w+)" data-mean="([\d.]+)"/g,
							),
						].map(([, d, m]) => [d, Number(m)]),
					),
				],
			),
		);

		expect(means).toEqual({
			"A-rin": {
				quality: 2,
				traceability: 3,
				boundary_adherence: 3,
				collaboration: 3,
				timeliness: 3,
			},
			"A-ines": {
				quality: 2,
				traceability: 2,
				boundary_adherence: 2,
				collaboration: 2,
				timeliness: 2,
			},
		});
	});

	it("shows the society's share of the Energy budget against the 80 percent line", () => {
		expect(page).toContain(
			'<div class="budget" data-fraction="0.85" data-over="true">',
		);
		expect(page).toContain("<b>850,000</b> of 1,000,000 tokens, 85.0 percent");
		expect(page).toContain('<span class="line" style="left: 80%"');
	});

	it("counts the Tasks in each state", () => {
		const counts = Object.fromEntries(
			[...page.matchAll(/<li data-state="(\w+)" data-count="(\d+)">/g)].map(
				([, state, n]) => [state, Number(n)],
			),
		);

		expect(counts).toEqual({
			Proposed: 0,
			Assigned: 0,
			InProgress: 1,
			UnderReview: 0,
			Blocked: 0,
			Done: 2,
			Failed: 1,
			Escalated: 0,
		});
	});

	it("exports every Review, counted or not, as a CSV download", () => {
		const href =
			/<a class="button" download="reviews\.csv" href="data:text\/csv;charset=utf-8,([^"]+)">Export CSV<\/a>/.exec(
				page,
			)?.[1];

		expect(decodeURIComponent(href ?? "")).toBe(reviewsCsv(REVIEWS));
	});
});

describe("the Reviews CSV", () => {
	it("has a header row and one row per Review with its five scores", () => {
		expect(reviewsCsv(REVIEWS).split("\r\n")).toEqual([
			"review_seq,task_id,reviewer,assignee,at,quality,traceability,boundary_adherence,collaboration,timeliness",
			"21,T-1,A-pia,A-rin,2026-10-12T09:21:00.000Z,3,3,3,3,3",
			"30,T-2,A-pia,A-rin,2026-10-12T09:30:00.000Z,1,3,3,3,3",
			"35,T-3,A-anselm,A-ines,2026-10-12T09:35:00.000Z,2,2,2,2,2",
			"40,T-4,A-thorne,A-bram,2026-10-12T09:40:00.000Z,0,0,0,0,0",
			"",
		]);
	});

	it("has only the header row when there is no Review", () => {
		expect(reviewsCsv([])).toBe(
			"review_seq,task_id,reviewer,assignee,at,quality,traceability,boundary_adherence,collaboration,timeliness\r\n",
		);
	});

	it("quotes a field that holds a comma or a quote, and leaves an unknown assignee empty", () => {
		const odd = {
			...review(9, 'T-9,"x"', "Operator", "A-rin", [3, 3, 3, 3, 3], null),
			assignee: null,
		};

		expect(reviewsCsv([odd]).split("\r\n")[1]).toBe(
			'9,"T-9,""x""",Operator,,2026-10-12T09:09:00.000Z,3,3,3,3,3',
		);
	});
});
