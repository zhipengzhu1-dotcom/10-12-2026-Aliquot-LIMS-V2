import { act, bodyOf } from "./actions.js";

export const fromHtml = (text: string): string =>
	text
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");

/** The form `id` on `page`: its verb, its fixed body, and its markup. */
export const formOf = (page: string, id: string) => {
	const found = new RegExp(
		`<form id="${id}"[^>]* data-action="([^"]+)" data-body="([^"]*)"[^>]*>(.*?)</form>`,
		"s",
	).exec(page);
	if (found === null) throw new Error(`the page has no form ${id}`);
	const [, verb = "", body = "", markup = ""] = found;
	return { verb, body: fromHtml(body), markup };
};

/** The text a `<textarea>` on `page` was drawn with. */
export const textareaOf = (page: string, id: string): string => {
	const found = new RegExp(
		`<textarea id="${id}"[^>]*>(.*?)</textarea>`,
		"s",
	).exec(page);
	if (found === null) throw new Error(`the page has no textarea ${id}`);
	return fromHtml(found[1] ?? "");
};

/**
 * Submit the form `id` on `page` as the shell does, with `fields` filled in
 * in form order; a field drawn with `data-json` is parsed.
 */
export const submit = (
	page: string,
	id: string,
	fields: [string, string][] = [],
) => {
	const { verb, body, markup } = formOf(page, id);
	const json = new Set(
		[...markup.matchAll(/<textarea [^>]*name="([^"]+)"[^>]* data-json/g)].map(
			([, name]) => name ?? "",
		),
	);
	return act(verb, bodyOf(body, fields, json));
};
