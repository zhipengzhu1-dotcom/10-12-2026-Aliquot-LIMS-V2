import { escapeHtml } from "./markup.js";
import type { Sources, View } from "./views.js";

/** One Message as `/api/chat` sends it. */
export type ChatMessage = {
	readonly seq: number;
	readonly ts: string;
	readonly said_by: string;
	readonly name: string;
	readonly body: string;
	readonly reply_to?: number;
};

/** What `/api/chat` sends: the Lab Room's id and its Messages in seq order. */
export type ChatJson = {
	readonly room: string;
	readonly messages: readonly ChatMessage[];
};

const sayer = (m: ChatMessage) =>
	m.name === m.said_by
		? escapeHtml(m.name)
		: `${escapeHtml(m.name)} <span class="muted">${escapeHtml(m.said_by)}</span>`;

const message = (m: ChatMessage) =>
	[
		`<li class="message" data-seq="${m.seq}">`,
		`<div class="said"><b>${sayer(m)}</b> <time datetime="${escapeHtml(m.ts)}">${escapeHtml(m.ts)}</time> <span class="muted">seq ${m.seq}${m.reply_to === undefined ? "" : `, replying to seq ${m.reply_to}`}</span></div>`,
		`<p class="body">${escapeHtml(m.body)}</p>`,
		"</li>",
	].join("");

/**
 * The Lab Room as the Operator reads it: every Message in seq order, newest
 * last, each with who said it, and a box that says the Operator's text to
 * the whole team.
 */
const render = (_view: View, data: Sources): string => {
	const { room, messages } = data.chat as ChatJson;
	const body = { room_id: room };
	return [
		`<h1>Chat <span class="kind">${escapeHtml(room)}</span></h1>`,
		`<p class="note">An attached Submission Form still goes in through <code>aliquot intake</code> and stage 1, not through this box.</p>`,
		messages.length === 0
			? `<p class="empty">No Messages in ${escapeHtml(room)} yet.</p>`
			: `<ol class="chat">${messages.map(message).join("")}</ol>`,
		`<form id="chat-say" class="act" data-action="room-say" data-body="${escapeHtml(JSON.stringify(body))}"><textarea id="chat-body" name="body" required aria-label="Message to ${escapeHtml(room)}" placeholder="Say something to the whole team in ${escapeHtml(room)}"></textarea><button>Send as the Operator</button></form>`,
	].join("");
};

export const chatView: View = {
	name: "chat",
	title: "Chat",
	sources: ["chat"],
	render,
};
