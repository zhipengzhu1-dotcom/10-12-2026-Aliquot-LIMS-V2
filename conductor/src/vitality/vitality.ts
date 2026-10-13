import type { AgentId, TaskId } from "../ids.js";
import type { Projections } from "../projections.js";
import type { Vitality } from "../types/vitality.js";
import {
	type DatedReview,
	mean,
	openTasks,
	scoresOf,
	type WorkState,
	workOf,
} from "./work.js";

export type SampleOptions = {
	readonly now: Date;
	/** Tokens per 5-hour window for the whole society, set by the Operator. */
	readonly energyBudgetTokens: number;
	/**
	 * Tokens the Agent used in the rolling 5-hour window. No Event carries
	 * token use yet; from slice 1 the Conductor supplies it from each Turn's
	 * `modelUsage`. Defaults to 0.
	 */
	readonly tokensUsedInWindow?: number;
};

/** The latest RestOrdered for the Agent is a `begin`. */
export const restInEffect = (work: WorkState, agent: AgentId): boolean =>
	work.resting.has(agent);

/**
 * Compute a Vitality sample from the Ledger's Projections, per the Field
 * table of docs/design/vitality-and-merit.md.
 */
export const sampleVitality = (
	ledger: Projections,
	agent: AgentId,
	options: SampleOptions,
): Vitality => {
	const { org, work } = ledger;
	const definition = org.agents.get(agent)?.definition;
	if (definition === undefined) throw new Error(`${agent} is not in the Org`);
	if (!(options.energyBudgetTokens > 0)) {
		throw new Error(
			`the Energy budget must be a positive number of tokens, not ${options.energyBudgetTokens}`,
		);
	}
	const notResting = [...org.agents.values()].filter(
		(a) => !a.retired && !restInEffect(work, a.definition.id),
	).length;
	const share = options.energyBudgetTokens / Math.max(1, notResting);
	return {
		agent,
		load: openTasks(ledger.tasks, agent).open / definition.capacity,
		fatigue: (options.tokensUsedInWindow ?? 0) / share,
		...fromRecentWork(work, agent),
		morale: morale(workOf(work, agent).reviews, options.now),
	};
};

const RECENT_TASKS = 10;
const DAY_MS = 86_400_000;

/** `friction` and `confidence` over the Agent's last 10 Tasks. */
const fromRecentWork = (work: WorkState, agent: AgentId) => {
	const recent = workOf(work, agent).tasks.slice(-RECENT_TASKS);
	let failedRuns = 0;
	let lowReviews = 0;
	for (const task of recent) {
		failedRuns += work.failedRuns.get(task) ?? 0;
		lowReviews += (work.reviews.get(task) ?? []).filter((r) =>
			scoresOf(r.review).some((x) => x <= 1),
		).length;
	}
	const recentSet = new Set(recent);
	const evaluation = new Map<TaskId, number>();
	for (const e of work.evaluations.values()) {
		if (recentSet.has(e.task_id)) evaluation.set(e.task_id, e.score);
	}
	const scores = [...evaluation.values()];
	return {
		friction:
			recent.length === 0
				? 0
				: Math.min(1, (failedRuns + lowReviews) / recent.length),
		confidence: scores.length === 0 ? 1 : mean(scores),
	};
};

/**
 * Least-squares slope of daily Review means over the 7 days up to `now`, in
 * Merit points per week; 0 with fewer than two days that have Reviews.
 * Reviews are averaged per day (counted back from `now`) first: Reviews
 * minutes apart would otherwise give slopes of thousands of points a week.
 */
const morale = (reviews: readonly DatedReview[], now: Date): number => {
	const byDay = new Map<number, number[]>();
	for (const r of reviews) {
		const daysAgo = Math.floor((now.getTime() - Date.parse(r.ts)) / DAY_MS);
		if (daysAgo < 0 || daysAgo >= 7) continue;
		byDay.set(daysAgo, [
			...(byDay.get(daysAgo) ?? []),
			mean(scoresOf(r.review)),
		]);
	}
	const points = [...byDay].map(([daysAgo, means]) => ({
		x: -daysAgo,
		y: mean(means),
	}));
	if (points.length < 2) return 0;
	const mx = mean(points.map((p) => p.x));
	const my = mean(points.map((p) => p.y));
	const sxx = points.reduce((sum, p) => sum + (p.x - mx) ** 2, 0);
	const sxy = points.reduce((sum, p) => sum + (p.x - mx) * (p.y - my), 0);
	return (sxy / sxx) * 7;
};
