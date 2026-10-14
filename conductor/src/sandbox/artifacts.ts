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
import { ArtifactId, type Seq, Sha256 } from "../ids.js";
import type { Ledger } from "../ledger.js";
import type { Recorded } from "../lifecycle-support.js";
import { type Projection, Refusal } from "../reduce.js";
import type { EventActor } from "../types/actor.js";
import type {
	Artifact,
	ArtifactFilename,
	StoredArtifact,
} from "../types/artifact.js";
import { store } from "./lifecycle.js";

/** One ArtifactStored: the record it wrote, and its seq. */
export type Production = {
	readonly seq: Seq;
	readonly record: StoredArtifact;
};

/**
 * Identity is per content, and each production has its own record.
 * `artifacts` holds each id's first record (canonical); `productions` holds
 * every record for the id in Ledger order: the first store, then each Run
 * that produced the same bytes again.
 */
export type ArtifactProjection = {
	readonly artifacts: ReadonlyMap<ArtifactId, StoredArtifact>;
	readonly productions: ReadonlyMap<ArtifactId, readonly Production[]>;
};

/**
 * The same bytes may be recorded again, once per Run that produces them;
 * the Operator stores them once.
 */
export const artifactProjection: Projection<ArtifactProjection> = {
	init: { artifacts: new Map(), productions: new Map() },
	reduce: (state, event) => {
		if (event.kind !== "ArtifactStored") return state;
		const record = event.payload;
		const { id, produced_by } = record;
		if (state.artifacts.has(id)) {
			if (produced_by.tag !== "Run") {
				return new Refusal(`${id} is already stored`);
			}
			if (productionOf(state, id, produced_by)) {
				return new Refusal(`${produced_by.id} already stored ${id}`);
			}
		}
		return {
			artifacts: state.artifacts.has(id)
				? state.artifacts
				: new Map(state.artifacts).set(id, record),
			productions: new Map(state.productions).set(id, [
				...(state.productions.get(id) ?? []),
				{ seq: event.seq, record },
			]),
		};
	},
};

const sameProducer = (a: Producer, b: Producer) =>
	a.tag === "Run" ? b.tag === "Run" && a.id === b.id : b.tag === "Operator";

/** The production of `id` by a given producer, if it stored one. */
export const productionOf = (
	projection: ArtifactProjection,
	id: ArtifactId,
	producedBy: Producer,
): Production | undefined =>
	projection.productions
		.get(id)
		?.find((p) => sameProducer(p.record.produced_by, producedBy));

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
		? productionOf(projection, id, producedBy)?.record
		: projection.artifacts.get(id)
	)?.lineage;

/** One production on the walk back from an Artifact, and how far back it is. */
export type LineageLink = {
	readonly depth: number;
	readonly production: Production;
};

/**
 * Each production of `id`, followed by the walk back through its Lineage,
 * depth first, down to the Artifacts that have none. An Artifact already on
 * the path is not walked again, so a Run that wrote back its own input does
 * not loop.
 */
export const walkLineage = (
	projection: ArtifactProjection,
	id: ArtifactId,
): LineageLink[] => {
	const walk = (
		id: ArtifactId,
		depth: number,
		path: ReadonlySet<ArtifactId>,
	): LineageLink[] => {
		const on = new Set(path).add(id);
		return (projection.productions.get(id) ?? []).flatMap((production) => [
			{ depth, production },
			...production.record.lineage
				.filter((input) => !on.has(input))
				.flatMap((input) => walk(input, depth + 1, on)),
		]);
	};
	return walk(id, 0, new Set());
};

/** Who produced an Artifact: a Run or the Operator. */
export type Producer = Artifact["produced_by"];

/** What the caller says about the bytes; the store derives id and sha256. */
export type ArtifactMeta = Pick<
	Artifact,
	"artifact_type" | "media_type" | "produced_by"
> & { lineage: readonly ArtifactId[]; filename?: ArtifactFilename };

export type Artifacts = {
	/**
	 * Write the bytes to `blobs/<sha256>` and store them through the Sandbox
	 * lifecycle, which returns the record of these bytes for this producer
	 * and the seq of its ArtifactStored.
	 */
	store(
		bytes: Uint8Array,
		meta: ArtifactMeta,
		by: { readonly actor: EventActor; readonly cause?: Seq },
	): Recorded<"artifact", StoredArtifact>;
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
			const sha256 = Sha256.parse(sha256Hex(bytes));
			writeBlob(ArtifactId.parse(sha256), bytes);
			return store(ledger, by, { sha256, ...meta });
		},
	};
};
