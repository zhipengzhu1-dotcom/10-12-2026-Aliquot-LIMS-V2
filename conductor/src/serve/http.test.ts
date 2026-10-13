import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event } from "../events.js";
import { AgentId } from "../ids.js";
import { type Ledger, openMemoryLedger } from "../ledger.js";
import { seedOrg } from "../org/seed.js";
import { seedRooms } from "../room/seed.js";
import { type Serving, serve } from "./http.js";
import { PROJECTION_ROUTES } from "./routes.js";

let dir: string;
let ledger: Ledger;
let serving: Serving;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "aliquot-serve-"));
	mkdirSync(join(dir, "ui"));
	writeFileSync(join(dir, "ui", "index.html"), "<title>Aliquot</title>");
	writeFileSync(join(dir, "secret.html"), "not the interface");
	ledger = openMemoryLedger();
	seedOrg(ledger);
	seedRooms(ledger);
	serving = await serve(ledger, {
		port: 0,
		bind: "127.0.0.1",
		ui: join(dir, "ui"),
	});
});

afterEach(async () => {
	await serving.close();
	ledger.close();
	rmSync(dir, { recursive: true, force: true });
});

const get = async (path: string) => {
	const res = await fetch(`${serving.url}${path}`);
	return { status: res.status, text: await res.text() };
};

const post = (verb: string, body: unknown, contentType = "application/json") =>
	fetch(`${serving.url}/api/actions/${verb}`, {
		method: "POST",
		headers: { "content-type": contentType },
		body: JSON.stringify(body),
	});

/** A raw request, for a Host or a path that `fetch` would rewrite. */
const raw = (path: string, headers: Record<string, string> = {}) =>
	new Promise<{ status: number; body: string }>((done, fail) => {
		const url = new URL(serving.url);
		request({ host: url.hostname, port: url.port, path, headers }, (res) => {
			let body = "";
			res.on("data", (chunk) => {
				body += chunk;
			});
			res.on("end", () => done({ status: res.statusCode ?? 0, body }));
		})
			.on("error", fail)
			.end();
	});

/** `/api/events`, read one Server-Sent Event at a time. */
const openStream = async (headers: Record<string, string> = {}, query = "") => {
	const abort = new AbortController();
	const res = await fetch(`${serving.url}/api/events${query}`, {
		headers,
		signal: abort.signal,
	});
	const body = res.body;
	if (body === null) throw new Error("the Event stream has no body");
	const reader = body.pipeThrough(new TextDecoderStream()).getReader();
	let buffered = "";
	const next = async (): Promise<{ id: string; event: Event }> => {
		for (;;) {
			const end = buffered.indexOf("\n\n");
			if (end >= 0) {
				const block = buffered.slice(0, end);
				buffered = buffered.slice(end + 2);
				const field = (name: string) =>
					block
						.split("\n")
						.find((line) => line.startsWith(`${name}: `))
						?.slice(name.length + 2);
				const data = field("data");
				if (data === undefined) continue;
				return { id: field("id") ?? "", event: JSON.parse(data) as Event };
			}
			const { value, done } = await reader.read();
			if (done) throw new Error("the Event stream ended");
			buffered += value;
		}
	};
	return { res, next, close: () => abort.abort() };
};

describe("aliquot serve: Projections", () => {
	it("GET /api/org returns the Org Projection, each Agent by id", async () => {
		const { status, text } = await get("/api/org");

		expect(status).toBe(200);
		const org = JSON.parse(text);
		expect(Object.keys(org.agents)).toEqual([
			"A-odile",
			"A-mabel",
			"A-thorne",
			"A-pia",
			"A-anselm",
			"A-rin",
			"A-ines",
			"A-bram",
		]);
		expect(org.agents["A-rin"]).toMatchObject({
			definition: { name: "Rin", role: "Specialist", version: 1 },
			paused: false,
			retired: false,
		});
	});

	it("every Projection route answers JSON", async () => {
		const names = Object.keys(PROJECTION_ROUTES);
		const answers = Object.fromEntries(
			await Promise.all(
				names.map(async (name) => {
					const { status, text } = await get(`/api/${name}`);
					return [name, { status, json: JSON.parse(text) as unknown }];
				}),
			),
		);

		expect(names.filter((name) => answers[name]?.status !== 200)).toEqual([]);
		expect(answers).toMatchObject({
			rooms: { json: { rooms: { "RM-lab": { name: "Lab" } } } },
			tiers: { json: { "A-rin": { tier: "Probation" } } },
			vitality: { json: { "A-rin": { sampled: false, tier: "Probation" } } },
		});
		expect(answers.tasks?.json).toMatchObject({ tasks: {} });
		expect(answers.gates?.json).toEqual({ gates: {} });
	});

	it("answers 404 for a Projection the Ledger does not keep", async () => {
		const { status, text } = await get("/api/toString");

		expect(status).toBe(404);
		expect(text).toBe("no route /api/toString\n");
	});

	it("pages the Ledger's Events by ?from and ?limit", async () => {
		const page = JSON.parse((await get("/api/ledger?from=3&limit=2")).text);
		const last = JSON.parse((await get("/api/ledger?from=9")).text);
		const tooMany = await get("/api/ledger?limit=1001");

		expect(page.events.map((e: Event) => e.seq)).toEqual([3, 4]);
		expect(page.next).toBe(5);
		expect(last.events.map((e: Event) => e.kind)).toEqual(["RoomOpened"]);
		expect(last.next).toBeNull();
		expect(tooMany.status).toBe(400);
		expect(tooMany.text).toBe("limit must be 1 to 1000\n");
	});
});

describe("aliquot serve: Events over SSE", () => {
	it("streams an Event an action appends, with its seq as the event id", async () => {
		const stream = await openStream();

		const answer = await post("pause", { agent_id: "A-rin", reason: "Tired" });
		const streamed = await stream.next();
		stream.close();

		expect(stream.res.headers.get("content-type")).toBe("text/event-stream");
		const appended = (await answer.json()) as Event;
		expect(appended).toMatchObject({ seq: 10, kind: "AgentPaused" });
		expect(streamed.id).toBe("10");
		expect(streamed.event).toEqual(appended);
	});

	it("replays what a client missed when it reconnects with Last-Event-ID", async () => {
		const first = await openStream();
		await post("pause", { agent_id: "A-rin", reason: "Tired" });
		const { id } = await first.next();
		first.close();
		await post("resume", { agent_id: "A-rin" });
		await post("pause", { agent_id: "A-ines", reason: "Scans" });

		const again = await openStream({ "last-event-id": id });
		const replayed = [await again.next(), await again.next()];
		await post("resume", { agent_id: "A-ines" });
		const live = await again.next();
		again.close();

		expect(replayed.map((r) => [r.id, r.event.kind])).toEqual([
			["11", "AgentResumed"],
			["12", "AgentPaused"],
		]);
		expect([live.id, live.event.kind]).toEqual(["13", "AgentResumed"]);
	});

	it("replays from ?lastEventId=, for a page that opens a new stream", async () => {
		await post("pause", { agent_id: "A-rin", reason: "Tired" });

		const stream = await openStream({}, "?lastEventId=9");
		const replayed = await stream.next();
		stream.close();

		expect([replayed.id, replayed.event.kind]).toEqual(["10", "AgentPaused"]);
	});

	it("streams nothing for a refused action", async () => {
		const stream = await openStream();

		const refused = await post("resume", { agent_id: "A-rin" });
		await post("pause", { agent_id: "A-rin", reason: "Tired" });
		const streamed = await stream.next();
		stream.close();

		expect(refused.status).toBe(409);
		expect(streamed.event.kind).toBe("AgentPaused");
	});
});

describe("aliquot serve: requests", () => {
	it("answers 400 for a body that does not fit the action, and 404 for no action", async () => {
		const missing = await post("pause", { agent_id: "A-rin" });
		const unknown = await post("promote", { agent_id: "A-rin" });

		expect(missing.status).toBe(400);
		expect(await missing.text()).toContain("pause takes a different body");
		expect(unknown.status).toBe(404);
		expect(ledger.all()).toHaveLength(9);
	});

	it("refuses an action posted as anything but JSON, which a cross-site form could send", async () => {
		const res = await post(
			"pause",
			{ agent_id: "A-rin", reason: "Tired" },
			"text/plain",
		);

		expect(res.status).toBe(400);
		expect(
			ledger.projections.org.agents.get(AgentId.parse("A-rin"))?.paused,
		).toBe(false);
	});

	it("answers 403 to a request for another host", async () => {
		const rebound = await raw("/api/org", { host: "conductor.example:80" });

		expect(rebound.status).toBe(403);
	});

	it("serves the interface and nothing outside it", async () => {
		const index = await get("/");
		const outside = await raw("/../secret.html");
		const encoded = await raw("/%2e%2e/secret.html");

		expect(index.text).toBe("<title>Aliquot</title>");
		expect(outside.status).toBe(404);
		expect(encoded.status).toBe(404);
	});
});
