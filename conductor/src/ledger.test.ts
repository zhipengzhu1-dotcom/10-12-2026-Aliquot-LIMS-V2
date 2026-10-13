import { describe, expect, it } from "vitest";
import type { NewEvent } from "./events.js";
import { AppendRefused, type FollowOn } from "./guards.js";
import {
	AgentId,
	ArtifactId,
	GateId,
	RoomId,
	RunId,
	ScriptId,
	Seq,
	Sha256,
	TaskId,
} from "./ids.js";
import {
	type Ledger,
	LedgerCorrupt,
	type LedgerOptions,
	openMemoryLedger,
} from "./ledger.js";
import { LAB_ROOM } from "./room/seed.js";
import { memoryStorage, type Storage } from "./storage.js";
import { forge } from "./test-support/forge.js";
import { scenario, scores } from "./vitality/scenario.js";

const operator = { tag: "Operator" } as const;
const lab = RoomId.parse("RM-lab");
const odile = AgentId.parse("A-odile");

const opened: NewEvent = {
	actor: operator,
	kind: "RoomOpened",
	payload: { room: LAB_ROOM },
};

const said = (
	body: string,
	envelope: Pick<NewEvent, "task_id" | "causation_id" | "actor"> = {
		actor: operator,
	},
): NewEvent => ({
	...envelope,
	kind: "MessageSent",
	payload: { room_id: lab, body },
});

/** Messages in the Lab Room, with and without the optional envelope fields. */
const sampleEvent = (i: number): NewEvent => {
	switch (i % 3) {
		case 0:
			return said(`note ${i}`);
		case 1:
			return said(`note ${i}`, {
				actor: operator,
				task_id: TaskId.parse(`T-${i}`),
			});
		default:
			return said(`reply ${i}`, {
				actor: operator,
				causation_id: Seq.parse(i),
			});
	}
};

/** A Ledger with the Lab Room open and `n` sample Messages after it. */
const withSamples = (n: number, options: Partial<LedgerOptions> = {}) => {
	const ledger = openMemoryLedger(options);
	ledger.append(opened);
	for (let i = 1; i <= n; i++) ledger.append(sampleEvent(i));
	return ledger;
};

const bodies = (l: Ledger) =>
	l.all().map((e) => (e.kind === "MessageSent" ? e.payload.body : e.kind));

// The refusal tests hand the Ledger values the type system would reject, the
// way JSON from the command line arrives.
const untyped = (value: unknown) => value as NewEvent;

describe("Ledger append", () => {
	it("refuses an Event with an unknown kind, naming it, and writes nothing", () => {
		const l = withSamples(0);
		const append = () =>
			l.append(untyped({ actor: operator, kind: "AgentDanced", payload: {} }));

		expect(append).toThrow(AppendRefused);
		expect(append).toThrow(/^AgentDanced refused: not a valid Event: /);
		expect(bodies(l)).toEqual(["RoomOpened"]);
	});

	it.each([
		["a missing payload field", { room_id: "RM-lab" }],
		["a malformed RoomId", { room_id: "lab", body: "b" }],
		["an unknown payload field", { room_id: "RM-lab", body: "b", x: 1 }],
	])("refuses a payload with %s and writes nothing", (_, payload) => {
		const l = withSamples(0);
		const append = () =>
			l.append(untyped({ actor: operator, kind: "MessageSent", payload }));

		expect(append).toThrow(AppendRefused);
		expect(append).toThrow(
			/^MessageSent refused: not a valid Event: .*payload/s,
		);
		expect(bodies(l)).toEqual(["RoomOpened"]);
	});

	it("numbers Events from 1 and chains each to the previous hash", () => {
		const l = openMemoryLedger();
		const first = l.append(opened);
		const second = l.append(said("two"));

		expect(first.seq).toBe(1);
		expect(first.prev_hash).toBe("0".repeat(64));
		expect(second.seq).toBe(2);
		expect(second.prev_hash).toBe(first.hash);
		expect(second.hash).not.toBe(first.hash);
	});

	it("stamps each Event with the injected clock", () => {
		const l = openMemoryLedger({
			clock: () => new Date("2026-10-12T09:30:00Z"),
		});

		expect(l.append(opened).ts).toBe("2026-10-12T09:30:00.000Z");
	});

	it("words a guard's refusal as <Kind> refused: <reason> and writes nothing", () => {
		const l = withSamples(1);

		expect(() =>
			l.append(said("hello", { actor: { tag: "Agent", id: odile } })),
		).toThrow(
			new AppendRefused(
				"MessageSent refused: A-odile is not a member of RM-lab",
			),
		);
		expect(l.all().map((e) => e.seq)).toEqual([1, 2]);
	});

	it("refuses an Event a Projection cannot apply, in the same words, and writes nothing", () => {
		const l = withSamples(1);

		expect(() =>
			l.append({
				actor: operator,
				kind: "MessageSent",
				payload: { room_id: RoomId.parse("RM-nowhere"), body: "hello" },
			}),
		).toThrow(
			new AppendRefused("MessageSent refused: RM-nowhere is not an open Room"),
		);
		expect(l.all().map((e) => e.seq)).toEqual([1, 2]);
	});

	it("writes the follow-ons after their cause in the same append, and a refused follow-on rolls back the cause", () => {
		const echo: FollowOn = (ledger, cause) =>
			cause.kind === "MessageSent" && cause.payload.body.startsWith("echo")
				? [
						cause.payload.body === "echo no"
							? said("no", { actor: { tag: "Agent", id: odile } })
							: said(`after ${ledger.rooms.messages.at(-1)?.seq}`),
					]
				: [];
		const l = openMemoryLedger({ followOns: [echo] });
		l.append(opened);

		expect(l.append(said("echo")).seq).toBe(2);
		expect(bodies(l)).toEqual(["RoomOpened", "echo", "after 2"]);

		expect(() => l.append(said("echo no"))).toThrow(
			"MessageSent refused: A-odile is not a member of RM-lab",
		);
		expect(bodies(l)).toEqual(["RoomOpened", "echo", "after 2"]);
		expect(l.projections.rooms.messages.map((m) => m.body)).toEqual([
			"echo",
			"after 2",
		]);

		const next = l.append(said("next"));
		expect(next).toMatchObject({ seq: 4, prev_hash: l.all()[2]?.hash });
		expect(l.verify()).toEqual({ ok: true, count: 4 });
	});
});

describe("Ledger Projections", () => {
	it("advances its Projections by each append, and a Ledger opened on the same Events builds the same ones", () => {
		const storage = memoryStorage();
		const s = scenario(undefined, { storage });
		const rin = AgentId.parse("A-rin");
		for (let i = 0; i < 10; i++) s.reviewed(rin, scores(3));
		const t = s.task(rin);
		s.run(t, 1, 0.4);
		s.gate("PromoteToMentor", { agent_id: rin }, "reject");
		s.retire(AgentId.parse("A-bram"), "Replaced");
		s.append(opened);
		s.append(said("Rin is Trusted now"));

		const reader = openMemoryLedger({ storage, writer: false });

		expect(reader.projections).toEqual(s.ledger.projections);
		expect(s.ledger.projections.trust.agents.get(rin)?.tier).toBe("Trusted");
		expect(s.ledger.projections.tasks.tasks.get(t)?.state).toEqual({
			tag: "InProgress",
			assignee: rin,
		});
	});

	it("leaves its Projections as they were when an append is refused", () => {
		const l = withSamples(3);
		const before = l.projections;

		expect(() => l.append(opened)).toThrow(
			"RoomOpened refused: RM-lab is already open",
		);
		expect(l.projections).toBe(before);
	});
});

describe("a corrupt Ledger", () => {
	const T1 = TaskId.parse("T-1");
	const artifact = ArtifactId.parse("a".repeat(64));
	const stored: NewEvent = {
		actor: operator,
		kind: "ArtifactStored",
		payload: {
			id: artifact,
			sha256: Sha256.parse(artifact),
			media_type: "text/plain",
			artifact_type: "Other",
			produced_by: { tag: "Operator" },
			lineage: [],
		},
	};

	const corrupt = (events: NewEvent[]): Storage => {
		const storage = memoryStorage();
		forge(storage, [opened, said("first"), ...events]);
		return storage;
	};

	it.each<[string, NewEvent[], string]>([
		[
			"a Task Event the Task state machine cannot express",
			[{ actor: operator, kind: "TaskStarted", payload: { task_id: T1 } }],
			"TaskStarted refused: T-1 does not exist",
		],
		[
			"a Revision of an Agent not in the Org",
			[
				{
					actor: operator,
					kind: "AgentPaused",
					payload: { agent_id: odile, reason: "r" },
				},
			],
			"AgentPaused refused: A-odile is not in the Org",
		],
		[
			"a second RoomOpened for one Room",
			[opened],
			"RoomOpened refused: RM-lab is already open",
		],
		[
			"a decision on a Gate never requested",
			[
				{
					actor: operator,
					kind: "GateDecided",
					payload: {
						gate_id: GateId.parse("G-1"),
						decided_by: operator,
						payload_hash: Sha256.parse("b".repeat(64)),
						meaning: "approve",
						reason: "r",
					},
				},
			],
			"GateDecided refused: no Gate G-1 was requested",
		],
		[
			"a revision of a Script never registered",
			[
				{
					actor: operator,
					kind: "ScriptRevised",
					payload: {
						id: ScriptId.parse("S-copy"),
						version: 2,
						name: "copy",
						owner_agent: odile,
						input_types: [],
						output_types: [],
						entrypoint: "main.py",
						fixtures: [],
						image_digest: Sha256.parse("b".repeat(64)),
					},
				},
			],
			"ScriptRevised refused: S-copy is not registered",
		],
		[
			"a RunFinished with no RunStarted",
			[
				stored,
				{
					actor: operator,
					kind: "RunFinished",
					payload: {
						id: RunId.parse("R-1"),
						script: { id: ScriptId.parse("S-copy"), version: 1 },
						inputs: [],
						outputs: [],
						exit_code: 0,
						stdout_ref: artifact,
						stderr_ref: artifact,
						duration_ms: 1,
					},
				},
			],
			"RunFinished refused: R-1 has no RunStarted",
		],
		[
			"the Operator storing the same bytes twice",
			[stored, stored],
			`ArtifactStored refused: ${artifact} is already stored`,
		],
	])(
		"reports %s as corrupt, naming its seq, to a reader and a writer",
		(_, events, refusal) => {
			const storage = corrupt(events);
			const seq = 2 + events.length;
			const message = `:memory: is corrupt at seq ${seq}: ${refusal}`;

			for (const writer of [false, true]) {
				const open = () => openMemoryLedger({ storage, writer });
				expect(open).toThrow(LedgerCorrupt);
				expect(open).toThrow(message);
			}
			expect([...storage.rows()]).toHaveLength(seq);
		},
	);
});
