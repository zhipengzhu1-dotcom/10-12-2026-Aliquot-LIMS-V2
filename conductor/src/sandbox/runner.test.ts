import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import type { Sha256 } from "../ids.js";
import { AgentId } from "../ids.js";
import { type Ledger, openMemoryLedger } from "../ledger.js";
import { dockerAvailable, requireDocker } from "../test-support/docker.js";
import { lineageOf, openArtifacts } from "./artifacts.js";
import { buildImage, scriptsRoot } from "./image.js";
import { runScript } from "./runner.js";
import { registerScript } from "./scripts.js";

// Each build gives its tag a new image id and Docker drops the image the tag
// held, so this process's tag is its own: other suites and checkouts build at
// the same time.
const IMAGE = `aliquot-sandbox:runner-${process.pid}`;

const suite = dockerAvailable
	? "Sandbox runner (Docker)"
	: "Sandbox runner: SKIPPED because `docker info` failed; start Docker to run these";

const odile = { tag: "Agent", id: AgentId.parse("A-odile") } as const;
const operator = { tag: "Operator" } as const;

let image: Sha256;
let home: string;
let ledger: Ledger;

const register = (name: string) =>
	registerScript({
		ledger,
		home,
		actor: operator,
		name,
		scriptDir: join(scriptsRoot, name),
		owner_agent: odile.id,
		input_types: ["Other"],
		output_types: ["Other"],
		image_digest: image,
	});

const storeInput = (text: string, filename: string) =>
	openArtifacts({ ledger, home }).store(
		Buffer.from(text),
		{
			artifact_type: "Other",
			media_type: "text/plain",
			produced_by: operator,
			lineage: [],
			filename,
		},
		{ actor: operator },
	);

describe.skipIf(!requireDocker())(suite, () => {
	beforeAll(async () => {
		({ id: image } = await buildImage({ tag: IMAGE }));
	}, 600_000);

	afterAll(() => {
		spawnSync("docker", ["rmi", IMAGE], { stdio: "ignore" });
	});

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "aliquot-runner-"));
		ledger = openMemoryLedger();
	});

	afterEach(() => {
		ledger.close();
		rmSync(home, { recursive: true, force: true });
	});

	it("runs the copy Script: exit 0, the identical output, and stdout and stderr Artifacts with Lineage to the input", async () => {
		const script = register("copy");
		const input = storeInput("lot LT-0042, 3 containers\n", "receiving.txt");

		const run = await runScript({
			ledger,
			home,
			script: { id: script.id, version: script.version },
			inputs: [input.id],
			actor: odile,
			timeoutMs: 60_000,
		});

		expect(run.exit_code).toBe(0);
		expect(run.inputs).toEqual([input.id]);
		// Identical bytes give the identical id: the copy is the input Artifact.
		expect(run.outputs).toEqual([input.id]);
		const artifacts = openArtifacts({ ledger, home });
		expect(artifacts.read(run.outputs[0] as never).toString()).toBe(
			"lot LT-0042, 3 containers\n",
		);

		// Identity is per content, and each production has its own record: the
		// input keeps its Operator record as canonical, and the Run adds its own.
		const projection = ledger.projections.artifacts;
		expect(projection.artifacts.get(input.id)).toEqual(input);
		const records = projection.productions.get(input.id);
		expect(records).toHaveLength(2);
		expect(records?.[0]?.record).toEqual(input);
		expect(records?.[1]?.record).toMatchObject({
			produced_by: { tag: "Run", id: run.id },
			lineage: [input.id],
			filename: "receiving.txt",
		});
		expect(lineageOf(projection, input.id)).toEqual([]);
		expect(lineageOf(projection, input.id, { tag: "Run", id: run.id })).toEqual(
			[input.id],
		);

		const byId = projection.artifacts;
		const stdout = byId.get(run.stdout_ref);
		expect(stdout).toMatchObject({
			artifact_type: "Other",
			media_type: "text/plain",
			produced_by: { tag: "Run", id: run.id },
			lineage: [input.id],
		});
		expect(artifacts.read(run.stdout_ref).toString()).toBe(
			"copied receiving.txt (26 bytes)\n",
		);
		expect(byId.get(run.stderr_ref)).toBeDefined();
		expect(artifacts.read(run.stderr_ref).toString()).toBe("");

		const kinds = ledger.all().map((e) => e.kind);
		expect(kinds.indexOf("RunStarted")).toBeLessThan(
			kinds.indexOf("RunFinished"),
		);
		expect(ledger.projections.runs.runs.get(run.id)?.finished?.run).toEqual(
			run,
		);
		expect(ledger.verify()).toEqual({ ok: true, count: kinds.length });
	}, 120_000);

	it("copies several inputs and gives each output and stdout Lineage to every input", async () => {
		const script = register("copy");
		const a = storeInput("alpha\n", "a.txt");
		const b = storeInput("beta\n", "b.txt");

		const run = await runScript({
			ledger,
			home,
			script,
			inputs: [a.id, b.id],
			actor: odile,
			timeoutMs: 60_000,
		});

		expect(run.exit_code).toBe(0);
		expect(new Set(run.outputs)).toEqual(new Set([a.id, b.id]));
		const projection = ledger.projections.artifacts;
		const producedBy = { tag: "Run", id: run.id } as const;
		expect(lineageOf(projection, a.id, producedBy)).toEqual([a.id, b.id]);
		expect(lineageOf(projection, b.id, producedBy)).toEqual([a.id, b.id]);
		expect(projection.artifacts.get(run.stdout_ref)).toMatchObject({
			lineage: [a.id, b.id],
		});
	}, 120_000);

	it("records a non-zero exit when a Script tries to open a network connection", async () => {
		const script = register("net_probe");

		const run = await runScript({
			ledger,
			home,
			script,
			inputs: [],
			actor: odile,
			timeoutMs: 60_000,
		});

		expect(run.exit_code).not.toBe(0);
		expect(run.outputs).toEqual([]);
		expect(
			openArtifacts({ ledger, home }).read(run.stderr_ref).toString(),
		).toMatch(/no network/);
		expect(
			ledger.projections.runs.runs.get(run.id)?.finished?.run.exit_code,
		).toBe(run.exit_code);
	}, 120_000);

	it("kills a Script that exceeds the time limit and records the kill", async () => {
		const script = register("sleep_forever");
		const started = performance.now();

		const run = await runScript({
			ledger,
			home,
			script,
			inputs: [],
			actor: odile,
			timeoutMs: 3_000,
		});

		expect(performance.now() - started).toBeLessThan(30_000);
		// 124, the timeout convention, so Docker's 137 keeps meaning an OOM or
		// an outside kill.
		expect(run.exit_code).toBe(124);
		expect(run.duration_ms).toBeGreaterThanOrEqual(3_000);
		expect(
			openArtifacts({ ledger, home }).read(run.stderr_ref).toString(),
		).toMatch(
			/killed after the 3000 ms time limit \(docker kill [^)]+\); exit code 124, the time-limit code/,
		);
		expect(ledger.projections.runs.runs.get(run.id)?.finished?.run).toEqual(
			run,
		);
	}, 120_000);
});
