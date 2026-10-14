import { z } from "zod";
import { AppendRefused } from "../append-guard.js";
import type { Event } from "../events.js";
import { decideGate, requestGate } from "../gate/lifecycle.js";
import { AgentId, GateId, RoomId, Seq, Sha256, TaskId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import { readBack } from "../lifecycle-support.js";
import { pause, resume, revise } from "../org/lifecycle.js";
import { open, say } from "../room/lifecycle.js";
import { assign, handOff, review } from "../task/lifecycle.js";
import { giveCoaching } from "../training/lifecycle.js";
import type { Person } from "../types/actor.js";
import { AgentDefinition } from "../types/agent-definition.js";
import { Review } from "../types/merit.js";
import { Room } from "../types/room.js";
import { orderRest } from "../vitality/lifecycle.js";

const Reason = z.string().regex(/\S/, "must not be empty");

type Action<B extends z.ZodType> = {
	readonly body: B;
	/** Run the lifecycle verb as `by`, the person acting as the Operator, and return the seq of its Event. */
	readonly run: (ledger: Ledger, body: z.infer<B>, by: Person) => Seq;
};

const action = <B extends z.ZodType>(
	body: B,
	run: (ledger: Ledger, body: z.infer<B>, by: Person) => Seq,
): Action<B> => ({ body, run });

/**
 * The Operator's actions, by the verb in `/api/actions/<verb>`. Each
 * runs the lifecycle verb its command runs, always as the Operator, named by
 * the person the request came from: the body takes no `--as`, and a Room the
 * Operator opens is opened by that person.
 */
export const ACTIONS = {
	pause: action(
		z.strictObject({ agent_id: AgentId, reason: Reason }),
		(ledger, body, by) => pause(ledger, { actor: by, ...body }).seq,
	),
	resume: action(
		z.strictObject({ agent_id: AgentId }),
		(ledger, body, by) => resume(ledger, { actor: by, ...body }).seq,
	),
	revise: action(
		z.strictObject({ definition: AgentDefinition }),
		(ledger, body, by) => revise(ledger, { actor: by, ...body }).seq,
	),
	"retire-request": action(
		z.strictObject({ agent_id: AgentId, reason: Reason }),
		(ledger, payload, by) =>
			requestGate(ledger, { actor: by, kind: "RetireAgent", payload }).seq,
	),
	"gate-decide": action(
		z.strictObject({
			gate_id: GateId,
			decision: z.enum(["approve", "reject"]),
			hash: Sha256,
			reason: Reason,
		}),
		(ledger, { gate_id, decision, hash, reason }, by) =>
			decideGate(ledger, {
				actor: by,
				gate_id,
				meaning: decision,
				payload_hash: hash,
				reason,
			}).seq,
	),
	"task-assign": action(
		z.strictObject({ task_id: TaskId, assignee: AgentId }),
		(ledger, body, by) => assign(ledger, { actor: by, ...body }).seq,
	),
	"task-handoff": action(
		z.strictObject({ task_id: TaskId, to: AgentId, reason: Reason }),
		(ledger, body, by) => handOff(ledger, { actor: by, ...body }).seq,
	),
	"task-review": action(
		Review.omit({ reviewer: true }),
		(ledger, body, by) => review(ledger, { ...body, reviewer: by }).seq,
	),
	"room-say": action(
		z.strictObject({
			room_id: RoomId,
			body: z.string().min(1),
			reply_to: Seq.optional(),
		}),
		(ledger, body, by) => say(ledger, { actor: by, ...body }).seq,
	),
	"room-open": action(
		Room.omit({ opened_by: true }),
		(ledger, room, by) => open(ledger, { ...room, opened_by: by }).seq,
	),
	"rest-order": action(
		z.strictObject({
			agent_id: AgentId,
			action: z.enum(["begin", "end"]),
			reason: Reason,
		}),
		(ledger, body, by) => orderRest(ledger, { actor: by, ...body }).seq,
	),
	coach: action(
		z.strictObject({
			agent_id: AgentId,
			note: Reason,
			task_id: TaskId.optional(),
		}),
		(ledger, body, by) => giveCoaching(ledger, { actor: by, ...body }).seq,
	),
} satisfies Record<string, Action<z.ZodType>>;

export type Verb = keyof typeof ACTIONS;

/** What an action answers: its Event, or why it wrote nothing. */
export type ActionResult =
	| { readonly status: 200; readonly event: Event }
	| { readonly status: 400 | 404 | 409; readonly text: string };

/**
 * Run `verb` on `input`, the request body as parsed JSON, as `by`. A body
 * that does not fit the verb is a usage error (400), and a refusal is the
 * Ledger's own text (409), as the command prints it.
 */
export const runAction = (
	ledger: Ledger,
	verb: string,
	input: unknown,
	by: Person,
): ActionResult => {
	if (!Object.hasOwn(ACTIONS, verb)) {
		return { status: 404, text: `no action ${verb}` };
	}
	const { body, run } = ACTIONS[verb as Verb] as Action<z.ZodType>;
	const parsed = body.safeParse(input);
	if (!parsed.success) {
		return {
			status: 400,
			text: `${verb} takes a different body: ${z.prettifyError(parsed.error)}`,
		};
	}
	const written: Event[] = [];
	const stop = ledger.onAppend((event) => written.push(event));
	let seq: Seq;
	try {
		seq = run(ledger, parsed.data, by);
	} catch (error) {
		if (error instanceof AppendRefused) {
			return { status: 409, text: error.message };
		}
		throw error;
	} finally {
		stop();
	}
	return {
		status: 200,
		event: readBack(
			written.find((event) => event.seq === seq),
			`Event ${seq}`,
		),
	};
};
