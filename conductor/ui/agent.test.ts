/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentId, RoomId, SkillId } from "../src/ids.js";
import { revise } from "../src/org/lifecycle.js";
import { open } from "../src/room/lifecycle.js";
import { seedRooms } from "../src/room/seed.js";
import { type Serving, serve } from "../src/serve/http.js";
import {
	type Scenario,
	scenario,
	scores,
} from "../src/test-support/scenario.js";
import {
	giveCoaching,
	publishSkill,
	recordMemoryNote,
} from "../src/training/lifecycle.js";
import { answerText, bodyOf } from "./actions.js";
import { agentView } from "./agent.js";
import { formOf, submit, textareaOf } from "./test-support.js";

const OPERATOR = { tag: "Operator" } as const;
const RIN = AgentId.parse("A-rin");

let s: Scenario;
let serving: Serving;

beforeEach(async () => {
	s = scenario("2026-10-01T00:00:00.000Z");
	seedRooms(s.ledger);
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

const get = async (route: string) => (await fetch(`/api/${route}`)).json();

/** The Agent view as the shell draws it for `#/agent?<query>`. */
const agentPage = async (query = "id=A-rin") =>
	agentView.render(
		agentView,
		(await agentView.load?.(new URLSearchParams(query), get)) ?? {},
	);

const sectionOf = (page: string, id: string) =>
	new RegExp(`<section id="${id}">(.*?)</section>`, "s").exec(page)?.[1] ?? "";

const definitionOf = (id: AgentId) => {
	const agent = s.ledger.projections.org.agents.get(id);
	if (agent === undefined) throw new Error(`${id} is not in the Org`);
	return agent.definition;
};

/** Rin with two Reviews, one Memory note, one Coaching and one Skill. */
const trainedRin = () => {
	const first = s.reviewed(RIN, scores(3));
	const second = s.reviewed(RIN, scores(2, { timeliness: 1 }));
	recordMemoryNote(s.ledger, {
		actor: { tag: "Agent", id: RIN },
		agent: RIN,
		task_id: first,
		lesson: "Check the seal before logging",
		applies_to: ["receipt"],
	});
	giveCoaching(s.ledger, {
		actor: OPERATOR,
		agent_id: RIN,
		task_id: second,
		note: "Name the blocker sooner",
	});
	const skill = SkillId.parse("receipt-checks");
	publishSkill(s.ledger, {
		actor: OPERATOR,
		id: skill,
		title: "Receipt checks",
		body_md: "Check the seal.",
	});
	const rin = definitionOf(RIN);
	revise(s.ledger, {
		actor: OPERATOR,
		definition: {
			...rin,
			version: rin.version + 1,
			skills: [...rin.skills, skill],
			revised_by: OPERATOR,
			revision_reason: "Grant receipt checks",
		},
	});
	return { first, second };
};

const reviewRows = (merit: string) =>
	[...merit.matchAll(/<tr><td>(T-\d+)<\/td><td>[^<]*<\/td>(.*?)<\/tr>/g)].map(
		([, task, cells = ""]) => [
			task,
			...[...cells.matchAll(/<td>([^<]*)<\/td>/g)].map(([, c]) => c),
		],
	);

describe("the Agent view", () => {
	it("draws the Charter, Persona, Vitality, Merit after each Review, Memory notes, Coaching and Skills", async () => {
		const { first, second } = trainedRin();
		const rin = definitionOf(RIN);
		const vitality = (await get("vitality"))["A-rin"];

		const page = await agentPage();

		expect(sectionOf(page, "charter")).toContain(rin.charter.purpose);
		expect(sectionOf(page, "persona")).toContain(
			`<dt>Voice</dt><dd>${rin.persona.voice}</dd>`,
		);
		const vitalityShown = sectionOf(page, "vitality");
		expect(vitalityShown).toContain(
			`<span class="badge mood-${vitality.mood}">${vitality.mood}</span>`,
		);
		expect(vitalityShown).toContain(
			`<dt>schedulable</dt><dd>${vitality.policy.schedulable ? "yes" : "no"}</dd>`,
		);
		const merit = sectionOf(page, "merit");
		expect(merit).toContain("Merit 2.40 over 2 reviewed Tasks");
		expect(reviewRows(merit)).toEqual([
			[first, "3", "3", "3", "3", "3", "3.00", ""],
			[second, "2", "2", "2", "2", "1", "2.40", ""],
		]);
		expect(merit.match(/<circle /g)).toHaveLength(2);
		expect(sectionOf(page, "notes")).toContain(
			`on ${first} (applies to receipt): Check the seal before logging`,
		);
		expect(sectionOf(page, "coaching")).toContain(
			`on ${second}: Name the blocker sooner`,
		);
		expect(sectionOf(page, "skills")).toMatch(
			/<b>receipt-checks<\/b> version 1: Receipt checks \(versions 1 at seq \d+\)/,
		);
	});

	it("draws a point for each of 21 reviewed Tasks, past the Merit window", async () => {
		const first = s.reviewed(RIN, scores(0));
		s.reviewed(AgentId.parse("A-bram"), scores(1));
		for (let i = 0; i < 20; i++) s.reviewed(RIN, scores(3));

		const merit = sectionOf(await agentPage(), "merit");

		expect(merit).toContain("Merit 3.00 over 21 reviewed Tasks");
		const rows = reviewRows(merit);
		expect(rows, "one row per Review of Rin's").toHaveLength(21);
		expect(rows[0], "the Review outside the window").toEqual([
			first,
			"0",
			"0",
			"0",
			"0",
			"0",
			"0.00",
			"",
		]);
		expect(rows.at(-1)?.[6], "Merit over the last 20 Tasks").toBe("3.00");
		expect(merit.match(/<circle /g)).toHaveLength(21);
	});

	it("reads the Training Projection from /api/training", async () => {
		trainedRin();

		const training = await get("training");

		expect(training).toMatchObject({
			notes: { "A-rin": [{ lesson: "Check the seal before logging" }] },
			coaching: { "A-rin": [{ note: "Name the blocker sooner" }] },
			skills: { "receipt-checks": [{ version: 1, title: "Receipt checks" }] },
		});
	});

	it("lists the Agents without an id, and says so for an Agent not in the Org", async () => {
		expect(await agentPage("")).toContain('<a href="#/agent?id=A-rin">Rin</a>');
		expect(await agentPage("id=A-nobody")).toContain(
			'<p role="alert">A-nobody is not in the Org.</p>',
		);
	});

	it("escapes the definition it draws", async () => {
		const rin = definitionOf(RIN);
		revise(s.ledger, {
			actor: OPERATOR,
			definition: {
				...rin,
				version: rin.version + 1,
				persona: { ...rin.persona, quirk: "<img src=x onerror=alert(1)>" },
				revised_by: OPERATOR,
				revision_reason: "Quirk",
			},
		});

		const page = await agentPage();

		expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(page).not.toContain("<img");
	});
});

describe("the Agent view's actions", () => {
	it("opens the Agent's Room once, then goes to it", async () => {
		open(s.ledger, {
			id: RoomId.parse("RM-pair"),
			name: "Pair",
			purpose: "Rin and Ines",
			membership: { tag: "Listed", agents: [RIN, AgentId.parse("A-ines")] },
			opened_by: OPERATOR,
		});
		const page = await agentPage();
		expect(page).toContain('data-go="#/rooms?id=RM-rin"');

		const opened = await submit(page, "room-open-A-rin");

		expect(opened).toMatchObject({
			ok: true,
			event: {
				kind: "RoomOpened",
				payload: {
					room: {
						id: "RM-rin",
						opened_by: OPERATOR,
						membership: { tag: "Listed", agents: ["A-rin"] },
					},
				},
			},
		});
		const after = await agentPage();
		expect(after).toContain(
			'<a id="room-A-rin" href="#/rooms?id=RM-rin">Open Rin&#39;s Room (RM-rin)</a>',
		);
		expect(after).not.toContain('id="room-open-A-rin"');
		expect(answerText(await submit(page, "room-open-A-rin"))).toBe(
			"409: RoomOpened refused: RM-rin is already open",
		);
	});

	it("posts a Revision from the editor, and shows the refusal of one at the current version", async () => {
		const page = await agentPage();
		const drawn = JSON.parse(textareaOf(page, "revise-A-rin-definition"));
		expect(drawn).toMatchObject({ version: 2, revised_by: OPERATOR });
		expect(drawn).not.toHaveProperty("revision_reason");

		const same = await submit(page, "revise-A-rin", [
			["definition", JSON.stringify({ ...drawn, version: 1 })],
			["definition.revision_reason", "Tighter escalation"],
		]);

		expect(answerText(same)).toBe(
			"409: AgentDefinitionRevised refused: A-rin is at version 1, so its next Revision is version 2, not 1",
		);

		const next = await submit(page, "revise-A-rin", [
			["definition", JSON.stringify({ ...drawn, capacity: 3 })],
			["definition.revision_reason", "Room for one more Task"],
		]);

		expect(next).toMatchObject({
			ok: true,
			event: {
				kind: "AgentDefinitionRevised",
				payload: {
					definition: {
						id: "A-rin",
						version: 2,
						capacity: 3,
						revision_reason: "Room for one more Task",
					},
				},
			},
		});
		expect(await agentPage()).toContain("A-rin, version 2");
	});

	it("gives Coaching, which appends HumanCoached and appears under Coaching", async () => {
		const page = await agentPage();
		expect(formOf(page, "coach-A-rin").verb).toBe("coach");

		const coached = await submit(page, "coach-A-rin", [
			["note", "Say when a scan is unreadable"],
			["task_id", ""],
		]);

		expect(coached).toMatchObject({
			ok: true,
			event: {
				kind: "HumanCoached",
				actor: OPERATOR,
				payload: { agent_id: "A-rin", note: "Say when a scan is unreadable" },
			},
		});
		expect(coached.ok && coached.event.payload).not.toHaveProperty("task_id");
		expect(sectionOf(await agentPage(), "coaching")).toContain(
			"Say when a scan is unreadable",
		);
	});

	it("says which field is not JSON instead of posting it", () => {
		expect(() =>
			bodyOf("{}", [["definition", "{ version: 2"]], new Set(["definition"])),
		).toThrow(/^definition is not JSON: /);
	});
});
