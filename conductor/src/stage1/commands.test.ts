import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../command.js";
import { sha256Hex } from "../hash.js";
import { ArtifactId, TaskId } from "../ids.js";
import { openLedger } from "../ledger.js";
import { dockerAvailable, requireDocker } from "../test-support/docker.js";
import { stage1Commands } from "./commands.js";

const suite = dockerAvailable
	? "aliquot stage1 (Docker)"
	: "aliquot stage1: SKIPPED because `docker info` failed; start Docker to run these";

const fixture = fileURLToPath(
	new URL("../../../fixtures/submission-form-seed1.docx", import.meta.url),
);
const fixtureId = ArtifactId.parse(sha256Hex(readFileSync(fixture)));

let home: string;
let scratch: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-stage1-"));
	scratch = mkdtempSync(join(tmpdir(), "aliquot-stage1-scratch-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(scratch, { recursive: true, force: true });
});

const run = async (name: "run" | "run-all", args: string[]) => {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const out: Buffer[] = [];
	stdout.on("data", (chunk: Buffer) => out.push(chunk));
	stderr.resume();
	const ctx: CommandContext = {
		home,
		stdin: Readable.from([]),
		stdout,
		stderr,
	};
	const code = await stage1Commands[name]?.run(args, ctx);
	return { code, stdout: Buffer.concat(out).toString("utf8") };
};

const readLedger = () => {
	const ledger = openLedger({ home, writer: false });
	try {
		return {
			events: ledger.all(),
			verify: ledger.verify(),
			taskState: (id: string) =>
				ledger.projections.tasks.tasks.get(TaskId.parse(id))?.state,
		};
	} finally {
		ledger.close();
	}
};

describe.skipIf(!requireDocker())(suite, () => {
	it("runs the Fixture through parse_submission, prints the Task, Run, record and Evaluation, and exits 0 with the Task Done", async () => {
		const result = await run("run", [fixture]);

		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(
			new RegExp(
				[
					"^submission-form-seed1\\.docx: T-1 Done",
					`  fixture   ${fixtureId} \\(SubmissionForm\\)`,
					"  run       R-1 S-parse_submission v1, exit 0",
					"  output    [0-9a-f]{64} submission\\.json",
					"  eval      E-1 score 1\\.000, passed\n$",
				].join("\n"),
			),
		);
		const { verify, taskState } = readLedger();
		expect(verify.ok).toBe(true);
		expect(taskState("T-1")).toEqual({ tag: "Done", assignee: "A-rin" });
	}, 600_000);

	it("run-all runs every docx in a directory and exits 1 when any Evaluation fails", async () => {
		const dir = join(scratch, "fixtures");
		mkdirSync(dir);
		copyFileSync(fixture, join(dir, "a-good.docx"));
		writeFileSync(join(dir, "b-not-a-docx.docx"), "not a zip archive\n");
		writeFileSync(join(dir, "notes.txt"), "ignored\n");

		const result = await run("run-all", [dir]);

		expect(result.code).toBe(1);
		const { events, verify, taskState } = readLedger();
		expect(verify.ok).toBe(true);
		expect(taskState("T-1")).toEqual({ tag: "Done", assignee: "A-rin" });
		expect(taskState("T-2")?.tag).toBe("Failed");
		expect(taskState("T-3")).toBeUndefined();
		// One registration serves every Fixture in the batch.
		expect(
			events.filter(
				(e) => e.kind === "ScriptRegistered" || e.kind === "ScriptRevised",
			),
		).toHaveLength(1);
	}, 600_000);
});
