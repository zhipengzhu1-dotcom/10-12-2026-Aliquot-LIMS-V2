import type { LedgerEvent } from "./sse.js";

/** What the Conductor answered an action: its Event, or why it wrote nothing. */
export type ActionAnswer =
	| { readonly ok: true; readonly event: LedgerEvent }
	| { readonly ok: false; readonly status: number; readonly text: string };

/**
 * Run the Operator's action `verb`, such as `pause`, with `body` in the
 * command's shape. A refusal answers 409 with the Ledger's own words, and a
 * body that does not fit answers 400.
 */
export const act = async (
	verb: string,
	body: unknown,
): Promise<ActionAnswer> => {
	const res = await fetch(`/api/actions/${encodeURIComponent(verb)}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return res.ok
		? { ok: true, event: (await res.json()) as LedgerEvent }
		: { ok: false, status: res.status, text: await res.text() };
};
