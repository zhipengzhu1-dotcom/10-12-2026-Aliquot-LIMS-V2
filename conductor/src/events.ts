import { z } from "zod";
import {
	AgentId,
	ArtifactId,
	EvaluationId,
	GateId,
	IsoTime,
	RoomId,
	RubricId,
	RunId,
	Seq,
	Sha256,
	TaskId,
	TurnId,
} from "./ids.js";
import { Action } from "./types/action.js";
import { Actor, EventActor } from "./types/actor.js";
import { AgentDefinition } from "./types/agent-definition.js";
import { StoredArtifact } from "./types/artifact.js";
import { GateDecision, GateKind } from "./types/gate.js";
import { Review } from "./types/merit.js";
import { Room } from "./types/room.js";
import { Run, Script, ScriptRef } from "./types/script.js";
import { MemoryNote, Skill } from "./types/skill.js";
import { TatClass } from "./types/task.js";
import { TurnOutcome, TurnUsage } from "./types/turn.js";
import { Mood, Policy, Vitality } from "./types/vitality.js";

// One line per Event kind. A ticket that owns a kind may tighten its payload
// here; adding a kind is a new line, never a change to an existing one.
const body = <K extends string, P extends z.ZodType>(kind: K, payload: P) =>
	z.object({ kind: z.literal(kind), payload });

const TaskReview = z.discriminatedUnion("tag", [
	z.strictObject({ tag: z.literal("Required"), reviewer: Actor }),
	z.strictObject({ tag: z.literal("Skipped"), reason: z.string() }),
	z.strictObject({ tag: z.literal("Reviewed") }),
]);

// Every kind but GateDecided, whose body differs between the caller and the
// Ledger: see `EventBody` and `NewEvent` below.
const BODIES = [
	body("AgentRecruited", AgentDefinition),
	body(
		"AgentDefinitionRevised",
		z.strictObject({ definition: AgentDefinition }),
	),
	body(
		"AgentPaused",
		z.strictObject({ agent_id: AgentId, reason: z.string() }),
	),
	body("AgentResumed", z.strictObject({ agent_id: AgentId })),
	body(
		"AgentRetired",
		z.strictObject({
			agent_id: AgentId,
			reason: z.string(),
			gate_id: GateId.optional(),
		}),
	),
	body(
		"TaskProposed",
		z.strictObject({
			task_id: TaskId,
			title: z.string().min(1),
			goal: z.string(),
			inputs: z.array(ArtifactId),
			rubric_id: RubricId,
			priority: z.number().int(),
			tat_class: TatClass,
			parent_task: TaskId.optional(),
		}),
	),
	body("TaskAssigned", z.strictObject({ task_id: TaskId, assignee: AgentId })),
	body("TaskStarted", z.strictObject({ task_id: TaskId })),
	body(
		"TaskHandedOff",
		z.strictObject({
			task_id: TaskId,
			from: AgentId,
			to: AgentId,
			reason: z.string(),
		}),
	),
	body(
		"TaskCompleted",
		z.strictObject({
			task_id: TaskId,
			outputs: z.array(ArtifactId),
			review: TaskReview,
		}),
	),
	body("TaskFailed", z.strictObject({ task_id: TaskId, reason: z.string() })),
	body(
		"TaskEscalated",
		z.strictObject({ task_id: TaskId, to: Actor, reason: z.string() }),
	),
	body("RoomOpened", z.strictObject({ room: Room })),
	body(
		"MessageSent",
		z.strictObject({ room_id: RoomId, body: z.string().min(1) }),
	),
	body(
		"HelpRequested",
		z.strictObject({
			task_id: TaskId,
			to: Actor,
			question: z.string().min(1),
		}),
	),
	body("ScriptRegistered", Script),
	body("ScriptRevised", Script),
	body(
		"RunStarted",
		z.strictObject({
			run_id: RunId,
			script: ScriptRef,
			inputs: z.array(ArtifactId),
		}),
	),
	body("RunFinished", Run),
	body("ArtifactStored", StoredArtifact),
	body(
		"EvaluationRecorded",
		z.strictObject({
			eval_id: EvaluationId,
			// Absent only from an Evaluation recorded before the stage table
			// existed (ADR-0012); the workflow guard refuses a new one without it.
			stage: z.number().int().min(1).optional(),
			run_id: RunId,
			task_id: TaskId,
			score: z.number().min(0).max(1),
			passed: z.boolean(),
			findings: z.array(z.string()),
		}),
	),
	body("ReviewRecorded", Review),
	body("VitalitySampled", Vitality),
	body(
		"RestOrdered",
		z.strictObject({
			agent_id: AgentId,
			action: z.enum(["begin", "end"]),
			reason: z.string(),
		}),
	),
	body(
		"GateRequested",
		z.strictObject({
			gate_id: GateId,
			kind: GateKind,
			payload: z.json(),
			payload_hash: Sha256,
			lifetime_s: z.number().int().positive(),
		}),
	),
	body(
		"HumanCoached",
		z.strictObject({
			agent_id: AgentId,
			task_id: TaskId.optional(),
			note: z.string().min(1),
		}),
	),
	body("MemoryNoted", MemoryNote),
	body("SkillPublished", Skill),
	body(
		"TurnStarted",
		z.strictObject({
			turn_id: TurnId,
			agent: AgentId,
			model: z.string().min(1),
			mood: Mood,
			policy: Policy,
		}),
	),
	body(
		"TurnFinished",
		z.strictObject({
			turn_id: TurnId,
			usage: TurnUsage,
			outcome: TurnOutcome,
			tool_calls: z.number().int().nonnegative(),
		}),
	),
	body(
		"ActionRefused",
		z.strictObject({
			agent: AgentId,
			tool: z.string().min(1),
			action: z.union([Action, z.literal("Policy")]),
			reason: z.string().min(1),
			task_id: TaskId.optional(),
		}),
	),
	body(
		"ReceivingLogNamed",
		z.strictObject({ path: z.string().min(1), sha256: Sha256 }),
	),
] as const;

export const EventBody = z.discriminatedUnion("kind", [
	...BODIES,
	body("GateDecided", GateDecision),
]);
export type EventBody = z.infer<typeof EventBody>;
export type EventKind = EventBody["kind"];
export type PayloadOf<K extends EventKind> = Extract<
	EventBody,
	{ kind: K }
>["payload"];

const envelope = {
	actor: EventActor,
	task_id: TaskId.optional(),
	causation_id: Seq.optional(),
};

const recorded = {
	seq: Seq,
	ts: IsoTime,
	prev_hash: Sha256,
	hash: Sha256,
};

// Every level refuses unknown keys: payload schemas are strict, and the
// preprocess pass refuses unknown top-level keys before the envelope and the
// kind's payload are checked.
const withBody = <S extends z.ZodRawShape, B extends z.ZodType>(
	shape: S,
	bodies: B,
) => {
	const allowed = new Set([...Object.keys(shape), "kind", "payload"]);
	return z.preprocess(
		(input, ctx) => {
			if (
				typeof input === "object" &&
				input !== null &&
				!Array.isArray(input)
			) {
				const keys = Object.keys(input).filter((k) => !allowed.has(k));
				if (keys.length > 0) ctx.addIssue({ code: "unrecognized_keys", keys });
			}
			return input;
		},
		z.intersection(z.object(shape), bodies),
	);
};

/**
 * What a caller hands to `Ledger.append`. The Ledger assigns the rest, and
 * stamps a GateDecided's `decided_at` with the Event's own `ts`, so the
 * signature time is the time the decision is recorded (ADR-0006).
 */
export const NewEvent = withBody(
	envelope,
	z.discriminatedUnion("kind", [
		...BODIES,
		body("GateDecided", GateDecision.omit({ decided_at: true })),
	]),
);
export type NewEvent = z.infer<typeof NewEvent>;

/** One numbered entry in the Ledger. */
export const Event = withBody({ ...recorded, ...envelope }, EventBody);
export type Event = z.infer<typeof Event>;
