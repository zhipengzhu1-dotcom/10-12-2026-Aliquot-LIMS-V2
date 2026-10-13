import type { AppendGuard, CatchUp, FollowOn } from "./append-guard.js";
import { gateGuards } from "./gate/guards.js";
import { orgGuards } from "./org/guards.js";
import { roomGuards } from "./room/guards.js";
import { sandboxGuards } from "./sandbox/guards.js";
import { stage1Guards } from "./stage1/guards.js";
import { taskGuards } from "./task/guards.js";
import { turnGuards } from "./turn/guards.js";
import { vitalityGuards } from "./vitality/guards.js";
import { tierCatchUp, tierRevisions } from "./vitality/projection.js";

export {
	type AppendGuard,
	AppendRefused,
	type CatchUp,
	type FollowOn,
	refusalText,
} from "./append-guard.js";

/** Every guard the Ledger runs, in order. Each domain owns its own list. */
export const appendGuards: readonly AppendGuard[] = [
	...orgGuards,
	...taskGuards,
	...roomGuards,
	...turnGuards,
	...gateGuards,
	...sandboxGuards,
	...vitalityGuards,
	...stage1Guards,
];

/** Every follow-on the Ledger appends after an Event, in order. */
export const appendFollowOns: readonly FollowOn[] = [tierRevisions];

/** Every catch-up the Ledger appends when it opens for writing, in order. */
export const ledgerCatchUps: readonly CatchUp[] = [tierCatchUp];
