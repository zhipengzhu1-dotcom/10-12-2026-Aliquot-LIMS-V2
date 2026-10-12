import type { ScriptId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import { fold, type Projection } from "../reduce.js";
import type { Script, ScriptRef } from "../types/script.js";

/** Every registered Script, each with its versions in order. */
export type ScriptProjection = {
	readonly scripts: ReadonlyMap<ScriptId, readonly Script[]>;
};

export const scriptProjection: Projection<ScriptProjection> = {
	init: { scripts: new Map() },
	reduce: (state, event) =>
		event.kind === "ScriptRegistered" || event.kind === "ScriptRevised"
			? {
					scripts: new Map(state.scripts).set(event.payload.id, [
						...(state.scripts.get(event.payload.id) ?? []),
						event.payload,
					]),
				}
			: state,
};

export const projectScripts = (ledger: Ledger): ScriptProjection =>
	fold(ledger.events(), scriptProjection.reduce, scriptProjection.init);

export const findScript = (
	state: ScriptProjection,
	ref: ScriptRef,
): Script | undefined =>
	state.scripts.get(ref.id)?.find((s) => s.version === ref.version);
