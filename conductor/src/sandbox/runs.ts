import type { PayloadOf } from "../events.js";
import type { RunId, Seq } from "../ids.js";
import { type Projection, Refusal } from "../reduce.js";
import type { Run } from "../types/script.js";

/** A Run as the Ledger knows it: started, and finished once RunFinished lands. */
export type RunRecord = {
	readonly started: PayloadOf<"RunStarted">;
	/** The Run and the seq of its RunFinished. */
	readonly finished?: { readonly run: Run; readonly seq: Seq };
};

export type RunProjection = {
	readonly runs: ReadonlyMap<RunId, RunRecord>;
};

/** Each Run starts once and finishes at most once, after it started. */
export const runProjection: Projection<RunProjection> = {
	init: { runs: new Map() },
	reduce: (state, event) => {
		if (event.kind === "RunStarted") {
			const { run_id } = event.payload;
			if (state.runs.has(run_id)) {
				return new Refusal(`${run_id} has already started`);
			}
			return {
				runs: new Map(state.runs).set(run_id, { started: event.payload }),
			};
		}
		if (event.kind === "RunFinished") {
			const run = event.payload;
			const record = state.runs.get(run.id);
			if (!record) return new Refusal(`${run.id} has no RunStarted`);
			if (record.finished) {
				return new Refusal(`${run.id} has already finished`);
			}
			return {
				runs: new Map(state.runs).set(run.id, {
					...record,
					finished: { run, seq: event.seq },
				}),
			};
		}
		return state;
	},
};
