import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OPERATOR_UNNAMED } from "./cli-support.js";
import { openLedger, verifyLedger } from "./ledger.js";
import { actorName } from "./types/actor.js";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));

/** A Ledger written by `workflow run`, `room say` and `gate decide` at slice-1's f631888, before #74. */
const SLICE_1_LEDGER = fileURLToPath(
	new URL("./test-support/ledger-f631888.sqlite", import.meta.url),
);

let home: string;

/** The command line with no person in its environment unless `env` names one. */
const aliquot = (
	args: string[],
	{
		env = {},
		input = "",
	}: { env?: Record<string, string>; input?: string } = {},
) => {
	const { ALIQUOT_OPERATOR: _, ...rest } = process.env;
	return spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--home", home, ...args],
		{ encoding: "utf8", input, env: { ...rest, ALIQUOT_HOME: "", ...env } },
	);
};

const events = () => {
	const ledger = openLedger({ home, writer: false });
	try {
		return ledger.all();
	} finally {
		ledger.close();
	}
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-operator-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("a command that acts as the Operator", () => {
	it("is refused in one line naming --operator and ALIQUOT_OPERATOR when it names no person, and writes nothing", () => {
		const result = aliquot(["org", "seed"]);

		expect(result.status, "refused, not a usage error").toBe(1);
		expect(result.stderr).toBe(`error: ${OPERATOR_UNNAMED}\n`);
		expect(OPERATOR_UNNAMED).toContain("--operator <email>");
		expect(OPERATOR_UNNAMED).toContain("ALIQUOT_OPERATOR");
		expect(existsSync(join(home, "ledger.sqlite")), "no Ledger written").toBe(
			false,
		);
	});

	it("names the person --operator gives, lowercased, on the Event's actor", () => {
		const result = aliquot([
			"org",
			"seed",
			"--operator",
			"Ada.Lovelace@Lab.Test",
		]);

		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		const recruited = events();
		expect(recruited).toHaveLength(8);
		for (const event of recruited) {
			expect(event.actor).toEqual({
				tag: "Operator",
				email: "ada.lovelace@lab.test",
			});
		}
	});

	it("takes the person from ALIQUOT_OPERATOR, and --operator wins over it", () => {
		aliquot(["org", "seed"], { env: { ALIQUOT_OPERATOR: "ada@lab.test" } });
		aliquot(
			[
				"org",
				"pause",
				"A-rin",
				"--reason",
				"Retries",
				"--operator=bo@lab.test",
			],
			{
				env: { ALIQUOT_OPERATOR: "ada@lab.test" },
			},
		);

		const [first, ...rest] = events();
		expect(first?.actor).toEqual({ tag: "Operator", email: "ada@lab.test" });
		expect(rest.at(-1)?.kind).toBe("AgentPaused");
		expect(rest.at(-1)?.actor).toEqual({
			tag: "Operator",
			email: "bo@lab.test",
		});
	});

	it("refuses a value that is not an email as a usage error", () => {
		const result = aliquot(["org", "seed", "--operator", "Ada"]);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain(
			'--operator must be the person\'s email, not "Ada"',
		);
	});

	it("names the deciding person on a Gate's decision, actor and decided_by alike", () => {
		const env = { ALIQUOT_OPERATOR: "ada@lab.test" };
		aliquot(["org", "seed"], { env });
		const requested = aliquot(
			[
				"gate",
				"request",
				"--kind",
				"Deploy",
				"--payload",
				"-",
				"--as",
				"A-bram",
			],
			{ input: '{"release":"x"}' },
		);
		expect(requested.status, "an Agent's act needs no person").toBe(0);
		const hash = requested.stdout.trim().split(" ")[1] ?? "";

		const decided = aliquot(
			[
				"gate",
				"decide",
				"G-1",
				"--approve",
				"--hash",
				hash,
				"--reason",
				"checked",
			],
			{ env: { ALIQUOT_OPERATOR: "bo@lab.test" } },
		);

		expect(decided.status).toBe(0);
		const decision = events().at(-1);
		expect(decision?.kind).toBe("GateDecided");
		expect(decision?.actor).toEqual({ tag: "Operator", email: "bo@lab.test" });
		expect(decision?.payload).toMatchObject({
			decided_by: { tag: "Operator", email: "bo@lab.test" },
		});
		expect(aliquot(["gate", "show", "G-1"]).stdout).toContain(
			"decision: approve by bo@lab.test at",
		);
	});

	it("leaves a command that only reads free to run without a person", () => {
		aliquot(["org", "seed"], { env: { ALIQUOT_OPERATOR: "ada@lab.test" } });

		const tree = aliquot(["org", "tree"]);

		expect(tree.stderr).toBe("");
		expect(tree.status).toBe(0);
	});
});

describe("a Ledger written at slice-1's tip, before #74", () => {
	beforeEach(() => {
		copyFileSync(SLICE_1_LEDGER, join(home, "ledger.sqlite"));
	});

	it("verifies byte for byte: the hash chain is untouched", () => {
		expect(verifyLedger(home)).toEqual({ ok: true, count: 101 });
		expect(aliquot(["ledger", "verify"]).stdout).toBe(
			"Ledger verified: 101 Events, chain intact\n",
		);
	});

	it("opens, and lists its Operator's Events as the unnamed Operator", () => {
		const all = events();
		const byOperator = all.filter((e) => e.actor.tag === "Operator");

		expect(
			byOperator.length,
			"recruits, Tasks, the Message, the decision",
		).toBe(37);
		for (const event of byOperator) {
			expect(event.actor, `seq ${event.seq}`).toEqual({ tag: "Operator" });
			expect(actorName(event.actor)).toBe("Operator (unnamed)");
		}
		expect(aliquot(["gate", "show", "G-1"]).stdout).toContain(
			"decision: approve by Operator (unnamed) at",
		);
		expect(aliquot(["room", "history", "RM-lab"]).stdout).toMatch(
			/^99 {2}\S+ {2}Operator \(unnamed\): Received 3 bottles\n$/,
		);
	});

	it("takes new Events that name the person after the old unnamed ones", () => {
		const said = aliquot(["room", "say", "RM-lab"], {
			env: { ALIQUOT_OPERATOR: "ada@lab.test" },
			input: "Results follow",
		});

		expect(said.stdout).toBe("102  ada@lab.test in RM-lab\n");
		expect(verifyLedger(home)).toEqual({ ok: true, count: 102 });
		expect(aliquot(["room", "history", "RM-lab"]).stdout).toMatch(
			/Operator \(unnamed\): Received 3 bottles\n102 {2}\S+ {2}ada@lab\.test: Results follow\n$/,
		);
	});
});
