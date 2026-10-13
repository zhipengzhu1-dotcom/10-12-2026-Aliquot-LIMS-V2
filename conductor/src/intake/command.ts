import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { parseArgs } from "node:util";
import { fromInvocation, withLedger } from "../cli-support.js";
import { type Command, UsageError } from "../command.js";
import { sha256Hex } from "../hash.js";
import { ArtifactId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import { openArtifacts } from "../sandbox/artifacts.js";
import { guessMediaType } from "../sandbox/runner.js";
import type { StoredArtifact } from "../types/artifact.js";

const operator = { tag: "Operator" } as const;

/**
 * Store a Submission Form the Operator drops on the society as an Artifact
 * the Operator produced, with no Lineage. Bytes already stored append
 * nothing. `appended` is false then.
 */
export const intake = (
	ledger: Ledger,
	home: string,
	file: string,
): { readonly artifact: StoredArtifact; readonly appended: boolean } => {
	const bytes = readFileSync(file);
	const known = ledger.projections.artifacts.artifacts.has(
		ArtifactId.parse(sha256Hex(bytes)),
	);
	const filename = basename(file);
	const { artifact } = openArtifacts({ ledger, home }).store(
		bytes,
		{
			artifact_type: "SubmissionForm",
			media_type: guessMediaType(filename),
			produced_by: operator,
			lineage: [],
			filename,
		},
		{ actor: operator },
	);
	return { artifact, appended: !known };
};

/** `aliquot intake <docx>`: the Operator drops a Submission Form on the society. */
export const intakeCommand: Command = {
	args: "<Submission Form .docx>",
	describe:
		"Store a Submission Form as an Operator Artifact, for the Director to propose its Tasks",
	run: async (args, ctx) => {
		const { positionals } = parseArgs({ args, allowPositionals: true });
		const [given, ...extra] = positionals;
		if (given === undefined || extra.length > 0) {
			throw new UsageError("intake takes exactly one Submission Form");
		}
		if (extname(given).toLowerCase() !== ".docx") {
			throw new UsageError(
				`intake takes a Submission Form as a .docx file, not ${JSON.stringify(given)}`,
			);
		}
		const { artifact, appended } = withLedger(ctx.home, true, (ledger) =>
			intake(ledger, ctx.home, fromInvocation(given)),
		);
		ctx.stdout.write(
			appended
				? `Stored ${artifact.id} SubmissionForm ${artifact.filename ?? ""}\n`
				: `${artifact.id} is already stored; nothing appended\n`,
		);
		return 0;
	},
};
