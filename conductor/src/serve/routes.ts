import type { Event } from "../events.js";
import type { Projections } from "../projections.js";
import { DEFAULT_ENERGY_BUDGET_TOKENS } from "../vitality/commands.js";
import { vitalityProjection } from "../vitality/projection.js";
import { trustOf } from "../vitality/trust.js";

const liveAgentIds = (projections: Projections) =>
	[...projections.org.agents.values()]
		.filter((agent) => !agent.retired)
		.map((agent) => agent.definition.id);

/**
 * What `GET /api/<name>` serves: a Projection as of the Ledger's last Event.
 * `vitality` and `tiers` cover live Agents only, as `vitality show` and
 * `vitality tiers` print them.
 */
export const PROJECTION_ROUTES = {
	org: (p: Projections) => p.org,
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
} satisfies Record<string, (projections: Projections, now: Date) => unknown>;

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
