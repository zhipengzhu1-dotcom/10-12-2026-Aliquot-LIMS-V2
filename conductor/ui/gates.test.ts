/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestGate } from "../src/gate/lifecycle.js";
import { AgentId, GateId } from "../src/ids.js";
import { type Serving, serve } from "../src/serve/http.js";
import { type Scenario, scenario } from "../src/test-support/scenario.js";
import { act, answerText } from "./actions.js";
import { definitionDiff, gatesView } from "./gates.js";
import { formOf, submit } from "./test-support.js";

const OPERATOR = { tag: "Operator" } as const;
const NOW = "2026-10-01T01:00:00.000Z";

let s: Scenario;
let serving: Serving;

beforeEach(async () => {
	s = scenario("2026-10-01T00:00:00.000Z");
	serving = await serve(s.ledger, { port: 0, bind: "127.0.0.1", ui: "." });
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

/** The Gates view as the shell draws it, with the page's clock at `now`. */
const gatesPage = async (now = NOW) => {
	const get = async (route: string) => (await fetch(`/api/${route}`)).json();
	const data = { ...(await gatesView.load?.(new URLSearchParams(), get)), now };
	return gatesView.render(gatesView, data);
};

/** Each Gate's id and state badge, in page order. */
const listed = (page: string) =>
	[
		...page.matchAll(
			/data-gate="([^"]+)">.*?class="badge state-[a-z]+">([A-Za-z]+)</g,
		),
	].map(([, id, state]) => `${id} ${state}`);

const section = (page: string, gate: string) =>
	new RegExp(
		`<article class="gate" data-gate="${gate}">(.*?)</article>`,
		"s",
	).exec(page)?.[1] ?? "";

const diffRows = (markup: string) =>
	[
		...markup.matchAll(
			/<tr><th>([^<]*)<\/th><td>([^<]*)<\/td><td>([^<]*)<\/td><\/tr>/g,
		),
	].map(([, field, now, proposed]) => [field, now, proposed]);

const hashOf = (gate: string) =>
	s.ledger.projections.gates.gates.get(GateId.parse(gate))?.payload_hash;

/**
 * G-1 RetireAgent and G-5 WriteSystemOfRecord stay Open; G-2 is approved,
 * G-3 rejected, and G-4's one-minute lifetime has run out.
 */
const fiveGates = () => {
	requestGate(s.ledger, {
		actor: OPERATOR,
		kind: "RetireAgent",
		payload: { agent_id: "A-bram", reason: "Duplicate of Ines" },
	});
	s.gate("PromoteToMentor", { agent_id: "A-rin" });
	s.decided(
		requestGate(s.ledger, {
			actor: OPERATOR,
			kind: "Deploy",
			payload: { app: "receiving" },
		}).gate.id,
		"reject",
	);
	requestGate(s.ledger, {
		actor: OPERATOR,
		kind: "ExternalMessage",
		payload: { to: "client" },
		lifetime_s: 60,
	});
	requestGate(s.ledger, {
		actor: { tag: "Agent", id: AgentId.parse("A-ines") },
		kind: "WriteSystemOfRecord",
		payload: { table: "Samples" },
	});
};

describe("the Gates view", () => {
	it("lists open Gates oldest first, then the decided and expired ones newest first", async () => {
		fiveGates();

		const page = await gatesPage();

		expect(listed(page)).toEqual([
			"G-1 Open",
			"G-5 Open",
			"G-4 Expired",
			"G-3 Rejected",
			"G-2 Approved",
		]);
		expect(page.indexOf("G-5")).toBeLessThan(
			page.indexOf("<h2>Decided and expired</h2>"),
		);
	});

	it("shows an open Gate's requester, age, lifetime and Task, and a RetireAgent Gate as the change to the Agent", async () => {
		fiveGates();

		const page = await gatesPage();

		const retire = section(page, "G-1");
		expect(retire).toContain("<dt>Requester</dt><dd>Operator</dd>");
		expect(retire).toContain("<dt>Age</dt><dd>1h 0m</dd>");
		expect(retire).toContain(
			"<dt>Lifetime</dt><dd>1d 0h, expires in 23h 0m</dd>",
		);
		expect(retire).toContain("<dt>Blocks</dt><dd>no Task</dd>");
		expect(diffRows(retire)).toEqual([["retired", "false", "true"]]);
		const write = section(page, "G-5");
		expect(write).toContain("<dd>A-ines</dd>");
		expect(write).not.toContain('class="diff"');
		expect(write).toContain("&quot;table&quot;: &quot;Samples&quot;");
	});

	it("signs approve and reject for the payload hash it read, and offers neither on a closed Gate", async () => {
		fiveGates();

		const page = await gatesPage();

		for (const decision of ["approve", "reject"]) {
			const form = formOf(page, `${decision}-G-1`);
			expect(form.verb).toBe("gate-decide");
			expect(JSON.parse(form.body)).toEqual({
				gate_id: "G-1",
				decision,
				hash: hashOf("G-1"),
			});
		}
		expect(page).not.toContain('id="approve-G-2"');
		expect(page).not.toContain('id="approve-G-4"');
	});

	it("escapes the payload it draws", async () => {
		requestGate(s.ledger, {
			actor: OPERATOR,
			kind: "ExternalMessage",
			payload: { body: "<img src=x onerror=alert(1)>" },
		});

		const page = await gatesPage();

		expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(page).not.toContain("<img");
	});
});

describe("the definition diff", () => {
	it("gives each field that differs, by its dotted path, with its value now and as proposed", () => {
		const rows = definitionDiff(
			{
				version: 1,
				name: "Rin",
				persona: { voice: "dry", traits: ["calm"] },
				supervisor_id: "A-pia",
			},
			{
				version: 2,
				name: "Rin",
				persona: { voice: "dry", traits: ["calm", "terse"] },
				retired: true,
			},
		);

		expect(rows).toEqual([
			{ field: "version", current: "1", proposed: "2" },
			{
				field: "persona.traits",
				current: '["calm"]',
				proposed: '["calm","terse"]',
			},
			{ field: "supervisor_id", current: "A-pia", proposed: "" },
			{ field: "retired", current: "", proposed: "true" },
		]);
	});
});

describe("the Gates view's actions", () => {
	it("shows the Ledger's refusal of a stale hash, and an approve with the hash it read moves the Gate to the decided list", async () => {
		fiveGates();
		const page = await gatesPage();
		const { verb, body } = formOf(page, "approve-G-1");
		const stale = hashOf("G-5");

		const refused = await act(verb, {
			...JSON.parse(body),
			hash: stale,
			reason: "Checked",
		});

		expect(answerText(refused)).toBe(
			`409: GateDecided refused: payload_hash ${stale} does not match G-1's payload, which hashes to ${hashOf("G-1")}; a changed payload needs a new Gate`,
		);

		s.at(NOW);
		const approved = await submit(page, "approve-G-1", [
			["reason", "Bram duplicates Ines"],
		]);

		expect(approved).toMatchObject({
			ok: true,
			event: {
				kind: "GateDecided",
				payload: {
					gate_id: "G-1",
					meaning: "approve",
					payload_hash: hashOf("G-1"),
					reason: "Bram duplicates Ines",
				},
			},
		});
		const after = await gatesPage();
		expect(listed(after)).toEqual([
			"G-5 Open",
			"G-1 Approved",
			"G-4 Expired",
			"G-3 Rejected",
			"G-2 Approved",
		]);
	});
});
