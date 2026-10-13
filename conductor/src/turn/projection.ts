import type { PayloadOf } from "../events.js";
import type { AgentId, IsoTime, Seq, TurnId } from "../ids.js";
import { type Projection, Refusal } from "../reduce.js";
import type { TurnUsage } from "../types/turn.js";

/** A Turn as the Ledger knows it: started, and finished once TurnFinished lands. */
export type TurnRecord = {
	readonly started: PayloadOf<"TurnStarted">;
	/** The seq and time of its TurnStarted. */
	readonly seq: Seq;
	readonly at: IsoTime;
	readonly finished?: {
		readonly payload: PayloadOf<"TurnFinished">;
		readonly seq: Seq;
		readonly at: IsoTime;
	};
};

export type TurnState = {
	/** Every Turn, in the order it started. */
	readonly turns: ReadonlyMap<TurnId, TurnRecord>;
	/** The open Turn of each Agent that has one. */
	readonly open: ReadonlyMap<AgentId, TurnId>;
};

/** Each Turn starts once and finishes at most once, after it started. */
export const TurnProjection: Projection<TurnState> = {
	init: { turns: new Map(), open: new Map() },
	reduce: (state, event) => {
		if (event.kind === "TurnStarted") {
			const { turn_id, agent } = event.payload;
			if (state.turns.has(turn_id)) {
				return new Refusal(`${turn_id} has already started`);
			}
			return {
				turns: new Map(state.turns).set(turn_id, {
					started: event.payload,
					seq: event.seq,
					at: event.ts,
				}),
				open: new Map(state.open).set(agent, turn_id),
			};
		}
		if (event.kind === "TurnFinished") {
			const { turn_id } = event.payload;
			const turn = openTurn(state, turn_id);
			if (turn instanceof Refusal) return turn;
			const open = new Map(state.open);
			open.delete(turn.started.agent);
			return {
				turns: new Map(state.turns).set(turn_id, {
					...turn,
					finished: { payload: event.payload, seq: event.seq, at: event.ts },
				}),
				open,
			};
		}
		return state;
	},
};

/** The Turn `turn_id` while it is open: started, and not yet finished. */
export const openTurn = (
	state: TurnState,
	turn_id: TurnId,
): TurnRecord | Refusal => {
	const turn = state.turns.get(turn_id);
	if (turn === undefined) return new Refusal(`${turn_id} has not started`);
	if (turn.finished) return new Refusal(`${turn_id} has already finished`);
	return turn;
};

/** The tokens a Turn spends of the Energy budget: cache_read tokens are recorded but not counted. */
export const countedTokens = (usage: TurnUsage): number =>
	usage.input_tokens + usage.output_tokens + usage.cache_creation_tokens;

/**
 * The counted tokens of the Turns that finished after `from` and no later
 * than `to`: one Agent's, or the whole society's.
 */
export const tokensInWindow = (
	state: TurnState,
	whose: AgentId | "society",
	from: Date,
	to: Date,
): number => {
	let total = 0;
	for (const { started, finished } of state.turns.values()) {
		if (finished === undefined) continue;
		if (whose !== "society" && started.agent !== whose) continue;
		const at = Date.parse(finished.at);
		if (at > from.getTime() && at <= to.getTime()) {
			total += countedTokens(finished.payload.usage);
		}
	}
	return total;
};
