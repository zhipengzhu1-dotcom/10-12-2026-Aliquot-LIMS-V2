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
		: { ok: false, status: res.status, text: (await res.text()).trim() };
};

/** The status line for an action: the Event it appended, or the refusal. */
export const answerText = (answer: ActionAnswer): string =>
	answer.ok
		? `Appended ${answer.event.kind} at seq ${answer.event.seq}`
		: `${answer.status}: ${answer.text}`;

/**
 * The body a view's action form posts: the JSON its markup carries in
 * `data-body`, with each field the Operator filled in set at its dotted
 * name, as `definition.supervisor_id`. An empty field leaves its key out.
 */
export const bodyOf = (
	fixed: string,
	fields: Iterable<readonly [string, string]>,
): Record<string, unknown> => {
	const body = JSON.parse(fixed) as Record<string, unknown>;
	for (const [name, value] of fields) {
		const path = name.split(".");
		const key = path.pop() ?? name;
		let target = body;
		for (const step of path) target = target[step] as Record<string, unknown>;
		if (value === "") delete target[key];
		else target[key] = value;
	}
	return body;
};
