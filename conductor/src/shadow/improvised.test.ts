import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../hash.js";
import { openLedger } from "../ledger.js";
import { dockerAvailable, requireDocker } from "../test-support/docker.js";

const suite = dockerAvailable
	? "the improvised real-layout forms against the scrubbed Receiving Log (Docker)"
	: "the improvised real-layout forms: SKIPPED because `docker info` failed; start Docker to run these";

const realLayout = fileURLToPath(
	new URL("../../../fixtures/real-layout/", import.meta.url),
);
const improvised = join(realLayout, "improvised");
const forms = readdirSync(improvised)
	.filter((name) => name.endsWith(".docx"))
	.sort();

/**
 * Fields a faithful form's Shadow row fills another way than the lab does:
 * EXP DATE, QTY RECD and SENT BY by #76's conventions (no expiry cell, one row
 * per container, the contact's name), and TYPE because the generator writes
 * FP for a stability condition so that stage 3 plans a Test.
 */
const FILLED_ANOTHER_WAY = ["TYPE", "EXP DATE", "QTY RECD", "SENT BY"];

type Difference = {
	column: string;
	field: string;
	shadow: string;
	lab: string;
};
type Row = {
	status: "matched" | "differs" | "missing_in_lab" | "missing_in_shadow";
	shadow_row: number | null;
	lab_row: number | null;
	differences: Difference[];
};
type Comparison = { rows: Row[] };

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

let home: string;
let scratch: string;
let lab: string;
let before: string;
const comparisons = new Map<string, Comparison>();

const aliquot = (...args: string[]) =>
	spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--home", home, ...args],
		{ encoding: "utf8", env: { ...process.env, ALIQUOT_HOME: "" } },
	);

const latestComparison = (): Comparison => {
	const ledger = openLedger({ home, writer: false });
	try {
		const stored = ledger
			.all()
			.filter(
				(e) =>
					e.kind === "ArtifactStored" &&
					e.payload.artifact_type === "Comparison" &&
					e.payload.filename === "comparison.json",
			)
			.at(-1);
		if (stored?.kind !== "ArtifactStored") throw new Error("no Comparison");
		return JSON.parse(
			readFileSync(join(home, "blobs", stored.payload.id), "utf8"),
		);
	} finally {
		ledger.close();
	}
};

const expectedLot = (form: string): string =>
	JSON.parse(
		readFileSync(
			join(improvised, form.replace(/\.docx$/, ".expected.json")),
			"utf8",
		),
	).sample.lot;

describe.skipIf(!requireDocker())(suite, () => {
	beforeAll(() => {
		home = mkdtempSync(join(tmpdir(), "aliquot-improvised-"));
		scratch = mkdtempSync(join(tmpdir(), "aliquot-improvised-lab-"));
		lab = join(scratch, "Receiving Log 2026.xlsx");
		copyFileSync(join(realLayout, "receiving-log.xlsx"), lab);
		chmodSync(lab, 0o444);
		before = sha256Hex(readFileSync(lab));
		const named = aliquot("shadow", "receiving-log", lab);
		if (named.status !== 0) throw new Error(named.stderr);
		for (const form of forms) {
			const ran = aliquot(
				"workflow",
				"run",
				join(improvised, form),
				"--to",
				"2",
			);
			if (ran.status !== 0)
				throw new Error(`${form}: ${ran.stdout}${ran.stderr}`);
			const compared = aliquot("shadow", "compare");
			if (compared.status !== 0) throw new Error(`${form}: ${compared.stderr}`);
			comparisons.set(form, latestComparison());
		}
	}, 900_000);

	afterAll(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(scratch, { recursive: true, force: true });
	});

	it("covers at least six forms, the two off on purpose among them", () => {
		expect(forms.length).toBeGreaterThanOrEqual(6);
		expect(forms.filter((f) => f.includes("lot-mistyped"))).toHaveLength(1);
		expect(forms).toContain("unlogged-sample.docx");
	});

	it("pairs every Shadow row of a faithful form with a lab row, differing only in the fields filled another way", () => {
		const faithful = forms.filter(
			(f) => f.startsWith("received-") && !f.includes("lot-mistyped"),
		);
		expect(faithful.length).toBeGreaterThanOrEqual(4);
		for (const form of faithful) {
			const shadowRows = comparisons
				.get(form)
				?.rows.filter((r) => r.shadow_row !== null);
			expect(shadowRows?.length, form).toBeGreaterThan(0);
			for (const row of shadowRows ?? []) {
				expect(row.lab_row, `${form} Shadow row ${row.shadow_row}`).not.toBe(
					null,
				);
				for (const d of row.differences) {
					expect(FILLED_ANOTHER_WAY, `${form} ${d.field}`).toContain(d.field);
				}
			}
		}
	});

	it("shows the mistyped Lot as a differing LOT# on every row of its form", () => {
		const [form] = forms.filter((f) => f.includes("lot-mistyped"));
		const lot = expectedLot(form ?? "");
		const rows = comparisons.get(form ?? "")?.rows ?? [];
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.status).toBe("differs");
			const differs = row.differences.find((d) => d.field === "LOT#");
			expect(differs?.shadow).toBe(lot);
			expect(differs?.lab).not.toBe(lot);
			expect(differs?.lab.slice(0, -1)).toBe(lot.slice(0, -1));
		}
	});

	it("shows the unlogged Sample as missing in the lab's", () => {
		const rows = comparisons.get("unlogged-sample.docx")?.rows ?? [];
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.map((r) => r.status)).toEqual(rows.map(() => "missing_in_lab"));
	});

	it("leaves the lab's workbook byte for byte as it was", () => {
		expect(sha256Hex(readFileSync(lab))).toBe(before);
	});
});
