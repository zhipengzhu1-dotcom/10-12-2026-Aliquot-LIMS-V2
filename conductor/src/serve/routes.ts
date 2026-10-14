import { z } from "zod";
import type { Event } from "../events.js";
import type { AgentId, ArtifactId } from "../ids.js";
import { tree } from "../org/projection.js";
import type { Projections } from "../projections.js";
import { LAB_ROOM } from "../room/seed.js";
import { assigneeOf } from "../task/projection.js";
import { tokensInWindow } from "../turn/projection.js";
import { actorName, actorText } from "../types/actor.js";
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

const Lotted = z.object({ lot: z.string().min(1) });

/**
 * The Samples' Lots, in either shape a Ledger holds: `submission/2` lists
 * `samples`, and the `submission/1` records stored before it held one
 * `sample` (ADR-0012).
 */
const SubmissionLots = z.union([
	z.object({ samples: z.array(Lotted).min(1) }).transform((r) => r.samples),
	z.object({ sample: Lotted }).transform((r) => [r.sample]),
]);

/** The Lots a `SubmissionRecord` names, or undefined when its bytes name none. */
const lotOf = (bytes: Buffer): string | undefined => {
	let record: unknown;
	try {
		record = JSON.parse(bytes.toString("utf8"));
	} catch {
		return undefined;
	}
	const parsed = SubmissionLots.safeParse(record);
	return parsed.success
		? [...new Set(parsed.data.map((s) => s.lot))].join(", ")
		: undefined;
};

/**
 * Every Review in Ledger order, with its note, the assignee and the
 * assignee's Merit just after it. The assignee of a Review that counts
 * toward Merit is the Agent it counted toward, which a Task that later
 * fails or is escalated no longer names. `merit` is null for a Review that
 * does not count toward Merit, such as the Auditor's on a Task skipped for
 * Review, whose assignee is the Task's.
 */
const reviewRows = (p: Projections) => {
	const countedFor = new Map<
		number,
		{ readonly agent: AgentId; readonly merit: number | undefined }
	>();
	for (const [agent, { reviews }] of p.work.agents) {
		const counted: Review[] = [];
		for (const { review, seq } of reviews) {
			counted.push(review);
			countedFor.set(seq, { agent, merit: standingOf(counted).merit });
		}
	}
	return [...p.work.reviews.values()]
		.flat()
		.sort((a, b) => a.seq - b.seq)
		.map(({ review: { reviewer, ...review }, seq, ts }) => ({
			seq,
			at: ts,
			...review,
			reviewer: actorText(reviewer),
			assignee:
				countedFor.get(seq)?.agent ??
				assigneeOf(p.tasks.tasks.get(review.task_id)) ??
				null,
			merit: countedFor.get(seq)?.merit ?? null,
		}));
};

/**
 * What `GET /api/<name>` serves: a Projection as of the Ledger's last Event.
 * `org-tree` is the reporting tree `org tree` prints. `vitality` and `tiers`
 * cover live Agents only, as `vitality show` and `vitality tiers` print them.
 * `training` holds every Agent's Memory notes and Coaching, and every version
 * of each Skill. `chat` is the Lab Room's Messages in seq order, each with
 * the sayer's name from the Org, or the Operator's email.
 */
export const PROJECTION_ROUTES = {
	org: (p: Projections) => p.org,
	"org-tree": (p: Projections) => tree(p.org),
	tasks: (p: Projections) => p.tasks,
	gates: (p: Projections) => p.gates,
	rooms: (p: Projections) => p.rooms,
	chat: (p: Projections) => ({
		room: LAB_ROOM.id,
		messages: p.rooms.messages
			.filter((m) => m.room_id === LAB_ROOM.id)
			.map(({ room_id: _, actor, causation_id, ...m }) => ({
				...m,
				said_by: actorText(actor),
				name:
					actor.tag === "Agent"
						? (p.org.agents.get(actor.id)?.definition.name ?? actor.id)
						: actorName(actor),
				...(causation_id === undefined ? {} : { reply_to: causation_id }),
			})),
	}),
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
	training: (p: Projections) => p.training,
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
