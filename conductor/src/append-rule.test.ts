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

const APPEND_MESSAGE =
	"Only a domain's lifecycle module appends its Events: call a verb in that domain's lifecycle.ts.";
const GATE_MESSAGE =
	"Only the Task lifecycle requests a Gate that blocks a Task: call block in task/lifecycle.ts, so the Task's own Event chain records the block.";

const REFUSED = [
	"src/cli-support.ts",
	"src/room/commands.ts",
	"src/sandbox/runner.ts",
	"src/task/commands.ts",
	"src/turn/commands.ts",
];
const ALLOWED = [
	"src/ledger.ts",
	"src/task/commands.test.ts",
	"src/task/lifecycle.ts",
	"src/test-support/scenario.ts",
	"src/turn/lifecycle.ts",
];

const LEDGER = "type Ledger = { append(event: unknown): unknown };\n";

/** Each way to reach a Ledger's append other than `ledger.append(...)`. */
const OTHER_APPENDS = {
	"src/cli-support.ts": `${LEDGER}export const f = (ledger: Ledger) => ledger?.append({});\n`,
	"src/gate/commands.ts": `${LEDGER}export const f = ({ append: write }: Ledger) => write({});\n`,
	"src/room/commands.ts": `${LEDGER}export const f = ({ append }: Ledger) => append({});\n`,
	"src/sandbox/runner.ts": `${LEDGER}export const f = (ledger: Ledger) => {\n\tconst { append } = ledger;\n\treturn append({});\n};\n`,
	"src/task/commands.ts": `${LEDGER}export const f = (ledger: Ledger) => ledger["append"]({});\n`,
};

const gateRequest = `declare const requestGateForTask: (ledger: unknown, request: unknown) => unknown;
export const f = (ledger: unknown) => requestGateForTask(ledger, {});
`;

let project: string;

beforeEach(() => {
	project = realpathSync(mkdtempSync(join(tmpdir(), "aliquot-lint-")));
	cpSync(join(conductor, "biome.json"), join(project, "biome.json"));
	cpSync(join(conductor, "lint"), join(project, "lint"), { recursive: true });
});

afterEach(() => {
	rmSync(project, { recursive: true, force: true });
});

/** Plant each file with its content, lint them, and list the files `message` names. */
const flagged = (files: Readonly<Record<string, string>>, message: string) => {
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(dirname(join(project, file)), { recursive: true });
		writeFileSync(join(project, file), content);
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
	return { status: result.status, paths: [...new Set(paths)].sort() };
};

const each = (files: readonly string[], content: string) =>
	Object.fromEntries(files.map((file) => [file, content]));

describe("Biome's append rule", () => {
	it("refuses an append call in every non-test module but a lifecycle.ts, the Ledger and the test scenario", () => {
		const result = flagged(
			each([...REFUSED, ...ALLOWED], appendCall),
			APPEND_MESSAGE,
		);

		expect(result.paths, "the files Biome refuses").toEqual(REFUSED);
		expect(result.status, "the lint fails").toBe(1);
	});

	it("refuses an append taken from a Ledger by destructuring, by a computed key or through optional chaining, except in a lifecycle.ts", () => {
		const result = flagged(
			{
				...OTHER_APPENDS,
				"src/task/lifecycle.ts": OTHER_APPENDS["src/room/commands.ts"],
			},
			APPEND_MESSAGE,
		);

		expect(result.paths, "the files Biome refuses").toEqual(
			Object.keys(OTHER_APPENDS).sort(),
		);
		expect(result.status, "the lint fails").toBe(1);
	});
});

describe("Biome's Gate request rule", () => {
	it("refuses a requestGateForTask call everywhere but the Gate and Task lifecycles, tests included", () => {
		const refused = [
			"src/gate/commands.ts",
			"src/stage1/tracer.ts",
			"src/task/commands.test.ts",
		];
		const result = flagged(
			each(
				[...refused, "src/gate/lifecycle.ts", "src/task/lifecycle.ts"],
				gateRequest,
			),
			GATE_MESSAGE,
		);

		expect(result.paths, "the files Biome refuses").toEqual(refused);
		expect(result.status, "the lint fails").toBe(1);
	});
});
