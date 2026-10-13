import { ledgerView } from "./ledger.js";
import { escapeHtml } from "./markup.js";
import { orgView } from "./org.js";

/** The Projection JSON a view shows, by the API route it came from. */
export type Sources = Readonly<Record<string, unknown>>;

/**
 * One page of the interface: its hash route, the API routes it reads, and a
 * pure function from their JSON to markup. Each view ticket replaces a
 * `render`; the shell keeps fetching `sources` again on every Ledger Event.
 */
export type View = {
	readonly name: string;
	readonly title: string;
	readonly sources: readonly string[];
	readonly render: (view: View, data: Sources) => string;
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

const view = (name: string, title: string, sources: string[]): View => ({
	name,
	title,
	sources,
	render: jsonPage,
});

export const VIEWS: readonly View[] = [
	orgView,
	view("flow", "Flow", ["tasks"]),
	view("agent", "Agent", ["org", "vitality", "tiers"]),
	view("rooms", "Rooms", ["rooms"]),
	view("scripts", "Scripts", ["scripts", "runs", "artifacts"]),
	view("gates", "Gates", ["gates"]),
	view("performance", "Performance", ["tiers", "vitality", "tasks", "turns"]),
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
