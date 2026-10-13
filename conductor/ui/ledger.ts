import { escapeHtml } from "./markup.js";
import type { Sources, View } from "./views.js";

/** `/api/ledger/verify`: the verdict `ledger verify` prints. */
type Verdict =
	| { readonly ok: true; readonly count: number }
	| { readonly ok: false; readonly seq: number; readonly reason: string };

type LedgerEvent = {
	readonly seq: number;
	readonly ts: string;
	readonly actor: { readonly tag: string; readonly id?: string };
	readonly kind: string;
	readonly task_id?: string;
	readonly causation_id?: number;
	readonly payload: unknown;
};

type LedgerPage = {
	readonly events: readonly LedgerEvent[];
	readonly next: number | null;
};

/** What the Ledger view renders: one page, newest first, and the verdict. */
export type LedgerData = {
	readonly verdict: Verdict;
	/** When `verdict` was read, as an ISO time. */
	readonly checked: string;
	/** The seq of the last Event in the Ledger. */
	readonly head: number;
	/** The page's Events, newest first. */
	readonly events: readonly LedgerEvent[];
};

export const PAGE_SIZE = 50;

/** `/api/ledger` answers at most this many Events a page. */
const MAX_LIMIT = 1000;

/** The last seq, read page by page: a broken chain gives no count. */
const lastSeq = async (get: (route: string) => Promise<unknown>) => {
	let last = 0;
	for (let from: number | null = 1; from !== null; ) {
		const page = (await get(
			`ledger?from=${from}&limit=${MAX_LIMIT}`,
		)) as LedgerPage;
		last = page.events.at(-1)?.seq ?? last;
		from = page.next;
	}
	return last;
};

/**
 * The page of Events before seq `before` in the hash (`#/ledger?before=51`),
 * or the newest page without it, so the newest page takes each new Event at
 * its top and an older page stays put.
 */
const load = async (
	params: URLSearchParams,
	get: (route: string) => Promise<unknown>,
): Promise<LedgerData> => {
	const verdict = (await get("ledger/verify")) as Verdict;
	const checked = new Date().toISOString();
	const head = verdict.ok ? verdict.count : await lastSeq(get);
	const asked = Number(params.get("before"));
	const before =
		Number.isInteger(asked) && asked > 1 && asked <= head ? asked : head + 1;
	const from = Math.max(1, before - PAGE_SIZE);
	const page =
		before > from
			? ((await get(
					`ledger?from=${from}&limit=${before - from}`,
				)) as LedgerPage)
			: { events: [] };
	return { verdict, checked, head, events: [...page.events].reverse() };
};

const verdictText = (verdict: Verdict) =>
	verdict.ok
		? `Ledger verified: ${verdict.count} Events, chain intact`
		: `Ledger broken at seq ${verdict.seq}: ${verdict.reason}`;

const pageLink = (before: number, head: number) =>
	before > head ? "#/ledger" : `#/ledger?before=${before}`;

const row = (event: LedgerEvent, head: number) => {
	const payload = JSON.stringify(event.payload, null, 2);
	const preview = JSON.stringify(event.payload);
	const cause =
		event.causation_id === undefined
			? ""
			: `<a href="${pageLink(event.causation_id + 1, head)}">${event.causation_id}</a>`;
	return [
		`<tr id="event-${event.seq}">`,
		`<td>${event.seq}</td>`,
		`<td><time datetime="${escapeHtml(event.ts)}">${escapeHtml(event.ts)}</time></td>`,
		`<td>${escapeHtml(event.actor.tag === "Agent" ? (event.actor.id ?? "") : event.actor.tag)}</td>`,
		`<td>${escapeHtml(event.kind)}</td>`,
		`<td>${escapeHtml(event.task_id ?? "")}</td>`,
		`<td class="cause">${cause}</td>`,
		`<td><details id="payload-${event.seq}"><summary>${escapeHtml(preview.length > 60 ? `${preview.slice(0, 60)}...` : preview)}</summary><pre>${escapeHtml(payload)}</pre></details></td>`,
		"</tr>",
	].join("");
};

const pages = ({ events, head }: LedgerData) => {
	const newest = events[0]?.seq;
	const oldest = events.at(-1)?.seq;
	if (newest === undefined || oldest === undefined) return "";
	return [
		`<nav class="pages" aria-label="Ledger pages">`,
		newest < head
			? `<a href="#/ledger">Newest</a><a href="${pageLink(newest + 1 + PAGE_SIZE, head)}">Newer</a>`
			: "",
		`<span>Events ${oldest} to ${newest} of ${head}</span>`,
		oldest > 1 ? `<a href="#/ledger?before=${oldest}">Older</a>` : "",
		"</nav>",
	].join("");
};

/**
 * Raw Events, newest first, a page at a time, with the chain's verdict and a
 * Verify button that reads it again. A cause links to the page it heads.
 */
const render = (_view: View, data: Sources): string => {
	const ledger = data as LedgerData;
	return [
		"<h1>Ledger</h1>",
		`<p class="verdict ${ledger.verdict.ok ? "intact" : "broken"}" role="status">${escapeHtml(verdictText(ledger.verdict))}. Checked at ${escapeHtml(ledger.checked.slice(11, 19))} UTC. <button type="button" data-reload>Verify</button></p>`,
		`<table class="ledger"><thead><tr><th>Seq</th><th>Time</th><th>Actor</th><th>Kind</th><th>Task</th><th>Cause</th><th>Payload</th></tr></thead>`,
		`<tbody>${ledger.events.map((e) => row(e, ledger.head)).join("")}</tbody></table>`,
		pages(ledger),
	].join("\n");
};

export const ledgerView: View = {
	name: "ledger",
	title: "Ledger",
	sources: ["ledger", "ledger/verify"],
	render,
	load,
};
