import { FLOW_SOURCES, flowPage } from "./flow.js";
import { ledgerView } from "./ledger.js";
import { escapeHtml } from "./markup.js";
import { orgView } from "./org.js";
import { PERFORMANCE_SOURCES, performancePage } from "./performance.js";

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
		params?: URLSearchParams,
	) => string;
	/**
	 * What `render` reads, for a view that fetches by the hash's parameters
	 * (`#/ledger?before=51`) rather than `sources` as they stand.
	 */
	readonly load?: (
		params: URLSearchParams,
		get: (route: string) => Promise<unknown>,
	) => Promise<Sources>;
};

export { escapeHtml };

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
	orgView,
	view(
		"flow",
		"Flow",
		FLOW_SOURCES,
		(_, data, params = new URLSearchParams()) => flowPage(data, params),
	),
	view("agent", "Agent", ["org", "vitality", "tiers"]),
	view("rooms", "Rooms", ["rooms"]),
	view("scripts", "Scripts", ["scripts", "runs", "artifacts"]),
	view("gates", "Gates", ["gates"]),
	view("performance", "Performance", PERFORMANCE_SOURCES, (_, data) =>
		performancePage(data),
	),
	ledgerView,
];

/** The view a hash like `#/gates` names; the Org view for any other. */
export const viewOf = (hash: string): View =>
	VIEWS.find((v) => hash.split("?")[0] === `#/${v.name}`) ?? (VIEWS[0] as View);

/** The parameters after `?` in a hash like `#/ledger?before=51`. */
export const paramsOf = (hash: string): URLSearchParams =>
	new URLSearchParams(hash.split("?")[1] ?? "");

export const navigation = (current: View): string =>
	VIEWS.map(
		(v) =>
			`<a href="#/${v.name}"${v === current ? ' aria-current="page"' : ""}>${escapeHtml(v.title)}</a>`,
	).join("\n");
