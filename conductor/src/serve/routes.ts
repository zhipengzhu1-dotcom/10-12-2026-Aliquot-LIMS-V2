import { z } from "zod";
import type { Event } from "../events.js";
import type { ArtifactId } from "../ids.js";
import { tree } from "../org/projection.js";
import type { Projections } from "../projections.js";
import { assigneeOf } from "../task/projection.js";
import { tokensInWindow } from "../turn/projection.js";
import { actorText } from "../types/actor.js";
import type { Review } from "../types/merit.js";
import { DEFAULT_ENERGY_BUDGET_TOKENS } from "../vitality/commands.js";
import { standingOf } from "../vitality/merit.js";
import { vitalityProjection } from "../vitality/projection.js";
import { trustOf } from "../vitality/trust.js";
import { FIVE_HOURS_MS } from "../vitality/vitality.js";
import { STAGES } from "../workflow/stages.js";

const liveAgentIds = (projections: Projections) =>
	[...projections.org.agents.values()]
		.filter((agent) => !agent.retired)
		.map((agent) => agent.definition.id);

/** An Artifact's bytes, as the Artifact store reads them. */
export type ReadArtifact = (id: ArtifactId) => Buffer;

const SubmissionLot = z.object({
	sample: z.object({ lot: z.string().min(1) }),
});

/** The Lot a `SubmissionRecord` names, or undefined when its bytes name none. */
const lotOf = (bytes: Buffer): string | undefined => {
	let record: unknown;
	try {
		record = JSON.parse(bytes.toString("utf8"));
	} catch {
		return undefined;
	}
	const parsed = SubmissionLot.safeParse(record);
	return parsed.success ? parsed.data.sample.lot : undefined;
};

/**
 * Every Review in Ledger order, with the Task's assignee and the assignee's
 * Merit just after it. `merit` is null for a Review that does not count
 * toward Merit, such as the Auditor's on a Task skipped for Review.
 */
const reviewRows = (p: Projections) => {
	const meritAfter = new Map<number, number | undefined>();
	for (const { reviews } of p.work.agents.values()) {
		const counted: Review[] = [];
		for (const { review, seq } of reviews) {
			counted.push(review);
			meritAfter.set(seq, standingOf(counted).merit);
		}
	}
	return [...p.work.reviews.values()]
		.flat()
		.sort((a, b) => a.seq - b.seq)
		.map(({ review: { reviewer, note: _, ...scores }, seq, ts }) => ({
			seq,
			at: ts,
			...scores,
			reviewer: actorText(reviewer),
			assignee: assigneeOf(p.tasks.tasks.get(scores.task_id)) ?? null,
			merit: meritAfter.get(seq) ?? null,
		}));
};

/**
 * What `GET /api/<name>` serves: a Projection as of the Ledger's last Event.
 * `org-tree` is the reporting tree `org tree` prints. `vitality` and `tiers`
 * cover live Agents only, as `vitality show` and `vitality tiers` print them.
 */
export const PROJECTION_ROUTES = {
	org: (p: Projections) => p.org,
	"org-tree": (p: Projections) => tree(p.org),
	tasks: (p: Projections) => p.tasks,
	gates: (p: Projections) => p.gates,
	rooms: (p: Projections) => p.rooms,
	vitality: (p: Projections, now: Date) =>
		vitalityProjection(p, {
			now,
			energyBudgetTokens: DEFAULT_ENERGY_BUDGET_TOKENS,
		}),
	tiers: (p: Projections) =>
		new Map(liveAgentIds(p).map((id) => [id, trustOf(p.trust, id)])),
	scripts: (p: Projections) => p.scripts,
	runs: (p: Projections) => p.runs,
	artifacts: (p: Projections) => p.artifacts,
	turns: (p: Projections) => p.turns,
	stages: () =>
		STAGES.map(({ evaluate: _, ...stage }) => ({
			...stage,
			script_id: `S-${stage.script}`,
		})),
	lots: (p: Projections, _now: Date, read: ReadArtifact) => {
		const lots = new Map<ArtifactId, string>();
		for (const { id, artifact_type } of p.artifacts.artifacts.values()) {
			if (artifact_type !== "SubmissionRecord") continue;
			const lot = lotOf(read(id));
			if (lot !== undefined) lots.set(id, lot);
		}
		return lots;
	},
	reviews: reviewRows,
	budget: (p: Projections, now: Date) => {
		const from = new Date(now.getTime() - FIVE_HOURS_MS);
		return {
			from: from.toISOString(),
			to: now.toISOString(),
			tokens: tokensInWindow(p.turns, "society", from, now),
			budget: DEFAULT_ENERGY_BUDGET_TOKENS,
		};
	},
} satisfies Record<
	string,
	(projections: Projections, now: Date, read: ReadArtifact) => unknown
>;

export type ProjectionName = keyof typeof PROJECTION_ROUTES;

export const isProjectionName = (name: string): name is ProjectionName =>
	Object.hasOwn(PROJECTION_ROUTES, name);

/** JSON with each Map as an object keyed by id and each Set as an array. */
export const toJson = (value: unknown): string =>
	JSON.stringify(value, (_key, v: unknown) =>
		v instanceof Map ? Object.fromEntries(v) : v instanceof Set ? [...v] : v,
	);

export const LEDGER_PAGE_LIMIT = { default: 100, max: 1000 } as const;

/** One page of `GET /api/ledger`, and the seq the next page starts from. */
export type LedgerPage = {
	readonly events: readonly Event[];
	readonly next: number | null;
};

/** The Events from seq `from` on, at most `limit` of them. */
export const ledgerPage = (
	events: Iterable<Event>,
	from: number,
	limit: number,
): LedgerPage => {
	const page: Event[] = [];
	for (const event of events) {
		if (event.seq < from) continue;
		if (page.length === limit) return { events: page, next: event.seq };
		page.push(event);
	}
	return { events: page, next: null };
};
