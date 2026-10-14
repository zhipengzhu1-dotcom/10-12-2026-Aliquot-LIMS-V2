/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentId } from "../src/ids.js";
import { type Serving, serve } from "../src/serve/http.js";
import { TEST_OPERATOR_EMAIL } from "../src/test-support/operator.js";
import {
	type Scenario,
	scenario,
	scores,
} from "../src/test-support/scenario.js";
import { onLedgerEvent } from "./sse.js";
import { viewOf } from "./views.js";

/** An `EventSource` the test opens and closes, as a restarting Conductor would. */
class Stream {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;
	static opened: Stream[] = [];
	readyState = Stream.CONNECTING;
	onopen: (() => void) | null = null;
	onmessage: ((message: MessageEvent) => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(readonly url: string) {
		Stream.opened.push(this);
	}
}

const latest = () => {
	const stream = Stream.opened.at(-1);
	if (stream === undefined) throw new Error("no stream was opened");
	return stream;
};

let s: Scenario;
let serving: Serving;

const start = async () => {
	serving = await serve(s.ledger, {
		port: 0,
		bind: "127.0.0.1",
		ui: ".",
		people: { tag: "Local", email: TEST_OPERATOR_EMAIL },
	});
};

beforeEach(async () => {
	s = scenario("2026-10-01T00:00:00.000Z");
	await start();
	const direct = globalThis.fetch;
	vi.stubGlobal("fetch", (route: string, init?: RequestInit) =>
		direct(`${serving.url}${route}`, init),
	);
	Stream.opened = [];
	vi.stubGlobal("EventSource", Stream);
});

afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	await serving.close();
	s.close();
});

describe("the Event stream", () => {
	it("has a page that has read no Event show the Events appended while the stream was down", async () => {
		const flow = viewOf("#/flow");
		let shown = "";
		let drawing: Promise<void> = Promise.resolve();
		const refresh = () => {
			drawing = (async () => {
				const data = Object.fromEntries(
					await Promise.all(
						flow.sources.map(
							async (source) =>
								[source, await (await fetch(`/api/${source}`)).json()] as const,
						),
					),
				);
				shown = flow.render(flow, data, new URLSearchParams());
			})();
		};
		onLedgerEvent(refresh, refresh);
		refresh();
		await drawing;
		latest().readyState = Stream.OPEN;
		latest().onopen?.();
		await drawing;
		expect(shown, "no Task before the stream drops").not.toContain(
			'data-task="T-1"',
		);

		await serving.close();
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		latest().readyState = Stream.CLOSED;
		latest().onerror?.();
		const appended = s.reviewed(AgentId.parse("A-rin"), scores(3));
		await start();
		vi.advanceTimersByTime(2000);
		vi.useRealTimers();

		expect(Stream.opened, "a new stream after the closed one").toHaveLength(2);
		expect(latest().url, "the page has no seq to name").toBe("/api/events");
		latest().readyState = Stream.OPEN;
		latest().onopen?.();
		await drawing;
		expect(shown, "the Task appended while the stream was down").toContain(
			`data-task="${appended}"`,
		);
	});
});
