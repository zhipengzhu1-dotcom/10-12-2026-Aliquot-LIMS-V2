/** The rubric's five dimensions, in the order a Review lists them. */
export const DIMENSIONS = [
	"quality",
	"traceability",
	"boundary_adherence",
	"collaboration",
	"timeliness",
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

/**
 * One Review as `/api/reviews` serves it: the Task's assignee, and the
 * assignee's Merit just after the Review, null when the Review does not
 * count toward Merit.
 */
export type ReviewRow = {
	readonly seq: number;
	readonly at: string;
	readonly task_id: string;
	readonly reviewer: string;
	readonly assignee: string | null;
	readonly merit: number | null;
} & Readonly<Record<Dimension, number>>;

const HEADER = [
	"review_seq",
	"task_id",
	"reviewer",
	"assignee",
	"at",
	...DIMENSIONS,
];

const field = (value: string | number | null): string => {
	const text = value === null ? "" : String(value);
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** The Reviews as RFC 4180 CSV: a header row, then one row per Review. */
export const reviewsCsv = (reviews: readonly ReviewRow[]): string =>
	[
		HEADER,
		...reviews.map((r) => [
			r.seq,
			r.task_id,
			r.reviewer,
			r.assignee,
			r.at,
			...DIMENSIONS.map((d) => r[d]),
		]),
	]
		.map((row) => `${row.map(field).join(",")}\r\n`)
		.join("");
