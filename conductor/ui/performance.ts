import { DIMENSIONS, type ReviewRow, reviewsCsv } from "./csv.js";
import { escapeHtml } from "./html.js";
import type { Sources } from "./views.js";

/** The routes the Performance view reads. */
export const PERFORMANCE_SOURCES = [
	"org",
	"reviews",
	"budget",
	"tasks",
] as const;

/** The society's counted tokens in the trailing 5 hours, and the Energy budget. */
type Budget = {
	readonly from: string;
	readonly to: string;
	readonly tokens: number;
	readonly budget: number;
};

type PerformanceJson = {
	readonly org: { readonly agents: Readonly<Record<string, unknown>> };
	readonly reviews: readonly ReviewRow[];
	readonly budget: Budget;
	readonly tasks: {
		readonly tasks: Readonly<
			Record<string, { readonly state: { readonly tag: string } }>
		>;
	};
};

/** The Task states in the order the state machine moves through them. */
const TASK_STATES = [
	"Proposed",
	"Assigned",
	"InProgress",
	"UnderReview",
	"Blocked",
	"Done",
	"Failed",
	"Escalated",
] as const;

/** The share of the Energy budget past which the Steward pauses work that is not urgent. */
export const STEWARD_LINE = 0.8;

const MAX_SCORE = 3;
const SERIES = 8;

/**
 * Each Agent's series colour by Recruitment order, so an Agent keeps its
 * colour whichever Agents have Reviews. Past the eighth, Agents share one.
 */
const seriesClass = (agents: readonly string[], agent: string): string => {
	const i = agents.indexOf(agent);
	return i >= 0 && i < SERIES ? `s${i + 1}` : "s-other";
};

const CHART = {
	width: 640,
	height: 240,
	left: 36,
	right: 16,
	top: 12,
	bottom: 28,
};

/** Where Merit `merit` sits on the chart's y axis. */
export const meritY = (merit: number): number =>
	CHART.top +
	(CHART.height - CHART.top - CHART.bottom) * (1 - merit / MAX_SCORE);

const meritChart = (
	agents: readonly string[],
	counted: readonly ReviewRow[],
): string => {
	if (counted.length === 0) {
		return `<p class="empty">No Review counts toward Merit yet.</p>`;
	}
	const plotWidth = CHART.width - CHART.left - CHART.right;
	const x = (i: number) =>
		CHART.left +
		(counted.length === 1
			? plotWidth / 2
			: (plotWidth * i) / (counted.length - 1));
	const placed = counted.map((r, i) => ({
		r,
		x: x(i),
		y: meritY(r.merit ?? 0),
	}));
	const series = [...new Set(counted.map((r) => r.assignee ?? ""))].sort(
		(a, b) => agents.indexOf(a) - agents.indexOf(b),
	);
	const grid = [0, 1, 2, 3]
		.map(
			(m) =>
				`<line class="grid" x1="${CHART.left}" x2="${CHART.width - CHART.right}" y1="${meritY(m)}" y2="${meritY(m)}"/><text class="axis" x="${CHART.left - 8}" y="${meritY(m) + 4}" text-anchor="end">${m}</text>`,
		)
		.join("");
	const lines = series
		.map((agent) => {
			const own = placed.filter((p) => p.r.assignee === agent);
			const cls = seriesClass(agents, agent);
			const marks = own
				.map(
					({ r, x, y }) =>
						`<circle class="point" cx="${x}" cy="${y}" r="5" data-agent="${escapeHtml(agent)}" data-seq="${r.seq}" data-merit="${r.merit}"><title>${escapeHtml(`${agent}: Merit ${(r.merit ?? 0).toFixed(2)} after ${r.task_id} (seq ${r.seq})`)}</title></circle>`,
				)
				.join("");
			return `<g class="series ${cls}"><path class="trend" d="${own.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ")}"/>${marks}</g>`;
		})
		.join("");
	const latest = (agent: string) =>
		counted.filter((r) => r.assignee === agent).at(-1)?.merit ?? 0;
	const legend = series
		.map(
			(agent) =>
				`<li class="${seriesClass(agents, agent)}"><span class="swatch"></span>${escapeHtml(agent)} ${latest(agent).toFixed(2)}</li>`,
		)
		.join("");
	return `<svg class="chart" viewBox="0 0 ${CHART.width} ${CHART.height}" role="img" aria-label="Merit per Agent after each Review">${grid}${lines}<text class="axis" x="${CHART.left}" y="${CHART.height - 6}">Reviews in Ledger order</text></svg>
<ul class="legend">${legend}</ul>`;
};

const mean = (xs: readonly number[]) =>
	xs.reduce((sum, x) => sum + x, 0) / xs.length;

const rubricTable = (
	agents: readonly string[],
	counted: readonly ReviewRow[],
): string => {
	const reviewed = agents.filter((a) => counted.some((r) => r.assignee === a));
	if (reviewed.length === 0) return "";
	const rows = reviewed.map((agent) => {
		const own = counted.filter((r) => r.assignee === agent);
		const cells = DIMENSIONS.map((d) => {
			const m = mean(own.map((r) => r[d]));
			return `<td data-dimension="${d}" data-mean="${m}"><span class="cell-bar" style="width: ${(m / MAX_SCORE) * 100}%"></span>${m.toFixed(2)}</td>`;
		}).join("");
		return `<tr data-agent="${escapeHtml(agent)}"><th scope="row">${escapeHtml(agent)} <span class="muted">${own.length}</span></th>${cells}</tr>`;
	});
	return `<table class="rubric"><thead><tr><th scope="col">Agent <span class="muted">Reviews</span></th>${DIMENSIONS.map((d) => `<th scope="col">${escapeHtml(d.replace("_", " "))}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
};

const budgetMeter = ({ from, to, tokens, budget }: Budget): string => {
	const fraction = tokens / budget;
	const over = fraction >= STEWARD_LINE;
	const width = 100 * Math.min(1, fraction);
	return `<div class="budget" data-fraction="${fraction}"${over ? ' data-over="true"' : ""}>
<p><b>${tokens.toLocaleString("en-US")}</b> of ${budget.toLocaleString("en-US")} tokens, ${(100 * fraction).toFixed(1)} percent, from ${escapeHtml(from)} to ${escapeHtml(to)}${over ? ". Past the 80 percent line: the Steward pauses work that is not urgent." : ""}</p>
<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="${budget}" aria-valuenow="${tokens}" aria-label="Energy budget used"><span class="fill" style="width: ${width}%"></span><span class="line" style="left: ${100 * STEWARD_LINE}%" title="80 percent"></span></div>
</div>`;
};

const tasksByState = (json: PerformanceJson): string => {
	const counts = new Map<string, number>(TASK_STATES.map((s) => [s, 0]));
	for (const { state } of Object.values(json.tasks.tasks)) {
		counts.set(state.tag, (counts.get(state.tag) ?? 0) + 1);
	}
	const most = Math.max(1, ...counts.values());
	return `<ul class="states">${[...counts]
		.map(
			([state, n]) =>
				`<li data-state="${escapeHtml(state)}" data-count="${n}"><span>${escapeHtml(state)}</span><span class="track"><span class="fill" style="width: ${(100 * n) / most}%"></span></span><b>${n}</b></li>`,
		)
		.join("")}</ul>`;
};

/**
 * The Performance view: Merit per Agent after each Review, the mean of each
 * rubric dimension per Agent, the society's use of the Energy budget, Tasks
 * by state, and the Reviews as a CSV download.
 */
export const performancePage = (data: Sources): string => {
	const json = data as unknown as PerformanceJson;
	const agents = Object.keys(json.org.agents);
	const counted = json.reviews.filter((r) => r.merit !== null);
	const csv = `data:text/csv;charset=utf-8,${encodeURIComponent(reviewsCsv(json.reviews))}`;
	return `<h1>Performance</h1>
<section><h2>Merit per Agent</h2>${meritChart(agents, counted)}</section>
<section><h2>Rubric</h2>${rubricTable(agents, counted) || `<p class="empty">No Review counts toward Merit yet.</p>`}
<p><a class="button" download="reviews.csv" href="${escapeHtml(csv)}">Export CSV</a> <span class="muted">${json.reviews.length} Reviews</span></p></section>
<section><h2>Energy budget</h2>${budgetMeter(json.budget)}</section>
<section><h2>Tasks by state</h2>${tasksByState(json)}</section>`;
};
