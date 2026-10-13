import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gateDecision, requestGate } from "../gate/request.js";
import { AgentId, RoomId, type Seq } from "../ids.js";
import { type Ledger, openMemoryLedger } from "../ledger.js";
import { seedOrg } from "../org/seed.js";
import type { Actor } from "../types/actor.js";
import type { Membership } from "../types/room.js";
import { history, RoomRefused, roomsOf } from "./projection.js";

const operator: Actor = { tag: "Operator" };
const agent = (slug: string): Actor => ({
	tag: "Agent",
	id: AgentId.parse(`A-${slug}`),
});
const pia = agent("pia");
const rin = agent("rin");
const bram = agent("bram");
const ines = agent("ines");

const LAB = RoomId.parse("RM-lab");
const PIA_RIN = RoomId.parse("RM-pia-rin");

const listed = (...slugs: string[]): Membership => ({
	tag: "Listed",
	agents: slugs.map((s) => AgentId.parse(`A-${s}`)),
});

let ledger: Ledger;

beforeEach(() => {
	ledger = openMemoryLedger();
	seedOrg(ledger);
});

afterEach(() => ledger.close());

const open = (
	id: RoomId,
	membership: Membership,
	actor: Actor = operator,
	opened_by: Actor = actor,
) =>
	ledger.append({
		actor,
		kind: "RoomOpened",
		payload: {
			room: { id, name: id.slice(3), purpose: "", membership, opened_by },
		},
	});

const say = (room_id: RoomId, actor: Actor, body: string, replyTo?: Seq) =>
	ledger.append({
		actor,
		kind: "MessageSent",
		payload: { room_id, body },
		...(replyTo === undefined ? {} : { causation_id: replyTo }),
	});

/** Retire an Agent through an approved RetireAgent Gate (ADR-0006). */
const retire = (who: Actor) => {
	if (who.tag !== "Agent") throw new Error("only an Agent retires");
	const { gate_id } = requestGate(ledger, {
		actor: operator,
		kind: "RetireAgent",
		payload: { agent_id: who.id },
	});
	const gate = ledger.projections.gates.gates.get(gate_id);
	if (gate === undefined) throw new Error(`${gate_id} was not requested`);
	ledger.append(gateDecision(gate, "approve", "left the lab"));
	ledger.append({
		actor: operator,
		kind: "AgentRetired",
		payload: { agent_id: who.id, reason: "left the lab", gate_id },
	});
};

const read = (room_id: RoomId, reader: Actor) =>
	history(ledger.projections.rooms, ledger.projections.org, room_id, reader);

const readable = (actor: Actor) =>
	roomsOf(ledger.projections.rooms, ledger.projections.org, actor).map(
		(r) => r.id,
	);

describe("opening a Room", () => {
	it("lets an Agent open a Listed Room only when the list names it", () => {
		expect(() => open(PIA_RIN, listed("rin", "bram"), pia)).toThrow(
			"RoomOpened refused: A-pia is not listed in RM-pia-rin; an Agent may open only a Room it belongs to",
		);

		open(PIA_RIN, listed("pia", "rin"), pia);

		expect(readable(pia)).toEqual([PIA_RIN]);
	});

	it("refuses a Listed Room naming an Agent that is not recruited or is Retired", () => {
		retire(bram);

		expect(() => open(PIA_RIN, listed("pia", "zed"), pia)).toThrow(
			"RoomOpened refused: A-zed is not in the Org",
		);
		expect(() => open(PIA_RIN, listed("pia", "bram"), pia)).toThrow(
			"RoomOpened refused: A-bram is Retired",
		);
		expect(ledger.projections.rooms.rooms.size).toBe(0);
	});

	it("lets the Operator open a Room whose list does not name it", () => {
		open(PIA_RIN, listed("pia", "rin"));

		expect(readable(operator)).toEqual([PIA_RIN]);
	});

	it("refuses a second RoomOpened for an open Room", () => {
		open(LAB, { tag: "Everyone" });

		expect(() => open(LAB, listed("rin"))).toThrow(
			"RoomOpened refused: RM-lab is already open",
		);
		expect(ledger.projections.rooms.rooms.get(LAB)?.membership).toEqual({
			tag: "Everyone",
		});
	});

	it("refuses a Room whose opened_by is not the actor", () => {
		expect(() => open(PIA_RIN, listed("pia", "rin"), pia, operator)).toThrow(
			"RoomOpened refused: A-pia cannot open RM-pia-rin on behalf of Operator",
		);
	});
});

describe("saying a Message", () => {
	beforeEach(() => {
		open(LAB, { tag: "Everyone" });
		open(PIA_RIN, listed("pia", "rin"), pia);
	});

	it("admits every recruited, unretired Agent to an Everyone Room", () => {
		say(LAB, bram, "Nulls in the Receiving sheet again");
		retire(ines);

		expect(() => say(LAB, ines, "Still here")).toThrow(
			"MessageSent refused: A-ines is not a member of RM-lab",
		);
		expect(readable(ines)).toEqual([]);
		expect(readable(bram)).toEqual([LAB]);
	});

	it("refuses a Message from a non-member, and in a Room that is not open", () => {
		expect(() => say(PIA_RIN, bram, "Let me in")).toThrow(
			"MessageSent refused: A-bram is not a member of RM-pia-rin",
		);
		expect(() => say(RoomId.parse("RM-nowhere"), rin, "Hello?")).toThrow(
			"MessageSent refused: RM-nowhere is not an open Room",
		);
		expect(ledger.projections.rooms.messages).toEqual([]);
	});

	it("lets the Operator say a Message in a private Room", () => {
		const said = say(PIA_RIN, operator, "Show me the checklist");

		expect(read(PIA_RIN, pia)).toEqual([
			{
				seq: said.seq,
				ts: said.ts,
				actor: operator,
				room_id: PIA_RIN,
				body: "Show me the checklist",
			},
		]);
	});
});

describe("reading a Room", () => {
	beforeEach(() => {
		open(LAB, { tag: "Everyone" });
		open(PIA_RIN, listed("pia", "rin"), pia);
	});

	it("gives the Operator every Message of any Room, in seq order", () => {
		say(PIA_RIN, pia, "Checklist for T-1");
		say(LAB, bram, "Morning");
		say(PIA_RIN, rin, "Merged cells in row 4");
		say(PIA_RIN, operator, "Unmerge them");

		const messages = read(PIA_RIN, operator);

		if (messages instanceof RoomRefused) throw new Error(messages.message);
		expect(messages.map((m) => [m.seq, m.body])).toEqual([
			[11, "Checklist for T-1"],
			[13, "Merged cells in row 4"],
			[14, "Unmerge them"],
		]);
	});

	it("refuses a non-member Agent rather than returning no Messages", () => {
		say(PIA_RIN, rin, "Merged cells in row 4");

		expect(read(PIA_RIN, bram)).toEqual(
			new RoomRefused("history refused: A-bram is not a member of RM-pia-rin"),
		);
		expect(readable(bram)).toEqual([LAB]);
	});
});

describe("replying to a Message", () => {
	beforeEach(() => {
		open(LAB, { tag: "Everyone" });
		open(PIA_RIN, listed("pia", "rin"), pia);
	});

	it("records a reply to an earlier Message in the same Room", () => {
		const question = say(PIA_RIN, pia, "Is row 4 merged?");
		const answer = say(PIA_RIN, rin, "Yes", question.seq);

		expect(read(PIA_RIN, operator)).toContainEqual(
			expect.objectContaining({ seq: answer.seq, causation_id: question.seq }),
		);
	});

	it("refuses a reply that points at a Message in another Room, or at an Event that is not a Message", () => {
		const elsewhere = say(LAB, pia, "Morning");
		const opened = ledger
			.all()
			.find((e) => e.kind === "RoomOpened" && e.payload.room.id === PIA_RIN);

		expect(() => say(PIA_RIN, rin, "Morning", elsewhere.seq)).toThrow(
			`MessageSent refused: seq ${elsewhere.seq} is not a Message in RM-pia-rin`,
		);
		expect(() => say(PIA_RIN, rin, "Opened", opened?.seq)).toThrow(
			`MessageSent refused: seq ${opened?.seq} is not a Message in RM-pia-rin`,
		);
	});
});
