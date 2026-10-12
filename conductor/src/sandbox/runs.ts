import type { PayloadOf } from "../events.js";
import type { RunId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import { fold, type Projection } from "../reduce.js";
import type { Run } from "../types/script.js";

/** A Run as the Ledger knows it: started, and finished once RunFinished lands. */
export type RunRecord = {
	readonly started: PayloadOf<"RunStarted">;
	readonly finished?: Run;
};

export type RunProjection = {
	readonly runs: ReadonlyMap<RunId, RunRecord>;
};

export const runProjection: Projection<RunProjection> = {
	init: { runs: new Map() },
	reduce: (state, event) => {
		if (event.kind === "RunStarted") {
			return {
				runs: new Map(state.runs).set(event.payload.run_id, {
					started: event.payload,
				}),
			};
		}
		if (event.kind === "RunFinished") {
			const record = state.runs.get(event.payload.id);
			if (!record) return state;
			return {
				runs: new Map(state.runs).set(event.payload.id, {
					...record,
					finished: event.payload,
				}),
			};
		}
		return state;
	},
};

export const projectRuns = (ledger: Ledger): RunProjection =>
	fold(ledger.events(), runProjection.reduce, runProjection.init);
