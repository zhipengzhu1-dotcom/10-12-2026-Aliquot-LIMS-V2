import { z } from "zod";
import { AgentId, RoomId, TaskId } from "../ids.js";
import { Actor } from "./actor.js";

/** Who belongs to a Room besides the Operator, who belongs to every Room. */
export const Membership = z.discriminatedUnion("tag", [
	z.strictObject({ tag: z.literal("Everyone") }),
	z.strictObject({ tag: z.literal("Listed"), agents: z.array(AgentId) }),
]);
export type Membership = z.infer<typeof Membership>;

export const Room = z.strictObject({
	id: RoomId,
	name: z.string().min(1),
	purpose: z.string(),
	membership: Membership,
	opened_by: Actor,
	task_id: TaskId.optional(),
});
export type Room = z.infer<typeof Room>;
