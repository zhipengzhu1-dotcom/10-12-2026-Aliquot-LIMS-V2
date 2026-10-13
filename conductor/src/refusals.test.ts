import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendRefused } from "./append-guard.js";
import type { NewEvent } from "./events.js";
import { canonicalJson, sha256Hex } from "./hash.js";
import {
	AgentId,
	ArtifactId,
	EvaluationId,
	GateId,
	RoomId,
	RunId,
	ScriptId,
	Sha256,
	TaskId,
} from "./ids.js";
import { open } from "./room/lifecycle.js";
import {
	type NonTaskEvent,
	type Scenario,
	scenario,
} from "./test-support/scenario.js";

const operator = { tag: "Operator" } as const;
const agent = (slug: string) =>
	({ tag: "Agent", id: AgentId.parse(`A-${slug}`) }) as const;
const rin = agent("rin");
const nobody = AgentId.parse("A-nobody");
const T1 = TaskId.parse("T-1");
const G1 = GateId.parse("G-1");
const bytes = (c: string) => ArtifactId.parse(c.repeat(64));

const gateRequest: NonTaskEvent = {
	actor: rin,
	kind: "GateRequested",
	payload: {
		gate_id: G1,
		kind: "Deploy",
		payload: {},
		payload_hash: sha256Hex(canonicalJson({})),
		lifetime_s: 3600,
	},
};

let s: Scenario;
beforeEach(() => {
	s = scenario("2026-10-12T09:00:00.000Z");
});
afterEach(() => s.close());

/** A guard or Projection, the Event it refuses after `setup`, and the refusal. */
type Row = [
	refuser: string,
	refused: (s: Scenario) => NewEvent,
	refusal: string,
];

const ROWS: Row[] = [
	[
		"the Conductor guard",
		() => ({
			actor: { tag: "Conductor" },
			kind: "AgentPaused",
			payload: { agent_id: rin.id, reason: "Tired" },
		}),
		"AgentPaused refused: the Conductor authors only tier Revisions",
	],
	[
		"the Org guard",
		(s) => {
			const thorne = s.ledger.projections.org.agents.get(
				AgentId.parse("A-thorne"),
			)?.definition;
			if (thorne === undefined) throw new Error("A-thorne is not seeded");
			return {
				actor: agent("odile"),
				kind: "AgentDefinitionRevised",
				payload: {
					definition: {
						...thorne,
						version: 2,
						revised_by: agent("odile"),
						revision_reason: "Audit less",
					},
				},
			};
		},
		"AgentDefinitionRevised refused: the Auditor can only be revised by the Operator; A-odile tried to revise A-thorne (Thorne, version 1)",
	],
	[
		"the Task guard",
		(s) => {
			const task_id = s.task(rin.id);
			return {
				actor: rin,
				task_id,
				kind: "TaskCompleted",
				payload: {
					task_id,
					outputs: [],
					review: { tag: "Skipped", reason: "in a hurry" },
				},
			};
		},
		"TaskCompleted refused: T-1 is sampled for Review, as every Task of A-rin on Probation is; its completion names a reviewer",
	],
	[
		"the Task guard on the reviewer",
		(s) => {
			const task_id = s.task(rin.id);
			return {
				actor: rin,
				task_id,
				kind: "TaskCompleted",
				payload: {
					task_id,
					outputs: [],
					review: { tag: "Required", reviewer: agent("odile") },
				},
			};
		},
		"TaskCompleted refused: A-rin is a Specialist on Probation, reviewed by a Supervisor (A-pia or A-anselm), the Auditor (A-thorne) or a Senior or Mentor Agent (none); A-odile may not review T-1",
	],
	[
		"the Task guard on Mood",
		(s) => {
			const task_id = s.task(agent("ines").id, { start: false });
			s.appendNonTask({
				actor: operator,
				kind: "VitalitySampled",
				payload: {
					agent: rin.id,
					load: 0,
					fatigue: 0.65,
					friction: 0,
					confidence: 1,
					morale: 0,
				},
			});
			return {
				actor: operator,
				task_id,
				kind: "TaskAssigned",
				payload: { task_id, assignee: rin.id },
			};
		},
		"TaskAssigned refused: A-rin is strained and may not accept a Task",
	],
	[
		"the RoomOpened guard",
		() => ({
			actor: operator,
			kind: "RoomOpened",
			payload: {
				room: {
					id: RoomId.parse("RM-ghost"),
					name: "Ghost",
					purpose: "",
					membership: { tag: "Listed", agents: [nobody] },
					opened_by: operator,
				},
			},
		}),
		"RoomOpened refused: A-nobody is not in the Org",
	],
	[
		"the RoomOpened guard on the opener",
		() => ({
			actor: rin,
			kind: "RoomOpened",
			payload: {
				room: {
					id: RoomId.parse("RM-rin"),
					name: "Rin",
					purpose: "",
					membership: { tag: "Listed", agents: [rin.id] },
					opened_by: operator,
				},
			},
		}),
		"RoomOpened refused: A-rin cannot open RM-rin on behalf of Operator",
	],
	[
		"the MessageSent guard",
		(s) => {
			const room_id = RoomId.parse("RM-pia-ines");
			open(s.ledger, {
				id: room_id,
				name: "Pia and Ines",
				purpose: "",
				membership: {
					tag: "Listed",
					agents: [agent("pia").id, agent("ines").id],
				},
				opened_by: operator,
			});
			return {
				actor: rin,
				kind: "MessageSent",
				payload: { room_id, body: "May I join?" },
			};
		},
		"MessageSent refused: A-rin is not a member of RM-pia-ines",
	],
	[
		"the Gate guard",
		(s) => {
			s.appendNonTask(gateRequest);
			return {
				actor: rin,
				kind: "GateDecided",
				payload: {
					gate_id: G1,
					decided_by: operator,
					payload_hash: sha256Hex(canonicalJson({})),
					meaning: "approve",
					reason: "Mine to decide",
				},
			};
		},
		"GateDecided refused: only the Operator may decide G-1; the actor is A-rin",
	],
	[
		"the Gate Projection",
		(s) => {
			s.appendNonTask(gateRequest);
			return gateRequest;
		},
		"GateRequested refused: G-1 already exists, requested at 2026-10-12T09:00:00.000Z",
	],
	[
		"the Script guard",
		() => ({
			actor: operator,
			kind: "ScriptRegistered",
			payload: {
				id: ScriptId.parse("S-other"),
				version: 1,
				name: "copy2",
				owner_agent: rin.id,
				input_types: [],
				output_types: [],
				entrypoint: "main.py",
				fixtures: [],
				image_digest: Sha256.parse("d".repeat(64)),
			},
		}),
		'ScriptRegistered refused: Script "copy2" must have id S-copy2, got S-other',
	],
	[
		"the Artifact guard",
		() => ({
			actor: operator,
			kind: "ArtifactStored",
			payload: {
				id: bytes("e"),
				sha256: Sha256.parse("f".repeat(64)),
				media_type: "text/plain",
				artifact_type: "Other",
				produced_by: { tag: "Operator" },
				lineage: [],
			},
		}),
		`ArtifactStored refused: id ${bytes("e")} must equal its sha256 ${"f".repeat(64)}`,
	],
	[
		"the Run guard",
		() => ({
			actor: operator,
			kind: "RunStarted",
			payload: {
				run_id: RunId.parse("R-1"),
				script: { id: ScriptId.parse("S-nothing"), version: 1 },
				inputs: [],
			},
		}),
		"RunStarted refused: S-nothing v1 is not registered",
	],
	[
		"the Review guard",
		(s) => {
			const task_id = s.task(rin.id);
			return {
				actor: operator,
				task_id,
				kind: "ReviewRecorded",
				payload: {
					task_id,
					reviewer: operator,
					quality: 3,
					traceability: 3,
					boundary_adherence: 3,
					collaboration: 3,
					timeliness: 3,
					note: "",
				},
			};
		},
		"ReviewRecorded refused: T-1 is InProgress; only an UnderReview or Done Task gets a Review",
	],
	[
		"the Review guard on the reviewer",
		(s) => {
			const task_id = s.submitted(rin.id);
			const odile = agent("odile");
			return {
				actor: odile,
				task_id,
				kind: "ReviewRecorded",
				payload: {
					task_id,
					reviewer: odile,
					quality: 3,
					traceability: 3,
					boundary_adherence: 3,
					collaboration: 3,
					timeliness: 3,
					note: "",
				},
			};
		},
		"ReviewRecorded refused: A-rin is a Specialist on Probation, reviewed by a Supervisor (A-pia or A-anselm), the Auditor (A-thorne) or a Senior or Mentor Agent (none); A-odile may not review T-1",
	],
	[
		"the Rest guard",
		() => ({
			actor: operator,
			kind: "RestOrdered",
			payload: { agent_id: nobody, action: "begin", reason: "Tired" },
		}),
		"RestOrdered refused: A-nobody is not in the Org",
	],
	[
		"the Evaluation guard",
		() => ({
			actor: operator,
			task_id: T1,
			kind: "EvaluationRecorded",
			payload: {
				eval_id: EvaluationId.parse("E-1"),
				stage: 1,
				run_id: RunId.parse("R-9"),
				task_id: T1,
				score: 1,
				passed: true,
				findings: [],
			},
		}),
		"EvaluationRecorded refused: R-9 has not started",
	],
];

describe("every refusal reads <Kind> refused: <reason>", () => {
	it.each(ROWS)("%s", (_, refused, refusal) => {
		const event = refused(s);
		const before = s.events().length;

		expect(() => s.ledger.append(event)).toThrow(new AppendRefused(refusal));
		expect(s.events()).toHaveLength(before);
	});
});
