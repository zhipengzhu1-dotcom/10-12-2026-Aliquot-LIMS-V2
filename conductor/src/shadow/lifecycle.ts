import { readFileSync } from "node:fs";
import { orRefuse } from "../append-guard.js";
import { sha256Hex } from "../hash.js";
import type { Ledger } from "../ledger.js";
import { type Recorded, readBack } from "../lifecycle-support.js";
import { openArtifacts } from "../sandbox/artifacts.js";
import type { Person } from "../types/actor.js";
import type { StoredArtifact } from "../types/artifact.js";
import { namingRefusal } from "./guards.js";
import type { NamedReceivingLog } from "./projection.js";

const XLSX =
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * The bytes of the lab's workbook. `readFileSync` opens the file read-only;
 * nothing in the Conductor opens it any other way (ADR-0018).
 */
const readOnly = (path: string): Buffer => {
	try {
		return readFileSync(path);
	} catch (error) {
		throw new Error(
			`the lab's Receiving Log ${path} cannot be read: ${(error as Error).message}`,
		);
	}
};

/**
 * The person names the lab's Receiving Log workbook for this home by its
 * absolute path. The Ledger records the path and the file's sha256, never its
 * contents. A naming after the first names the one it supersedes as its cause.
 */
export const nameReceivingLog = (
	ledger: Ledger,
	{ actor, path }: { readonly actor: Person; readonly path: string },
): Recorded<"receiving_log", NamedReceivingLog> => {
	orRefuse("ReceivingLogNamed", namingRefusal(actor, path));
	const sha256 = sha256Hex(readOnly(path));
	const previous = ledger.projections.shadow.receiving_log;
	const { seq } = ledger.append({
		actor,
		...(previous ? { causation_id: previous.seq } : {}),
		kind: "ReceivingLogNamed",
		payload: { path, sha256 },
	});
	return {
		receiving_log: readBack(
			ledger.projections.shadow.receiving_log,
			"the named Receiving Log",
		),
		seq,
	};
};

/**
 * A fresh read of the lab's Receiving Log, stored as the person's
 * `ReceivingLog` Artifact naming the ReceivingLogNamed as its cause, so a
 * Script sees only the Artifact and never the file. Undefined when this home
 * names none.
 */
export const readReceivingLog = (
	ledger: Ledger,
	home: string,
	actor: Person,
): Recorded<"artifact", StoredArtifact> | undefined => {
	const named = ledger.projections.shadow.receiving_log;
	if (named === undefined) return undefined;
	return openArtifacts({ ledger, home }).store(
		readOnly(named.path),
		{
			artifact_type: "ReceivingLog",
			media_type: XLSX,
			produced_by: actor,
			lineage: [],
			filename: "receiving-log.xlsx",
		},
		{ actor, cause: named.seq },
	);
};
