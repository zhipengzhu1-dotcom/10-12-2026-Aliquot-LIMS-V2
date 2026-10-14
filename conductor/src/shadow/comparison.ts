import { join } from "node:path";
import type { ArtifactId, RunId, Sha256 } from "../ids.js";
import type { Ledger } from "../ledger.js";
import type { Projections } from "../projections.js";
import { openArtifacts } from "../sandbox/artifacts.js";
import { scriptsRoot } from "../sandbox/image.js";
import { runScript } from "../sandbox/runner.js";
import type { Person } from "../types/actor.js";
import type { Run } from "../types/script.js";
import { STAGES } from "../workflow/stages.js";
import { ensureScript } from "../workflow/tracer.js";
import { readReceivingLog } from "./lifecycle.js";

const receipt = STAGES.find((stage) =>
	stage.optional_inputs?.includes("ReceivingLog"),
);
if (receipt === undefined) {
	throw new Error(
		"stage table refused: no stage takes the lab's Receiving Log",
	);
}

/**
 * The Comparison's Script, owned by the Agent who works the stage that
 * writes the Shadow. `Other` is the `shadow.json` written beside the Shadow.
 */
export const COMPARISON = {
	script: "compare_receiving_log",
	worked_by: receipt.worked_by,
	inputs: ["ShadowReceivingLog", "Other", "ReceivingLog"],
	carried: [],
	outputs: ["Comparison", "Comparison"],
} as const;

export type Comparison = {
	readonly shadow: ArtifactId;
	/** The stage 2 Run that wrote the Shadow. */
	readonly shadow_run: RunId;
	/** The fresh read of the lab's Receiving Log, and where it was read. */
	readonly lab: ArtifactId;
	readonly path: string;
	/** The Run that made the Comparison, which names it as its source. */
	readonly run: Run;
	readonly json: ArtifactId;
	readonly table: ArtifactId;
	/** `comparison.txt`, the Comparison as a table to read. */
	readonly text: string;
};

const filenameOf = (projections: Projections, id: ArtifactId) =>
	projections.artifacts.artifacts.get(id)?.filename;

/**
 * The latest Shadow a Run wrote whose Task is Done, with that Run: a Shadow
 * a failed stage 2 wrote, which its Evaluation did not accept, is never
 * compared.
 */
const latestShadow = (
	projections: Projections,
): { readonly shadow: ArtifactId; readonly run: Run } | undefined => {
	let latest: { seq: number; shadow: ArtifactId; run: Run } | undefined;
	for (const [id, productions] of projections.artifacts.productions) {
		for (const { seq, record } of productions) {
			if (
				record.artifact_type !== "ShadowReceivingLog" ||
				record.produced_by.tag !== "Run" ||
				(latest && latest.seq > seq)
			) {
				continue;
			}
			const ran = projections.runs.runs.get(record.produced_by.id);
			const done =
				ran?.task_id !== undefined &&
				projections.tasks.tasks.get(ran.task_id)?.state.tag === "Done";
			if (done && ran.finished) {
				latest = { seq, shadow: id, run: ran.finished.run };
			}
		}
	}
	return latest;
};

/**
 * The Comparison of the latest Shadow with a fresh read of the lab's
 * Receiving Log: read the workbook the home names, read-only, as the
 * person's `ReceivingLog` Artifact; run the comparison Script on the Shadow,
 * its `shadow.json` and that Artifact as the person; and return the Run and
 * the two `Comparison` Artifacts it wrote.
 */
export const compareShadow = async (options: {
	ledger: Ledger;
	home: string;
	operator: Person;
	image: Sha256;
	timeoutMs: number;
}): Promise<Comparison> => {
	const { ledger, home, operator } = options;
	const named = ledger.projections.shadow.receiving_log;
	if (named === undefined) {
		throw new Error(
			"this home names no Receiving Log: name the lab's workbook with `aliquot shadow receiving-log <path>`",
		);
	}
	const found = latestShadow(ledger.projections);
	if (found === undefined) {
		throw new Error(
			"the Ledger holds no Shadow from a Done stage 2 Task: run the workflow's stage 2 with the Receiving Log named",
		);
	}
	const held = found.run.outputs.find(
		(id) => filenameOf(ledger.projections, id) === "shadow.json",
	);
	if (held === undefined) {
		throw new Error(`${found.run.id} wrote the Shadow and no shadow.json`);
	}
	const lab = readReceivingLog(ledger, home, operator);
	if (lab === undefined) throw new Error("the Receiving Log vanished");
	// Bytes the Ledger holds are one Artifact, so the Run would see one input.
	if (lab.artifact.id === found.shadow) {
		throw new Error(
			`the lab's Receiving Log ${named.path} is byte for byte the Shadow ${found.shadow}, so it holds no rows of the lab's to compare`,
		);
	}

	const script = ensureScript({
		ledger,
		home,
		stage: COMPARISON,
		source: join(scriptsRoot, COMPARISON.script),
		image: options.image,
		operator,
	});
	const run = await runScript({
		ledger,
		home,
		script: { id: script.id, version: script.version },
		inputs: [found.shadow, held, lab.artifact.id],
		actor: operator,
		causation_id: lab.seq,
		timeoutMs: options.timeoutMs,
	});
	if (run.exit_code !== 0) {
		throw new Error(
			`${run.id} exited ${run.exit_code}; its stderr is Artifact ${run.stderr_ref}`,
		);
	}
	const written = (filename: string): ArtifactId => {
		const id = run.outputs.find(
			(o) => filenameOf(ledger.projections, o) === filename,
		);
		if (id === undefined) throw new Error(`${run.id} wrote no ${filename}`);
		return id;
	};
	const table = written("comparison.txt");
	return {
		shadow: found.shadow,
		shadow_run: found.run.id,
		lab: lab.artifact.id,
		path: named.path,
		run,
		json: written("comparison.json"),
		table,
		text: openArtifacts({ ledger, home }).read(table).toString("utf8"),
	};
};
