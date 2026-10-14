import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../hash.js";
import { openLedger } from "../ledger.js";
import { dockerAvailable, requireDocker } from "../test-support/docker.js";

const suite = dockerAvailable
	? "aliquot shadow (Docker)"
	: "aliquot shadow: SKIPPED because `docker info` failed; start Docker to run these";

const realLayout = (name: string) =>
	fileURLToPath(
		new URL(`../../../fixtures/real-layout/${name}`, import.meta.url),
	);
const form = realLayout("submission-form-seed4.docx");

let home: string;
let scratch: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-shadow-"));
	scratch = mkdtempSync(join(tmpdir(), "aliquot-shadow-scratch-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(scratch, { recursive: true, force: true });
});

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

const aliquot = (...args: string[]) =>
	spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--home", home, ...args],
		{ encoding: "utf8", env: { ...process.env, ALIQUOT_HOME: "" } },
	);

/** A read-only copy of `source` standing in for the lab's workbook. */
const labsWorkbook = (source: string, name: string): string => {
	const dir = join(scratch, name);
	mkdirSync(dir);
	const path = join(dir, "Receiving Log.xlsx");
	copyFileSync(source, path);
	chmodSync(path, 0o444);
	return path;
};

const hashOf = (path: string) => sha256Hex(readFileSync(path));

const withLedger = <T>(use: (ledger: ReturnType<typeof openLedger>) => T) => {
	const ledger = openLedger({ home, writer: false });
	try {
		return use(ledger);
	} finally {
		ledger.close();
	}
};

describe("aliquot shadow", () => {
	it("compare refuses before anything runs when the home names no Receiving Log", () => {
		const result = aliquot("shadow", "compare");

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"this home names no Receiving Log: name the lab's workbook with `aliquot shadow receiving-log <path>`",
		);
	});
});

describe.skipIf(!requireDocker())(suite, () => {
	it("stage 2 writes a Shadow and the Comparison reads the lab's workbook, which stays byte for byte as it was", () => {
		const lab = labsWorkbook(realLayout("receiving-log.xlsx"), "lab");
		const before = hashOf(lab);

		const named = aliquot("shadow", "receiving-log", lab);
		expect(named.status, named.stderr).toBe(0);
		expect(named.stdout).toMatch(
			new RegExp(`^ReceivingLogNamed seq \\d+: ${lab} sha256 ${before}\\n$`),
		);

		const ran = aliquot("workflow", "run", form, "--to", "2");
		expect(ran.status, ran.stdout + ran.stderr).toBe(0);
		expect(ran.stdout).toContain(
			"ShadowReceivingLog receiving_log_shadow.xlsx",
		);
		expect(ran.stdout).toContain("stage 2 Receipt: T-2 Done");
		expect(hashOf(lab), "stage 2 left the lab's workbook as it was").toBe(
			before,
		);

		const compared = aliquot("shadow", "compare");
		expect(compared.status, compared.stderr).toBe(0);
		expect(compared.stdout).toContain(
			"0 matched, 0 differs, 3 missing in the lab's, 0 missing in the Shadow",
		);
		expect(
			hashOf(lab),
			"the Comparison left the lab's workbook as it was",
		).toBe(before);

		withLedger((ledger) => {
			const events = ledger.all();
			const naming = events.find((e) => e.kind === "ReceivingLogNamed");
			expect(naming?.payload).toEqual({ path: lab, sha256: before });
			const reads = events.filter(
				(e) =>
					e.kind === "ArtifactStored" &&
					e.payload.artifact_type === "ReceivingLog",
			);
			expect(reads.map((e) => e.causation_id)).toEqual([naming?.seq]);
			const comparisons = events.filter(
				(e) =>
					e.kind === "ArtifactStored" &&
					e.payload.artifact_type === "Comparison",
			);
			expect(comparisons).toHaveLength(2);
			const [run] = [...ledger.projections.runs.runs.values()].filter(
				(r) => r.started.script.id === "S-compare_receiving_log",
			);
			for (const e of comparisons) {
				if (e.kind !== "ArtifactStored") throw new Error(e.kind);
				expect(e.payload.produced_by).toEqual({
					tag: "Run",
					id: run?.started.run_id,
				});
			}
			const shadow = events.find(
				(e) =>
					e.kind === "ArtifactStored" &&
					e.payload.artifact_type === "ShadowReceivingLog",
			);
			expect(run?.started.inputs).toContain(
				shadow?.kind === "ArtifactStored" ? shadow.payload.id : undefined,
			);
			expect(run?.started.inputs).toContain(
				reads[0]?.kind === "ArtifactStored" ? reads[0].payload.id : undefined,
			);
		});
	}, 600_000);

	it("compare refuses a Receiving Log that is byte for byte the Shadow, which holds nothing of the lab's", () => {
		const lab = labsWorkbook(realLayout("receiving-log.xlsx"), "lab");
		expect(aliquot("shadow", "receiving-log", lab).status).toBe(0);
		const ran = aliquot("workflow", "run", form, "--to", "2");
		expect(ran.status, ran.stdout + ran.stderr).toBe(0);
		const shadowId = /^ {4}output {4}(\w{64}) ShadowReceivingLog /m.exec(
			ran.stdout,
		)?.[1];
		expect(shadowId).toBeDefined();
		const copied = join(scratch, "copied.xlsx");
		writeFileSync(copied, readFileSync(join(home, "blobs", shadowId ?? "")));
		const named = labsWorkbook(copied, "copied");
		expect(aliquot("shadow", "receiving-log", named).status).toBe(0);

		const compared = aliquot("shadow", "compare");

		expect(compared.status).toBe(1);
		expect(compared.stderr).toContain(
			`the lab's Receiving Log ${named} is byte for byte the Shadow ${shadowId}, so it holds no rows of the lab's to compare`,
		);
		withLedger((ledger) =>
			expect(
				[...ledger.projections.runs.runs.values()].map(
					(r) => r.started.script.id,
				),
			).not.toContain("S-compare_receiving_log"),
		);
	}, 600_000);
});
