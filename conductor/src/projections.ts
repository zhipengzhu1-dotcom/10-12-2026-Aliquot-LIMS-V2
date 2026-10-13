import type { Event } from "./events.js";
import { GateProjection, type Gates } from "./gate/projection.js";
import { OrgProjection, type OrgState } from "./org/projection.js";
import { type Projection, Refusal } from "./reduce.js";
import { RoomProjection, type RoomState } from "./room/projection.js";
import {
	type ArtifactProjection,
	artifactProjection,
} from "./sandbox/artifacts.js";
import { type RunProjection, runProjection } from "./sandbox/runs.js";
import { type ScriptProjection, scriptProjection } from "./sandbox/scripts.js";
import { TaskProjection, type TaskView } from "./task/projection.js";
import { TrustProjection, type TrustState } from "./vitality/trust.js";
import { WorkProjection, type WorkState } from "./vitality/work.js";

/**
 * Every Projection the Ledger keeps (ADR-0001). The Ledger builds them from
 * its Events once when it opens and advances them by each Event it appends;
 * guards, follow-ons and commands read them and never fold Events
 * themselves.
 */
export type Projections = {
	readonly org: OrgState;
	readonly tasks: TaskView;
	readonly gates: Gates;
	readonly rooms: RoomState;
	readonly scripts: ScriptProjection;
	readonly runs: RunProjection;
	readonly artifacts: ArtifactProjection;
	readonly work: WorkState;
	readonly trust: TrustState;
};

const PROJECTIONS: { [K in keyof Projections]: Projection<Projections[K]> } = {
	org: OrgProjection,
	tasks: TaskProjection,
	gates: GateProjection,
	rooms: RoomProjection,
	scripts: scriptProjection,
	runs: runProjection,
	artifacts: artifactProjection,
	work: WorkProjection,
	trust: TrustProjection,
};

const KEYS = Object.keys(PROJECTIONS) as (keyof Projections)[];

/** The Projections of an empty Ledger. */
export const emptyProjections = (): Projections =>
	Object.fromEntries(
		KEYS.map((key) => [key, PROJECTIONS[key].init]),
	) as Projections;

/**
 * The Projections after `event`, each reading the others as they stood
 * before it, or the first Projection's reason it cannot apply `event`.
 */
export const advance = (
	before: Projections,
	event: Event,
): Projections | Refusal => {
	const reduced = <K extends keyof Projections>(key: K) =>
		PROJECTIONS[key].reduce(before[key], event, before);
	const after: Partial<Record<keyof Projections, unknown>> = {};
	for (const key of KEYS) {
		const next = reduced(key);
		if (next instanceof Refusal) return next;
		after[key] = next;
	}
	return after as Projections;
};
