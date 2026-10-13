import type { PayloadOf } from "../events.js";
import type { AgentId, Seq, SkillId } from "../ids.js";
import { type Projection, Refusal } from "../reduce.js";
import type { MemoryNote, Skill } from "../types/skill.js";

/** A Training payload with the seq of the Event that recorded it. */
export type Sequenced<T> = T & { readonly seq: Seq };

export type Coaching = Sequenced<PayloadOf<"HumanCoached">>;

export type TrainingState = {
	/** Each Agent's Memory notes, in seq order. */
	readonly notes: ReadonlyMap<AgentId, readonly Sequenced<MemoryNote>[]>;
	/** The Coaching each Agent has had, in seq order. */
	readonly coaching: ReadonlyMap<AgentId, readonly Coaching[]>;
	/** Every version of each Skill; version n is at index n - 1. */
	readonly skills: ReadonlyMap<SkillId, readonly Sequenced<Skill>[]>;
};

const appended = <K, V>(
	map: ReadonlyMap<K, readonly V[]>,
	key: K,
	value: V,
): ReadonlyMap<K, readonly V[]> =>
	new Map(map).set(key, [...(map.get(key) ?? []), value]);

/** The version the next SkillPublished of `id` records. */
export const nextVersion = (state: TrainingState, id: SkillId): number =>
	(state.skills.get(id)?.length ?? 0) + 1;

/**
 * Memory notes, Coaching and Skills from the Ledger. Each Skill's versions
 * run 1, 2, 3 with no gap; who may record each kind is the Training guard's.
 */
export const TrainingProjection: Projection<TrainingState> = {
	init: { notes: new Map(), coaching: new Map(), skills: new Map() },
	reduce: (state, event) => {
		const { seq } = event;
		switch (event.kind) {
			case "MemoryNoted":
				return {
					...state,
					notes: appended(state.notes, event.payload.agent, {
						...event.payload,
						seq,
					}),
				};
			case "HumanCoached":
				return {
					...state,
					coaching: appended(state.coaching, event.payload.agent_id, {
						...event.payload,
						seq,
					}),
				};
			case "SkillPublished": {
				const { id, version } = event.payload;
				const next = nextVersion(state, id);
				if (version !== next) {
					const at =
						next === 1 ? "has not been published" : `is at version ${next - 1}`;
					return new Refusal(
						`${id} ${at}, so its next version is ${next}, not ${version}`,
					);
				}
				return {
					...state,
					skills: appended(state.skills, id, { ...event.payload, seq }),
				};
			}
			default:
				return state;
		}
	},
};

/** The latest version of a Skill, or the version named. */
export const skillVersion = (
	state: TrainingState,
	id: SkillId,
	version?: number,
): Sequenced<Skill> | Refusal => {
	const versions = state.skills.get(id);
	if (versions === undefined)
		return new Refusal(`${id} has not been published`);
	const skill = version === undefined ? versions.at(-1) : versions[version - 1];
	return (
		skill ??
		new Refusal(
			`${id} has no version ${version}; its latest is ${versions.length}`,
		)
	);
};
