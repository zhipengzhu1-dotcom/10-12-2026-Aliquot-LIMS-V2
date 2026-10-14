import { isAbsolute } from "node:path";
import { type AppendGuard, reasonOf } from "../append-guard.js";
import { Refusal } from "../reduce.js";
import { actorText, type EventActor } from "../types/actor.js";

/**
 * Only a person acting as the Operator names the lab's Receiving Log
 * (ADR-0019), by an absolute path, so the setting means the same file
 * wherever a command runs.
 */
export const namingRefusal = (
	actor: EventActor,
	path: string,
): Refusal | undefined => {
	if (actor.tag !== "Operator" || actor.email === undefined) {
		return new Refusal(
			`only a named person acting as the Operator names the lab's Receiving Log, not ${actorText(actor)}`,
		);
	}
	if (!isAbsolute(path)) {
		return new Refusal(`the Receiving Log's path ${path} is not absolute`);
	}
	return undefined;
};

const naming: AppendGuard = (_, event) =>
	event.kind === "ReceivingLogNamed"
		? reasonOf(namingRefusal(event.actor, event.payload.path))
		: undefined;

export const shadowGuards: readonly AppendGuard[] = [naming];
