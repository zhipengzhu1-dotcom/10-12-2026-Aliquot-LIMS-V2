import { z } from "zod";
import { GateId, IsoTime, Sha256 } from "../ids.js";

export const GateKind = z.enum([
	"Deploy",
	"WriteSystemOfRecord",
	"ExternalMessage",
	"RetireAgent",
	"PromoteToMentor",
]);
export type GateKind = z.infer<typeof GateKind>;

export const GateState = z.enum(["Open", "Approved", "Rejected", "Expired"]);
export type GateState = z.infer<typeof GateState>;

export const GateDecision = z.strictObject({
	gate_id: GateId,
	decided_by: z.strictObject({ tag: z.literal("Operator") }),
	decided_at: IsoTime,
	payload_hash: Sha256,
	meaning: z.enum(["approve", "reject"]),
	reason: z.string(),
});
export type GateDecision = z.infer<typeof GateDecision>;
