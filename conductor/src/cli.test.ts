import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));

const runCli = (...args: string[]) =>
	spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
		encoding: "utf8",
	});

describe("aliquot cli", () => {
	it("prints usage naming the aliquot command when run with no arguments", () => {
		const result = runCli();
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/^Usage: aliquot <command> \[options\]/);
	});
});
