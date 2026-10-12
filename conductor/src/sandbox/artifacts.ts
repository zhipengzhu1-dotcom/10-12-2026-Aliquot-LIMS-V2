import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../hash.js";
import { ArtifactId, type Seq, Sha256, type TaskId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import { fold, type Projection } from "../reduce.js";
import type { Actor } from "../types/actor.js";
import type {
	Artifact,
	ArtifactFilename,
	StoredArtifact,
} from "../types/artifact.js";

/** Every Artifact the Ledger has recorded, by id. */
export type ArtifactProjection = {
	readonly artifacts: ReadonlyMap<ArtifactId, StoredArtifact>;
};

export const artifactProjection: Projection<ArtifactProjection> = {
	init: { artifacts: new Map() },
	reduce: (state, event) =>
		event.kind !== "ArtifactStored" || state.artifacts.has(event.payload.id)
			? state
			: {
					artifacts: new Map(state.artifacts).set(
						event.payload.id,
						event.payload,
					),
				},
};

export const projectArtifacts = (ledger: Ledger): ArtifactProjection =>
	fold(ledger.events(), artifactProjection.reduce, artifactProjection.init);

/** What the caller says about the bytes; the store derives id and sha256. */
export type ArtifactMeta = Pick<
	Artifact,
	"artifact_type" | "media_type" | "produced_by"
> & { lineage: readonly ArtifactId[]; filename?: ArtifactFilename };

/** Envelope fields for the ArtifactStored Event. */
export type EventContext = {
	actor: Actor;
	task_id?: TaskId | undefined;
	causation_id?: Seq | undefined;
};

export type Artifacts = {
	/**
	 * Write the bytes to `blobs/<sha256>` and record ArtifactStored. Bytes the
	 * Ledger already holds keep their first record: no new Event, and the
	 * existing Artifact comes back unchanged.
	 */
	store(
		bytes: Uint8Array,
		meta: ArtifactMeta,
		by: EventContext,
	): StoredArtifact;
	/** The bytes, checked against the id. */
	read(id: ArtifactId): Buffer;
	/** Where the bytes live on disk. */
	path(id: ArtifactId): string;
};

/** The blob's bytes no longer hash to its id. */
export class ArtifactCorrupt extends Error {
	override readonly name = "ArtifactCorrupt";
}

export const openArtifacts = ({
	ledger,
	home,
}: {
	ledger: Ledger;
	home: string;
}): Artifacts => {
	const blobs = join(home, "blobs");
	const path = (id: ArtifactId) => join(blobs, id);

	const writeBlob = (id: ArtifactId, bytes: Uint8Array) => {
		if (existsSync(path(id))) return;
		mkdirSync(blobs, { recursive: true });
		const partial = join(blobs, `.${id}.${randomUUID()}.partial`);
		writeFileSync(partial, bytes, { flag: "wx", mode: 0o444 });
		renameSync(partial, path(id));
	};

	return {
		path,
		read: (id) => {
			const bytes = readFileSync(path(id));
			const actual: string = sha256Hex(bytes);
			if (actual !== id) {
				throw new ArtifactCorrupt(
					`blob ${path(id)} hashes to ${actual}, not its id ${id}`,
				);
			}
			return bytes;
		},
		store: (bytes, meta, by) => {
			const digest = sha256Hex(bytes);
			const id = ArtifactId.parse(digest);
			writeBlob(id, bytes);
			const existing = projectArtifacts(ledger).artifacts.get(id);
			if (existing) return existing;
			const event = ledger.append({
				...by,
				kind: "ArtifactStored",
				payload: {
					id,
					sha256: Sha256.parse(digest),
					...meta,
					lineage: [...meta.lineage],
				},
			});
			if (event.kind !== "ArtifactStored") throw new Error("unreachable");
			return event.payload;
		},
	};
};
