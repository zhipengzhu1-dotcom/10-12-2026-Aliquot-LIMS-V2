/// <reference types="node" />
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RoomId } from "../src/ids.js";
import { type Ledger, openLedger } from "../src/ledger.js";
import { say } from "../src/room/lifecycle.js";
import { type Serving, serve } from "../src/serve/http.js";
import { Email, person } from "../src/types/actor.js";
import { operatorOf } from "./access.js";
import { type LedgerData, ledgerView } from "./ledger.js";

const ADA = Email.parse("ada@lab.test");

let home: string;
let ledger: Ledger;
let serving: Serving;

/** Serve a copy of the Ledger slice-1 wrote at f631888, before #74, as Ada. */
const serveSlice1 = async () => {
	home = mkdtempSync(join(tmpdir(), "aliquot-ui-operator-"));
	copyFileSync(
		fileURLToPath(
			new URL("../src/test-support/ledger-f631888.sqlite", import.meta.url),
		),
		join(home, "ledger.sqlite"),
	);
	ledger = openLedger({ home, writer: true });
	serving = await serve(ledger, {
		port: 0,
		bind: "127.0.0.1",
		ui: ".",
		people: { tag: "Local", email: ADA },
	});
};

afterEach(async () => {
	await serving.close();
	ledger.close();
	rmSync(home, { recursive: true, force: true });
});

const get = async (route: string) =>
	(await fetch(`${serving.url}/api/${route}`)).json();

const actorCell = (page: string, seq: number) =>
	new RegExp(`<tr id="event-${seq}">(?:<td>.*?</td>){2}<td>(.*?)</td>`).exec(
		page,
	)?.[1];

describe("the Ledger view on a Ledger written before #74", () => {
	it("shows its Operator's Events as the unnamed Operator, and a new act by the person's email", async () => {
		await serveSlice1();
		say(ledger, {
			actor: person(ADA),
			room_id: RoomId.parse("RM-lab"),
			body: "Results follow",
		});

		const load = ledgerView.load;
		if (load === undefined) throw new Error("the Ledger view loads its page");
		const data = (await load(new URLSearchParams(""), get)) as LedgerData;
		const page = ledgerView.render(ledgerView, data);

		expect(page).toContain("Ledger verified: 102 Events, chain intact");
		expect(actorCell(page, 101), "the old GateDecided").toBe(
			"Operator (unnamed)",
		);
		expect(actorCell(page, 99), "the old Message").toBe("Operator (unnamed)");
		expect(actorCell(page, 102), "the new Message").toBe("ada@lab.test");
	});
});

describe("the Access landing", () => {
	it("names the person /api/operator answers with", async () => {
		await serveSlice1();

		expect(operatorOf(await get("operator"))).toBe("ada@lab.test");
		expect(operatorOf({}), "an answer without an email").toBe(
			"Operator (unnamed)",
		);
	});
});
