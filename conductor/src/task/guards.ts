import { type AppendGuard, AppendRefused } from "../append-guard.js";
import { fold } from "../reduce.js";
import {
	applyTaskEvent,
	TaskProjection,
	TransitionError,
} from "./projection.js";

/** Refuse any Event the Task state machine cannot express. */
const taskStateMachine: AppendGuard = (ctx, event) => {
	const view = fold(ctx.events, TaskProjection.reduce, TaskProjection.init);
	const next = applyTaskEvent(view, event);
	if (next instanceof TransitionError) throw new AppendRefused(next.message);
};

export const taskGuards: readonly AppendGuard[] = [taskStateMachine];
