/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentId, RoomId } from "../src/ids.js";
import { open, say } from "../src/room/lifecycle.js";
import { seedRooms } from "../src/room/seed.js";
import { type Serving, serve } from "../src/serve/http.js";
import {
	TEST_OPERATOR,
	TEST_OPERATOR_EMAIL,
} from "../src/test-support/operator.js";
import { type Scenario, scenario } from "../src/test-support/scenario.js";
import { answerText } from "./actions.js";
import { chatView } from "./chat.js";
import { formOf, submit } from "./test-support.js";

const lab = RoomId.parse("RM-lab");
const odile = AgentId.parse("A-odile");

let s: Scenario;
let serving: Serving;

beforeEach(async () => {
	s = scenario("2026-10-13T09:00:00.000Z");
	seedRooms(s.ledger, TEST_OPERATOR);
	serving = await serve(s.ledger, {
		port: 0,
		bind: "127.0.0.1",
		ui: ".",
		people: { tag: "Local", email: TEST_OPERATOR_EMAIL },
	});
	const direct = globalThis.fetch;
	vi.stubGlobal("fetch", (route: string, init?: RequestInit) =>
		direct(`${serving.url}${route}`, init),
	);
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await serving.close();
	s.close();
});

/** The Chat view as the shell draws it: each source fetched, then rendered. */
const chatPage = async () => {
	const data = Object.fromEntries(
		await Promise.all(
			chatView.sources.map(
				async (route) =>
					[route, await (await fetch(`/api/${route}`)).json()] as const,
			),
		),
	);
	return chatView.render(chatView, data);
};

/** Each Message's seq, sayer and body, in page order. */
const listed = (page: string) =>
	[
		...page.matchAll(
			/<li class="message" data-seq="(\d+)"><div class="said"><b>(.*?)<\/b>.*?<p class="body">(.*?)<\/p>/g,
		),
	].map(
		([, seq, who, body]) => `${seq} ${who?.replace(/<[^>]+>/g, "")}: ${body}`,
	);

describe("the Chat view", () => {
	it("shows RM-lab's Messages newest last, each with the sayer's name, and no other Room's", async () => {
		open(s.ledger, {
			id: RoomId.parse("RM-side"),
			name: "Side",
			purpose: "Elsewhere",
			membership: { tag: "Listed", agents: [odile] },
			opened_by: { tag: "Operator" },
		});
		const first = say(s.ledger, {
			actor: TEST_OPERATOR,
			room_id: lab,
			body: "Received some samples from Acme",
		});
		say(s.ledger, {
			actor: { tag: "Agent", id: odile },
			room_id: RoomId.parse("RM-side"),
			body: "Not for the Lab Room",
		});
		const reply = say(s.ledger, {
			actor: { tag: "Agent", id: odile },
			room_id: lab,
			body: "Which product, Lot and Product Code? <b>",
			reply_to: first.seq,
		});

		const page = await chatPage();

		expect(listed(page)).toEqual([
			`${first.seq} operator@lab.test Operator: Received some samples from Acme`,
			`${reply.seq} Odile A-odile: Which product, Lot and Product Code? &lt;b&gt;`,
		]);
		expect(page).toContain(`seq ${reply.seq}, replying to seq ${first.seq}`);
		expect(page).toContain(
			"An attached Submission Form still goes in through <code>aliquot intake</code> and stage 1",
		);
	});

	it("sends the box's text to RM-lab as the Operator through room-say, and draws it last on the next redraw", async () => {
		say(s.ledger, {
			actor: { tag: "Agent", id: odile },
			room_id: lab,
			body: "Morning",
		});
		const before = await chatPage();
		expect(formOf(before, "chat-say").verb).toBe("room-say");

		const answer = await submit(before, "chat-say", [
			["body", "Received 3 bottles of Vitamin C 500 mg capsules, Lot 2403A"],
		]);

		expect(answerText(answer)).toMatch(/^Appended MessageSent at seq \d+$/);
		expect(s.events().at(-1)).toMatchObject({
			kind: "MessageSent",
			actor: TEST_OPERATOR,
			payload: {
				room_id: "RM-lab",
				body: "Received 3 bottles of Vitamin C 500 mg capsules, Lot 2403A",
			},
		});
		const after = listed(await chatPage());
		expect(after).toHaveLength(2);
		expect(after.at(-1)).toBe(
			`${s.events().at(-1)?.seq} operator@lab.test Operator: Received 3 bottles of Vitamin C 500 mg capsules, Lot 2403A`,
		);
	});

	it("says so when RM-lab has no Message yet", async () => {
		expect(await chatPage()).toContain(
			'<p class="empty">No Messages in RM-lab yet.</p>',
		);
	});
});
