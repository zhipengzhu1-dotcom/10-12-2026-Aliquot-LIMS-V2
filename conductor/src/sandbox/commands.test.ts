import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { AgentId, ArtifactId, Sha256 } from "../ids.js";
import { openLedger } from "../ledger.js";
import { dockerAvailable, requireDocker } from "../test-support/docker.js";
import { buildImage } from "./image.js";
import { finishRun, register, startRun, store } from "./lifecycle.js";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

const aliquot = (...args: string[]) =>
	spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--home", home, ...args],
		{
			encoding: "utf8",
			env: { ...process.env, ALIQUOT_HOME: "" },
		},
	);

const operator = { tag: "Operator" } as const;
// Each build gives its tag a new image id and Docker drops the image the tag
// held, so this process's tags are its own: other suites and checkouts build
// at the same time.
const IMAGE = `aliquot-sandbox:cli-${process.pid}`;
const BUILT = `aliquot-sandbox:cli-build-${process.pid}`;
const FORM_ID =
	"397ec95583578116203359d83765a9858213da59fa537356d290521a91c239ad";

let home: string;
let file: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-sandbox-cli-"));
	file = join(home, "submission_form.docx");
	writeFileSync(file, "Date Submitted: 10/12/2026\n");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("aliquot sandbox", () => {
	it("store stores an Operator file once by sha256, prints its id, and refuses an unknown Artifact type as a usage error", () => {
		const first = aliquot("sandbox", "store", file, "--type", "SubmissionForm");
		const second = aliquot(
			"sandbox",
			"store",
			file,
			"--type",
			"SubmissionForm",
		);
		const unknownType = aliquot(
			"sandbox",
			"store",
			file,
			"--type",
			"Spreadsheet",
		);

		expect(first.stderr).toBe("");
		expect(first.status).toBe(0);
		expect(first.stdout).toBe(`${FORM_ID}\n`);
		expect(second.stdout).toBe(first.stdout);
		expect(unknownType.status).toBe(2);
		expect(unknownType.stderr).toMatch(/Spreadsheet/);
		expect(aliquot("ledger", "verify").stdout).toBe(
			"Ledger verified: 1 Event, chain intact\n",
		);
	});

	it("artifacts lists each Artifact with its type and every production", () => {
		aliquot("sandbox", "store", file, "--type", "SubmissionForm");

		const listed = aliquot("sandbox", "artifacts");

		expect(listed.status).toBe(0);
		expect(listed.stdout).toBe(
			[
				FORM_ID,
				"  type SubmissionForm, application/vnd.openxmlformats-officedocument.wordprocessingml.document, submission_form.docx",
				"  produced by Operator; lineage: none",
				"",
			].join("\n"),
		);
	});

	it("cat writes a stored Artifact's bytes", () => {
		aliquot("sandbox", "store", file);

		const cat = aliquot("sandbox", "cat", FORM_ID);

		expect(cat.status).toBe(0);
		expect(cat.stdout).toBe("Date Submitted: 10/12/2026\n");
	});

	it("runs lists each Run with its Script version, exit code and outputs", () => {
		const ledger = openLedger({ home, writer: true });
		try {
			const { script } = register(ledger, {
				actor: operator,
				name: "copy",
				owner_agent: AgentId.parse("A-odile"),
				input_types: [],
				output_types: [],
				entrypoint: "main.py",
				image_digest: Sha256.parse("d".repeat(64)),
			});
			const { artifact } = store(
				ledger,
				{ actor: operator },
				{
					sha256: Sha256.parse(FORM_ID),
					media_type: "text/plain",
					artifact_type: "Other",
					produced_by: operator,
					lineage: [],
				},
			);
			const started = startRun(ledger, {
				actor: operator,
				script,
				inputs: [artifact.id],
			});
			finishRun(ledger, {
				actor: operator,
				run: {
					id: started.run_id,
					script: started.script,
					inputs: [artifact.id],
					outputs: [ArtifactId.parse(FORM_ID)],
					exit_code: 0,
					stdout_ref: artifact.id,
					stderr_ref: artifact.id,
					duration_ms: 42,
				},
			});
			startRun(ledger, { actor: operator, script, inputs: [] });
		} finally {
			ledger.close();
		}

		const runs = aliquot("sandbox", "runs");

		expect(runs.status).toBe(0);
		expect(runs.stdout).toBe(
			[
				`R-1  S-copy v1  exit 0, 42 ms, 1 outputs  inputs: ${FORM_ID}`,
				"R-2  S-copy v1  no RunFinished  inputs: none",
				"",
			].join("\n"),
		);
	});
});

const suite = dockerAvailable
	? "aliquot sandbox (Docker)"
	: "aliquot sandbox (Docker): SKIPPED because `docker info` failed; start Docker to run these";

describe.skipIf(!requireDocker())(suite, () => {
	beforeAll(async () => {
		await buildImage({ tag: IMAGE });
	}, 600_000);

	afterAll(() => {
		spawnSync("docker", ["rmi", IMAGE], { stdio: "ignore" });
	});

	it("build builds the Sandbox image and prints its id and tag", () => {
		try {
			const built = aliquot("sandbox", "build", "--tag", BUILT);

			expect(built.status).toBe(0);
			expect(built.stdout).toMatch(
				new RegExp(`^sha256:[0-9a-f]{64} ${BUILT}\n$`),
			);
		} finally {
			spawnSync("docker", ["rmi", BUILT], { stdio: "ignore" });
		}
	}, 120_000);

	it("register registers a Script at version 1 and a second time as its next version", () => {
		const args = ["--name", "copy", "--owner", "A-odile", "--image", IMAGE];

		const first = aliquot("sandbox", "register", ...args);
		const second = aliquot("sandbox", "register", ...args);

		expect(first.status).toBe(0);
		expect(JSON.parse(first.stdout)).toMatchObject({
			id: "S-copy",
			version: 1,
			owner_agent: "A-odile",
		});
		expect(JSON.parse(second.stdout)).toMatchObject({
			id: "S-copy",
			version: 2,
		});
	});

	it("run runs a Script on an input Artifact and prints the Run", () => {
		aliquot(
			"sandbox",
			"register",
			"--name",
			"copy",
			"--owner",
			"A-odile",
			"--image",
			IMAGE,
		);
		aliquot("sandbox", "store", file);

		const run = aliquot("sandbox", "run", "copy", "--input", FORM_ID);

		expect(run.stderr).toBe("");
		expect(run.status).toBe(0);
		expect(JSON.parse(run.stdout)).toMatchObject({
			id: "R-1",
			script: { id: "S-copy", version: 1 },
			inputs: [FORM_ID],
			outputs: [FORM_ID],
			exit_code: 0,
		});
	}, 120_000);
});
