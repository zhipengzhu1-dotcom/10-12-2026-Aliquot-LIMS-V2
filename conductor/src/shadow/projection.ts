import type { Seq, Sha256 } from "../ids.js";
import type { Projection } from "../reduce.js";
import type { EventActor } from "../types/actor.js";

/** The lab's Receiving Log workbook as this home names it (ADR-0018). */
export type NamedReceivingLog = {
	/** Where the workbook lives on this machine. The Conductor only reads it. */
	readonly path: string;
	/** The workbook's sha256 when it was named. */
	readonly sha256: Sha256;
	readonly named_by: EventActor;
	/** The seq of its ReceivingLogNamed. */
	readonly seq: Seq;
};

/** The parallel run's setting: the lab's Receiving Log, once named. */
export type ShadowState = {
	readonly receiving_log?: NamedReceivingLog | undefined;
};

/** The latest ReceivingLogNamed names the workbook; an earlier one is superseded. */
export const ShadowProjection: Projection<ShadowState> = {
	init: {},
	reduce: (state, event) =>
		event.kind === "ReceivingLogNamed"
			? {
					receiving_log: {
						...event.payload,
						named_by: event.actor,
						seq: event.seq,
					},
				}
			: state,
};
