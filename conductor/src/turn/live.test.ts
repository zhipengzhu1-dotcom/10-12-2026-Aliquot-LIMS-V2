import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

// A real Turn on the subscription login of the claude CLI. It spends the
// Operator's subscription, so it runs only when asked; CI never sets it.
const live = process.env.ALIQUOT_LIVE_TURN === "1";

describe.runIf(live)("a live Turn", () => {
	it("runs one Turn of A-rin on the subscription login, records it, and the Ledger verifies", () => {
		const home = mkdtempSync(join(tmpdir(), "aliquot-live-turn-"));
		const env = {
			...process.env,
			ALIQUOT_HOME: "",
			ALIQUOT_API_KEY: "",
			ALIQUOT_SCRIPTED_MODEL: "",
		};
		const aliquot = (...args: string[]) =>
			spawnSync(
				process.execPath,
				["--import", "tsx", cli, "--home", home, ...args],
				{ encoding: "utf8", env },
			);
		try {
			expect(aliquot("org", "seed").status).toBe(0);

			const r = aliquot("turn", "run", "A-rin", "--max-turns", "3");

			process.stdout.write(r.stdout);
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expect(r.stdout).toMatch(
				/^TN-1 A-rin model=claude-sonnet-5-5 .* outcome=(Completed|MaxTurns)\n/,
			);
			expect(r.stdout).toContain(
				"Model: the Agent SDK, on the subscription login of the claude CLI",
			);
			expect(r.stdout).not.toMatch(/ input=0 output=0 /);
			expect(aliquot("ledger", "verify").stdout).toMatch(/chain intact/);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}, 300_000);
});
