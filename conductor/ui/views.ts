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
};

const ENTITIES: Readonly<Record<string, string>> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

/** Text safe to put in markup: a Message body is anyone's words. */
export const escapeHtml = (text: string): string =>
	text.replace(/[&<>"']/g, (ch) => ENTITIES[ch] ?? ch);

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
	view("org", "Org", ["org", "vitality", "tiers"]),
	view("flow", "Flow", ["tasks"]),
	view("agent", "Agent", ["org", "vitality", "tiers"]),
	view("rooms", "Rooms", ["rooms"]),
	view("scripts", "Scripts", ["scripts", "runs", "artifacts"]),
	view("gates", "Gates", ["gates"]),
	view("performance", "Performance", ["tiers", "vitality", "tasks"]),
	view("ledger", "Ledger", ["ledger", "ledger/verify"]),
];

/** The view a hash like `#/gates` names; the Org view for any other. */
export const viewOf = (hash: string): View =>
	VIEWS.find((v) => hash === `#/${v.name}`) ?? (VIEWS[0] as View);

export const navigation = (current: View): string =>
	VIEWS.map(
		(v) =>
			`<a href="#/${v.name}"${v === current ? ' aria-current="page"' : ""}>${escapeHtml(v.title)}</a>`,
	).join("\n");
