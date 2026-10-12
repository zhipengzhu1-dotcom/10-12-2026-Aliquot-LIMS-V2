import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

let home: string;

const aliquot = (args: string[], input = "") =>
	spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--home", home, ...args],
		{ encoding: "utf8", input, env: { ...process.env, ALIQUOT_HOME: "" } },
	);
const room = (input: string, ...args: string[]) =>
	aliquot(["room", ...args], input);

const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g;

const PIA_RIN = JSON.stringify({
	id: "RM-pia-rin",
	name: "Pia and Rin",
	purpose: "Intake checklist for T-1",
	membership: { tag: "Listed", agents: ["A-pia", "A-rin"] },
	opened_by: { tag: "Agent", id: "A-pia" },
});

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-room-cli-"));
	aliquot(["org", "seed"]);
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("aliquot room", () => {
	it("opens the Lab Room once; a second seed appends nothing and exits 0", () => {
		const first = room("", "seed");
		const second = room("", "seed");
		const verified = aliquot(["ledger", "verify"]);

		expect(first.stderr).toBe("");
		expect(first.stdout).toBe("Opened RM-lab (Lab) for Everyone\n");
		expect(second.status).toBe(0);
		expect(second.stdout).toBe("RM-lab is already open, nothing appended\n");
		expect(verified.stdout).toBe("Ledger verified: 9 Events, chain intact\n");
		expect(room("", "list", "--as", "A-bram").stdout).toBe(
			"RM-lab  Lab  members: Everyone\n",
		);
	});

	it("opens a Listed Room, records Messages and a reply, and shows the history only to members", () => {
		room("", "seed");
		const opened = room(PIA_RIN, "open");
		const asked = room(
			"Row 4 has merged cells\n",
			"say",
			"RM-pia-rin",
			"--as",
			"A-rin",
		);
		const answered = room(
			"Unmerge them",
			"say",
			"RM-pia-rin",
			"--as",
			"A-pia",
			"--reply-to",
			"11",
		);
		const intruder = room("Let me in", "say", "RM-pia-rin", "--as", "A-bram");
		const asOperator = room("", "history", "RM-pia-rin");
		const asBram = room("", "history", "RM-pia-rin", "--as", "A-bram");

		expect(opened.stderr).toBe("");
		expect(opened.stdout).toBe(
			"Opened RM-pia-rin (Pia and Rin) for A-pia, A-rin\n",
		);
		expect(asked.stdout).toBe("11  A-rin in RM-pia-rin\n");
		expect(answered.stdout).toBe("12  A-pia in RM-pia-rin\n");
		expect(intruder.status).toBe(1);
		expect(intruder.stderr).toBe(
			"AppendRefused: MessageSent refused: A-bram is not a member of RM-pia-rin\n",
		);
		expect(asOperator.status).toBe(0);
		expect(asOperator.stdout.replace(ISO, "<ts>")).toBe(
			"11  <ts>  A-rin: Row 4 has merged cells\n12  <ts>  A-pia (reply to 11): Unmerge them\n",
		);
		expect(asBram.status).toBe(1);
		expect(asBram.stdout).toBe("");
		expect(asBram.stderr).toBe(
			"history refused: A-bram is not a member of RM-pia-rin\n",
		);
	});
});
