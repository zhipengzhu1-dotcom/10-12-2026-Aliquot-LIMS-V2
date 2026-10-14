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
import type { Run, Script } from "../types/script.js";
import { openArtifacts } from "./artifacts.js";
import { buildImage, scriptsRoot } from "./image.js";
import { runScript, useSandbox } from "./runner.js";
import { registerScript } from "./scripts.js";
import { openWarmSandbox, type WarmSandbox } from "./warm.js";

const IMAGE = `aliquot-sandbox:warm-${process.pid}`;

const suite = dockerAvailable
	? "warm Sandbox (Docker)"
	: "warm Sandbox: SKIPPED because `docker info` failed; start Docker to run these";

/**
 * A warm Run's bound. The ticket's 100 ms holds on the development machine;
 * a CI runner shares its cores with other jobs, so CI gets 250 ms.
 */
const WARM_RUN_MS = process.env.CI ? 250 : 100;

const odile = { tag: "Agent", id: AgentId.parse("A-odile") } as const;
const operator = { tag: "Operator" } as const;

const MESSAGE = {
	seq: 12,
	room: "RM-lab",
	said_by: "Operator",
	ts: "2026-10-13T09:30:00.000Z",
	body: "Received 3 bottles of Vitamin C 500 mg capsules, Lot 2403A, Product Code VC500, Product Type 60 ct HDPE bottle, finished product, from Acme Nutrition, regular TAT. Report to: Acme Nutrition; Contact: Dana Reyes; Address: 12 Harbor Road; City: Portland, OR 97201",
};

let image: Sha256;
let home: string;
let ledger: Ledger;
let warm: WarmSandbox;
let restore: () => void;

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
			media_type: "application/json",
			produced_by: operator,
			lineage: [],
			filename,
		},
		{ actor: operator },
	).artifact;

let scripts: Map<string, Script>;

const registered = (name: string) => {
	const script = scripts.get(name) ?? register(name);
	scripts.set(name, script);
	return script;
};

const run = (name: string, inputs: Run["inputs"], timeoutMs = 60_000) => {
	const script = registered(name);
	return runScript({
		ledger,
		home,
		script: { id: script.id, version: script.version },
		inputs,
		actor: odile,
		timeoutMs,
	});
};

const read = (id: Run["stdout_ref"]) =>
	openArtifacts({ ledger, home }).read(id).toString();

/** What a Run produced, by filename, with stdout, stderr and the exit code. */
const record = (run: Run) => ({
	exit_code: run.exit_code,
	stdout: read(run.stdout_ref),
	stderr: read(run.stderr_ref),
	outputs: Object.fromEntries(
		run.outputs.map((id) => [
			ledger.projections.artifacts.artifacts.get(id)?.filename,
			read(id),
		]),
	),
});

const warmContainers = () =>
	spawnSync(
		"docker",
		[
			"ps",
			"--filter",
			"label=aliquot.warm=1",
			"--filter",
			`name=aliquot-warm-${process.pid}-`,
			"--format",
			"{{.Names}}",
		],
		{ encoding: "utf8" },
	)
		.stdout.split("\n")
		.filter(Boolean);

const waitFor = async (check: () => boolean, ms: number) => {
	const until = performance.now() + ms;
	while (!check() && performance.now() < until) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return check();
};

describe.skipIf(!requireDocker())(suite, () => {
	beforeAll(async () => {
		({ id: image } = await buildImage({ tag: IMAGE }));
	}, 600_000);

	afterAll(() => {
		spawnSync("docker", ["rmi", IMAGE], { stdio: "ignore" });
	});

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "aliquot-warm-test-"));
		ledger = openMemoryLedger();
		scripts = new Map();
		warm = openWarmSandbox();
		restore = useSandbox(warm);
	});

	afterEach(async () => {
		restore();
		await warm.close();
		ledger.close();
		rmSync(home, { recursive: true, force: true });
	});

	it("runs parse_message ten times in the warm Sandbox, each under the bound, with a cold Run's outputs", async () => {
		const message = storeInput(JSON.stringify(MESSAGE), "message-12.json");
		restore();
		const cold = await run("parse_message", [message.id]);
		restore = useSandbox(warm);
		expect(cold.exit_code, "the cold Run succeeds").toBe(0);

		await run("parse_message", [message.id]);
		const times: number[] = [];
		for (let i = 0; i < 10; i++) {
			const started = performance.now();
			const warmRun = await run("parse_message", [message.id]);
			times.push(Math.round(performance.now() - started));
			expect(
				record(warmRun),
				"a warm Run records what a cold Run does",
			).toEqual(record(cold));
		}
		console.log(
			`parse_message: cold Run ${cold.duration_ms} ms; ten warm Runs, end to end: ${times.join(", ")} ms`,
		);
		for (const ms of times) expect(ms).toBeLessThan(WARM_RUN_MS);
	}, 120_000);

	it("gives a warm Run no network", async () => {
		const probe = await run("net_probe", []);
		expect(probe.exit_code).not.toBe(0);
		expect(read(probe.stderr_ref)).toMatch(/no network/);
	}, 120_000);

	it("shows a warm Run nothing an earlier Run left: no files, no processes, and read-only inputs", async () => {
		const first = storeInput('{"run": "first"}', "first.json");
		const second = storeInput('{"run": "second"}', "second.json");

		const before = await run("leak_probe", [first.id]);
		const after = await run("leak_probe", [second.id]);

		expect(before.exit_code).toBe(0);
		expect(after.exit_code).toBe(0);
		const seen = JSON.parse(record(after).outputs["seen.json"] ?? "{}");
		expect(seen).toEqual({
			tmp: [],
			shm: [],
			outputs: [],
			inputs: [second.id, `${second.id}/second.json`, "manifest.json"].sort(),
			processes: [],
			inputs_writable: false,
		});
	}, 120_000);

	it("kills a warm Run at its time limit, and the next Run succeeds", async () => {
		const started = performance.now();
		const slept = await run("sleep_forever", [], 2_000);
		expect(performance.now() - started).toBeLessThan(15_000);
		expect(slept.exit_code).toBe(124);
		expect(read(slept.stderr_ref)).toMatch(
			/killed after the 2000 ms time limit in the warm Sandbox aliquot-warm-[^;]+; exit code 124, the time-limit code/,
		);

		const message = storeInput(JSON.stringify(MESSAGE), "message-12.json");
		expect((await run("parse_message", [message.id])).exit_code).toBe(0);
	}, 120_000);

	it("fails the Run in flight when its warm container is killed, and the next Run starts a fresh one", async () => {
		const message = storeInput(JSON.stringify(MESSAGE), "message-12.json");
		await run("parse_message", [message.id]);
		const [killed] = warmContainers();
		expect(killed, "a warm container is up").toBeDefined();

		const inFlight = run("sleep_forever", [], 60_000);
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		spawnSync("docker", ["kill", killed ?? ""], { stdio: "ignore" });
		const failed = await inFlight;
		expect(failed.exit_code).toBe(137);
		expect(read(failed.stderr_ref)).toContain(
			`the warm Sandbox ${killed} stopped during ${failed.id} (docker exit 137), so ${failed.id} did not finish; the next Run starts a fresh one`,
		);
		expect(ledger.projections.runs.runs.get(failed.id)?.finished?.run).toEqual(
			failed,
		);

		const next = await run("parse_message", [message.id]);
		expect(next.exit_code).toBe(0);
		expect(warmContainers()).not.toContain(killed);
		expect(warmContainers()).toHaveLength(1);
	}, 120_000);

	it("stops its containers when it closes", async () => {
		const message = storeInput(JSON.stringify(MESSAGE), "message-12.json");
		await run("parse_message", [message.id]);
		expect(warmContainers()).toHaveLength(1);

		await warm.close();

		expect(await waitFor(() => warmContainers().length === 0, 10_000)).toBe(
			true,
		);
	}, 120_000);
});
