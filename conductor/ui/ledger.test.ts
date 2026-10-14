/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId } from "../src/ids.js";
import { type Ledger, openMemoryLedger } from "../src/ledger.js";
import { pause, resume } from "../src/org/lifecycle.js";
import { seedOrg } from "../src/org/seed.js";
import { type Serving, serve } from "../src/serve/http.js";
import {
	TEST_OPERATOR,
	TEST_OPERATOR_EMAIL,
} from "../src/test-support/operator.js";
import { orderRest, sample } from "../src/vitality/lifecycle.js";
import { type LedgerData, ledgerView, PAGE_SIZE } from "./ledger.js";

const OPERATOR = { tag: "Operator" } as const;
const RIN = AgentId.parse("A-rin");

let ledger: Ledger;
let serving: Serving;

beforeEach(async () => {
	ledger = openMemoryLedger();
	seedOrg(ledger, TEST_OPERATOR);
	serving = await serve(ledger, {
		port: 0,
		bind: "127.0.0.1",
		ui: ".",
		people: { tag: "Local", email: TEST_OPERATOR_EMAIL },
	});
});

afterEach(async () => {
	await serving.close();
	ledger.close();
});

const get = async (route: string) =>
	(await fetch(`${serving.url}/api/${route}`)).json();

const load = (hash: string, from = get) => {
	const loading = ledgerView.load;
	if (loading === undefined) throw new Error("the Ledger view loads its page");
	return loading(new URLSearchParams(hash), from) as Promise<LedgerData>;
};

const seqs = (page: string) =>
	[...page.matchAll(/<tr id="event-(\d+)">/g)].map(([, seq]) => Number(seq));

const causes = (page: string) =>
	Object.fromEntries(
		[
			...page.matchAll(
				/<tr id="event-(\d+)">(?:<td>.*?<\/td>){5}<td class="cause">(.*?)<\/td>/g,
			),
		].map(([, seq, cause]) => [seq, cause]),
	);

/** Pause and resume Rin until the Ledger holds `count` Events. */
const fill = (count: number) => {
	while (ledger.all().length < count) {
		const { paused } = ledger.projections.org.agents.get(RIN) ?? {};
		if (paused) resume(ledger, { actor: OPERATOR, agent_id: RIN });
		else pause(ledger, { actor: OPERATOR, agent_id: RIN, reason: "Retries" });
	}
};

describe("the Ledger view", () => {
	it("shows the newest page first, each Event's cause, and the chain's verdict", async () => {
		fill(60);
		const { seq: sampledAt } = sample(ledger, {
			actor: OPERATOR,
			agent: RIN,
			now: ledger.now(),
			energyBudgetTokens: 1000,
		});
		const { seq: restAt } = orderRest(ledger, {
			actor: OPERATOR,
			agent_id: RIN,
			action: "begin",
			reason: "Long shift",
		});

		const data = await load("");
		const page = ledgerView.render(ledgerView, data);

		expect(restAt).toBe(62);
		expect(seqs(page)).toEqual(
			Array.from({ length: PAGE_SIZE }, (_, i) => restAt - i),
		);
		expect(causes(page)).toMatchObject({
			[restAt]: `<a href="#/ledger?before=${sampledAt + 1}">${sampledAt}</a>`,
			[sampledAt]: "",
		});
		expect(page).toContain(
			"Ledger verified: 62 Events, chain intact. Checked at ",
		);
		expect(page).toContain('<a href="#/ledger?before=13">Older</a>');
		expect(page).not.toContain(">Newer<");
	});

	it("pages back by `before`, and the page links run both ways", async () => {
		fill(60);

		const page = ledgerView.render(ledgerView, await load("before=13"));

		expect(seqs(page)).toEqual(Array.from({ length: 12 }, (_, i) => 12 - i));
		expect(page).toContain('<a href="#/ledger">Newest</a>');
		expect(page).toContain('<a href="#/ledger">Newer</a>');
		expect(page).toContain("Events 1 to 12 of 60");
		expect(page).not.toContain(">Older<");
	});

	it("reads the last seq from the pages when the chain is broken", async () => {
		fill(20);
		const broken = { ok: false, seq: 4, reason: "hash mismatch" };

		const page = ledgerView.render(
			ledgerView,
			await load("", async (route) =>
				route === "ledger/verify" ? broken : get(route),
			),
		);

		expect(page).toContain("Ledger broken at seq 4: hash mismatch.");
		expect(seqs(page)[0]).toBe(20);
	});

	it("shows every payload as text, not markup", async () => {
		pause(ledger, {
			actor: OPERATOR,
			agent_id: RIN,
			reason: "<img src=x onerror=alert(1)>",
		});

		const page = ledgerView.render(ledgerView, await load(""));

		expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(page).not.toContain("<img");
	});
});
