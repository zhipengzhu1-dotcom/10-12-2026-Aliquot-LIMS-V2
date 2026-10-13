import { FLOW_SOURCES, flowPage } from "./flow.js";
import { escapeHtml } from "./html.js";
import { PERFORMANCE_SOURCES, performancePage } from "./performance.js";

export { escapeHtml };

/** The Projection JSON a view shows, by the API route it came from. */
export type Sources = Readonly<Record<string, unknown>>;

/**
 * One page of the interface: its hash route, the API routes it reads, and a
 * pure function from their JSON and the hash's query, such as
 * `#/flow?task=T-1`, to markup. Each view ticket replaces a `render`; the
 * shell keeps fetching `sources` again on every Ledger Event.
 */
export type View = {
	readonly name: string;
	readonly title: string;
	readonly sources: readonly string[];
	readonly render: (
		view: View,
		data: Sources,
		params: URLSearchParams,
	) => string;
};

/** Each source's JSON as it came, until the view's ticket draws it. */
export const jsonPage = (view: View, data: Sources): string =>
	[
		`<h1>${escapeHtml(view.title)}</h1>`,
		...view.sources.map(
			(source) =>
				`<section><h2>/api/${escapeHtml(source)}</h2><pre>${escapeHtml(JSON.stringify(data[source], null, 2) ?? "")}</pre></section>`,
		),
	].join("\n");

const view = (
	name: string,
	title: string,
	sources: readonly string[],
	render: View["render"] = jsonPage,
): View => ({ name, title, sources, render });

export const VIEWS: readonly View[] = [
	view("org", "Org", ["org", "vitality", "tiers"]),
	view("flow", "Flow", FLOW_SOURCES, (_, data, params) =>
		flowPage(data, params),
	),
	view("agent", "Agent", ["org", "vitality", "tiers"]),
	view("rooms", "Rooms", ["rooms"]),
	view("scripts", "Scripts", ["scripts", "runs", "artifacts"]),
	view("gates", "Gates", ["gates"]),
	view("performance", "Performance", PERFORMANCE_SOURCES, (_, data) =>
		performancePage(data),
	),
	view("ledger", "Ledger", ["ledger", "ledger/verify"]),
];

/** The view a hash like `#/gates` or `#/flow?task=T-1` names; the Org view for any other. */
export const viewOf = (hash: string): View =>
	VIEWS.find((v) => hash.split("?")[0] === `#/${v.name}`) ?? (VIEWS[0] as View);

/** The query of a hash like `#/flow?task=T-1`. */
export const paramsOf = (hash: string): URLSearchParams =>
	new URLSearchParams(hash.split("?")[1] ?? "");

export const navigation = (current: View): string =>
	VIEWS.map(
		(v) =>
			`<a href="#/${v.name}"${v === current ? ' aria-current="page"' : ""}>${escapeHtml(v.title)}</a>`,
	).join("\n");
