/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentId } from "../src/ids.js";
import { type Ledger, openMemoryLedger } from "../src/ledger.js";
import { pause, revise } from "../src/org/lifecycle.js";
import { seedOrg } from "../src/org/seed.js";
import { type Serving, serve } from "../src/serve/http.js";
import { act, answerText, bodyOf } from "./actions.js";
import { orgView } from "./org.js";

const OPERATOR = { tag: "Operator" } as const;
const RIN = AgentId.parse("A-rin");

let ledger: Ledger;
let serving: Serving;

beforeEach(async () => {
	ledger = openMemoryLedger();
	seedOrg(ledger);
	serving = await serve(ledger, { port: 0, bind: "127.0.0.1", ui: "." });
	const direct = globalThis.fetch;
	vi.stubGlobal("fetch", (route: string, init?: RequestInit) =>
		direct(`${serving.url}${route}`, init),
	);
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await serving.close();
	ledger.close();
});

const sampled = (
	agent: string,
	v: Partial<{
		load: number;
		fatigue: number;
		morale: number;
		confidence: number;
	}>,
) =>
	ledger.append({
		actor: OPERATOR,
		kind: "VitalitySampled",
		payload: {
			agent: AgentId.parse(agent),
			load: 0,
			fatigue: 0,
			friction: 0,
			confidence: 1,
			morale: 0,
			...v,
		},
	});

/** The Org view as the shell draws it: from the routes it reads. */
const orgPage = async () => {
	const data = Object.fromEntries(
		await Promise.all(
			orgView.sources.map(async (s) => [
				s,
				await (await fetch(`/api/${s}`)).json(),
			]),
		),
	);
	return orgView.render(orgView, data);
};

const fromHtml = (text: string) =>
	text
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");

/** Submit the form `<verb>-<agent>` on `page` as the shell does, with `fields` filled in. */
const submit = (
	page: string,
	verb: string,
	agent: string,
	fields: [string, string][] = [],
) => {
	const found = new RegExp(
		`<form id="${verb}-${agent}" data-action="([^"]+)" data-body="([^"]*)">`,
	).exec(page);
	if (found === null)
		throw new Error(`the page has no ${verb} form for ${agent}`);
	return act(found[1] as string, bodyOf(fromHtml(found[2] as string), fields));
};

/** Each node of the tree as `<depth spaces><label>`, in document order. */
const outline = (page: string) => {
	const lines: string[] = [];
	let depth = 0;
	for (const [token, node, agent] of page.matchAll(
		/<ul[ >]|<\/ul>|<div class="(?:operator|pool)">([^<]*)|<div class="agent"[^>]*><a [^>]*>([^<]*)/g,
	)) {
		if (token.startsWith("<ul")) depth += 1;
		else if (token === "</ul>") depth -= 1;
		else lines.push(`${"  ".repeat(depth - 1)}${node ?? agent}`);
	}
	return lines;
};

/** Each Agent's Mood, Trust tier, load bar value and paused badge. */
const badges = (page: string) =>
	Object.fromEntries(
		[
			...page.matchAll(
				/<div class="agent" data-agent="([^"]+)">(.*?)<details/g,
			),
		].map(([, id, line = ""]) => [
			id,
			{
				mood: /class="badge mood-[^"]+">([^<]+)/.exec(line)?.[1],
				tier: /class="badge tier">([^<]+)/.exec(line)?.[1],
				load: /<meter[^>]* value="([^"]+)"/.exec(line)?.[1],
				paused: line.includes('class="badge paused"'),
			},
		]),
	);

describe("the Org view", () => {
	it("draws the tree in `org tree`'s order with each Agent's Mood, Trust tier and load", async () => {
		sampled("A-pia", { load: 0.75 });
		sampled("A-ines", { load: 1.2 });
		sampled("A-bram", { load: 0.3, morale: -0.5, confidence: 0.5 });
		sampled("A-rin", { load: 0.45 });
		pause(ledger, {
			actor: OPERATOR,
			agent_id: AgentId.parse("A-thorne"),
			reason: "Audit window",
		});

		const page = await orgPage();

		expect(outline(page)).toEqual([
			"Operator",
			"  Odile",
			"    Pia",
			"    Anselm",
			"    Specialist pool, reports to Pia and Anselm",
			"      Rin",
			"      Ines",
			"      Bram",
			"  Mabel",
			"  Thorne",
		]);
		const probation = { tier: "Probation", paused: false };
		expect(badges(page)).toEqual({
			"A-odile": { ...probation, mood: "fresh", load: "0" },
			"A-pia": { ...probation, mood: "strained", load: "0.75" },
			"A-anselm": { ...probation, mood: "fresh", load: "0" },
			"A-rin": { ...probation, mood: "fresh", load: "0.45" },
			"A-ines": { ...probation, mood: "overloaded", load: "1.2" },
			"A-bram": { ...probation, mood: "discouraged", load: "0.3" },
			"A-mabel": { ...probation, mood: "fresh", load: "0" },
			"A-thorne": { tier: "Probation", paused: true, mood: "fresh", load: "0" },
		});
	});

	it("offers resume for a paused Agent, pause for a running one, and no supervisor that reports to the Agent", async () => {
		pause(ledger, {
			actor: OPERATOR,
			agent_id: AgentId.parse("A-thorne"),
			reason: "Audit window",
		});

		const page = await orgPage();

		expect(page).toContain('<form id="resume-A-thorne"');
		expect(page).not.toContain('<form id="pause-A-thorne"');
		expect(page).toContain('<form id="pause-A-rin"');
		const odileChoices =
			/<select id="revise-A-odile-supervisor"[^>]*>(.*?)<\/select>/.exec(
				page,
			)?.[1];
		expect(odileChoices).toBe('<option value="">Operator</option>');
		const pinChoices =
			/<select id="revise-A-rin-supervisor"[^>]*>(.*?)<\/select>/.exec(
				page,
			)?.[1];
		expect(pinChoices).toContain(
			'<option value="A-pia" selected>Pia, Supervisor</option>',
		);
	});

	it("escapes every name it draws", async () => {
		const rin = ledger.projections.org.agents.get(RIN)?.definition;
		if (rin === undefined) throw new Error("the seed has no A-rin");
		revise(ledger, {
			actor: OPERATOR,
			definition: { ...rin, version: 2, name: "<img src=x onerror=alert(1)>" },
		});

		const page = await orgPage();

		expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(page).not.toContain("<img");
	});
});

describe("the Org view's actions", () => {
	it("pause and resume append AgentPaused and AgentResumed, and resuming again shows the refusal", async () => {
		const paused = await submit(await orgPage(), "pause", "A-rin", [
			["reason", "Retries pile up"],
		]);
		expect(paused).toMatchObject({
			ok: true,
			event: {
				kind: "AgentPaused",
				payload: { agent_id: "A-rin", reason: "Retries pile up" },
			},
		});

		const stale = await orgPage();
		const resumed = await submit(stale, "resume", "A-rin");
		expect(resumed).toMatchObject({
			ok: true,
			event: { kind: "AgentResumed", payload: { agent_id: "A-rin" } },
		});

		const again = await submit(stale, "resume", "A-rin");
		expect(answerText(again)).toBe(
			"409: AgentResumed refused: A-rin is not paused",
		);
	});

	it("retire requests a RetireAgent Gate the Gates view reads", async () => {
		const requested = await submit(
			await orgPage(),
			"retire-request",
			"A-bram",
			[["reason", "Duplicate of Ines"]],
		);

		expect(requested).toMatchObject({
			ok: true,
			event: { kind: "GateRequested" },
		});
		const gates = await (await fetch("/api/gates")).json();
		expect(Object.values(gates.gates)).toMatchObject([
			{
				kind: "RetireAgent",
				payload: { agent_id: "A-bram", reason: "Duplicate of Ines" },
			},
		]);
	});

	it("reassign revises supervisor_id, and the tree moves the Agent", async () => {
		const page = await orgPage();

		const moved = await submit(page, "revise", "A-mabel", [
			["definition.supervisor_id", "A-odile"],
			["definition.revision_reason", "Reports to the Director"],
		]);
		expect(moved).toMatchObject({
			ok: true,
			event: {
				kind: "AgentDefinitionRevised",
				payload: {
					definition: {
						id: "A-mabel",
						version: 2,
						supervisor_id: "A-odile",
						revised_by: OPERATOR,
						revision_reason: "Reports to the Director",
					},
				},
			},
		});
		expect(outline(await orgPage())).toContain("    Mabel");

		const back = await submit(await orgPage(), "revise", "A-mabel", [
			["definition.supervisor_id", ""],
			["definition.revision_reason", "Back under the Operator"],
		]);
		expect(back).toMatchObject({
			ok: true,
			event: { payload: { definition: { version: 3 } } },
		});
		expect(back.ok && back.event.payload).not.toHaveProperty(
			"definition.supervisor_id",
		);
		expect(outline(await orgPage())).toContain("  Mabel");
	});
});
