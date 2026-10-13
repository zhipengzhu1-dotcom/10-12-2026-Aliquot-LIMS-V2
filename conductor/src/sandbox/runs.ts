import type { PayloadOf } from "../events.js";
import type { RunId, Seq, TaskId } from "../ids.js";
import { type Projection, Refusal } from "../reduce.js";
import type { Run } from "../types/script.js";

/** A Run as the Ledger knows it: started, and finished once RunFinished lands. */
export type RunRecord = {
	readonly started: PayloadOf<"RunStarted">;
	/** The seq of its RunStarted. */
	readonly seq: Seq;
	/** The Task its RunStarted named, if any. */
	readonly task_id?: TaskId | undefined;
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
				runs: new Map(state.runs).set(run_id, {
					started: event.payload,
					seq: event.seq,
					task_id: event.task_id,
				}),
			};
		}
		if (event.kind === "RunFinished") {
			const run = event.payload;
			const record = startedRun(state, run.id);
			if (record instanceof Refusal) return record;
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

/** The Run `run_id` once its RunStarted is in the Ledger. */
export const startedRun = (
	state: RunProjection,
	run_id: RunId,
): RunRecord | Refusal =>
	state.runs.get(run_id) ?? new Refusal(`${run_id} has no RunStarted`);

/** The Run `run_id` while it runs: started, and not yet finished. */
export const runningRun = (
	state: RunProjection,
	run_id: RunId,
): RunRecord | Refusal => {
	const run = state.runs.get(run_id);
	if (run === undefined) return new Refusal(`${run_id} has not started`);
	if (run.finished) return new Refusal(`${run_id} has already finished`);
	return run;
};
