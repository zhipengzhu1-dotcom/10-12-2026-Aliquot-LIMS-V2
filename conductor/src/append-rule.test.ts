import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const conductor = fileURLToPath(new URL("..", import.meta.url));
const biome = join(conductor, "node_modules", ".bin", "biome");

const appendCall = `export const f = (ledger: { append(event: unknown): unknown }) =>
	ledger.append({});
`;

const REFUSED = [
	"src/cli-support.ts",
	"src/room/commands.ts",
	"src/sandbox/runner.ts",
	"src/task/commands.ts",
];
const ALLOWED = [
	"src/ledger.ts",
	"src/task/commands.test.ts",
	"src/task/lifecycle.ts",
	"src/test-support/scenario.ts",
];

let project: string;

beforeEach(() => {
	project = realpathSync(mkdtempSync(join(tmpdir(), "aliquot-lint-")));
	cpSync(join(conductor, "biome.json"), join(project, "biome.json"));
	cpSync(join(conductor, "lint"), join(project, "lint"), { recursive: true });
});

afterEach(() => {
	rmSync(project, { recursive: true, force: true });
});

const flagged = (files: readonly string[], message: string) => {
	for (const file of files) {
		mkdirSync(dirname(join(project, file)), { recursive: true });
		writeFileSync(join(project, file), appendCall);
	}
	// The copied configuration plants files outside any git repository, where
	// biome.json's git integration finds no ignore file and stops.
	const result = spawnSync(
		biome,
		["lint", "--vcs-enabled=false", "--reporter=github", "."],
		{ cwd: project, encoding: "utf8" },
	);
	const paths = result.stdout
		.split("\n")
		.filter((line) => line.endsWith(`::${message}`))
		.map((line) => /,file=([^,]+),/.exec(line)?.[1] ?? line)
		.map((path) => relative(project, path));
	return { status: result.status, paths: paths.sort() };
};

describe("Biome's append rule", () => {
	it("refuses an append call in every non-test module but a lifecycle.ts, the Ledger and the test scenario", () => {
		const result = flagged(
			[...REFUSED, ...ALLOWED],
			"Only a domain's lifecycle module appends its Events: call a verb in that domain's lifecycle.ts.",
		);

		expect(result.paths, "the files Biome refuses").toEqual(REFUSED);
		expect(result.status, "the lint fails").toBe(1);
	});
});
