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

/**
 * Identity is per content, provenance is per production. `artifacts` holds
 * each id's first record (canonical); `provenance` holds every record for the
 * id in Ledger order: the first store, then each Run that produced the same
 * bytes again.
 */
export type ArtifactProjection = {
	readonly artifacts: ReadonlyMap<ArtifactId, StoredArtifact>;
	readonly provenance: ReadonlyMap<ArtifactId, readonly StoredArtifact[]>;
};

export const artifactProjection: Projection<ArtifactProjection> = {
	init: { artifacts: new Map(), provenance: new Map() },
	reduce: (state, event) => {
		if (event.kind !== "ArtifactStored") return state;
		const { id } = event.payload;
		return {
			artifacts: state.artifacts.has(id)
				? state.artifacts
				: new Map(state.artifacts).set(id, event.payload),
			provenance: new Map(state.provenance).set(id, [
				...(state.provenance.get(id) ?? []),
				event.payload,
			]),
		};
	},
};

const sameProducer = (a: Producer, b: Producer) =>
	a.tag === "Run" ? b.tag === "Run" && a.id === b.id : b.tag === "Operator";

/** The record a given producer wrote for `id`, if it wrote one. */
export const recordOf = (
	projection: ArtifactProjection,
	id: ArtifactId,
	producedBy: Producer,
): StoredArtifact | undefined =>
	projection.provenance
		.get(id)
		?.find((record) => sameProducer(record.produced_by, producedBy));

/**
 * The Lineage of one production of `id`: the record `producedBy` wrote, or
 * the canonical record when `producedBy` is omitted. Undefined when there is
 * no such record.
 */
export const lineageOf = (
	projection: ArtifactProjection,
	id: ArtifactId,
	producedBy?: Producer,
): readonly ArtifactId[] | undefined =>
	(producedBy
		? recordOf(projection, id, producedBy)
		: projection.artifacts.get(id)
	)?.lineage;

export const projectArtifacts = (ledger: Ledger): ArtifactProjection =>
	fold(ledger.events(), artifactProjection.reduce, artifactProjection.init);

/** Who produced an Artifact: a Run or the Operator. */
export type Producer = Artifact["produced_by"];

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
	 * Ledger already holds get a new record only when a Run produces them that
	 * has not recorded them yet; otherwise nothing is appended and the existing
	 * record comes back (the producer's own, else the canonical one).
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
			const projection = projectArtifacts(ledger);
			const canonical = projection.artifacts.get(id);
			if (canonical) {
				const own = recordOf(projection, id, meta.produced_by);
				if (own) return own;
				if (meta.produced_by.tag === "Operator") return canonical;
			}
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
