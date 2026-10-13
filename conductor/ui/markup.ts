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
