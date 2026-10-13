import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId, RoomId, type Seq } from "../ids.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import type { Actor } from "../types/actor.js";
import type { Membership } from "../types/room.js";
import { open, say } from "./lifecycle.js";
import { history, RoomRefused, roomsOf } from "./projection.js";

const operator: Actor = { tag: "Operator" };
const agent = (slug: string): Actor => ({
	tag: "Agent",
	id: AgentId.parse(`A-${slug}`),
});
const pia = agent("pia");
const rin = agent("rin");
const bram = agent("bram");

const LAB = RoomId.parse("RM-lab");
const PIA_RIN = RoomId.parse("RM-pia-rin");

const listed = (...slugs: string[]): Membership => ({
	tag: "Listed",
	agents: slugs.map((s) => AgentId.parse(`A-${s}`)),
});

let s: Scenario;

beforeEach(() => {
	s = scenario();
});

afterEach(() => s.close());

const openRoom = (
	id: RoomId,
	membership: Membership,
	opened_by: Actor = operator,
) =>
	open(s.ledger, { id, name: id.slice(3), purpose: "", membership, opened_by });

const sayIn = (room_id: RoomId, actor: Actor, body: string, reply_to?: Seq) =>
	say(s.ledger, { actor, room_id, body, reply_to });

const read = (room_id: RoomId, reader: Actor) =>
	history(
		s.ledger.projections.rooms,
		s.ledger.projections.org,
		room_id,
		reader,
	);

const readable = (actor: Actor) =>
	roomsOf(s.ledger.projections.rooms, s.ledger.projections.org, actor).map(
		(r) => r.id,
	);

const recorded = (seq: Seq) => s.events().find((e) => e.seq === seq);

describe("the Room lifecycle", () => {
	it("records a Room's opener as the actor and no cause, a Message with no cause, and a reply caused by the Message it answers, returning what it appended", () => {
		const opened = openRoom(PIA_RIN, listed("pia", "rin"), pia);
		const question = sayIn(PIA_RIN, pia, "Is row 4 merged?");
		const answer = sayIn(PIA_RIN, rin, "Yes", question.seq);

		expect(opened.room).toEqual(s.ledger.projections.rooms.rooms.get(PIA_RIN));
		expect(recorded(opened.seq)).toMatchObject({
			actor: pia,
			kind: "RoomOpened",
			payload: { room: opened.room },
		});
		expect(recorded(opened.seq)?.causation_id).toBeUndefined();
		expect(recorded(question.seq)?.causation_id).toBeUndefined();
		expect(recorded(answer.seq)).toMatchObject({
			actor: rin,
			kind: "MessageSent",
			causation_id: question.seq,
			payload: { room_id: PIA_RIN, body: "Yes" },
		});
		expect(answer).toEqual({
			seq: answer.seq,
			ts: recorded(answer.seq)?.ts,
			actor: rin,
			room_id: PIA_RIN,
			body: "Yes",
			causation_id: question.seq,
		});
	});
});

describe("opening a Room", () => {
	it("lets an Agent open a Listed Room only when the list names it", () => {
		expect(() => openRoom(PIA_RIN, listed("rin", "bram"), pia)).toThrow(
			"RoomOpened refused: A-pia is not listed in RM-pia-rin; an Agent may open only a Room it belongs to",
		);

		openRoom(PIA_RIN, listed("pia", "rin"), pia);

		expect(readable(pia)).toEqual([PIA_RIN]);
	});

	it("refuses a Listed Room naming an Agent that is not recruited or is Retired", () => {
		s.retire(AgentId.parse("A-bram"), "left the lab");

		expect(() => openRoom(PIA_RIN, listed("pia", "zed"), pia)).toThrow(
			"RoomOpened refused: A-zed is not in the Org",
		);
		expect(() => openRoom(PIA_RIN, listed("pia", "bram"), pia)).toThrow(
			"RoomOpened refused: A-bram is Retired",
		);
		expect(s.ledger.projections.rooms.rooms.size).toBe(0);
	});

	it("lets the Operator open a Room whose list does not name it", () => {
		openRoom(PIA_RIN, listed("pia", "rin"));

		expect(readable(operator)).toEqual([PIA_RIN]);
	});

	it("refuses a second opening of an open Room", () => {
		openRoom(LAB, { tag: "Everyone" });

		expect(() => openRoom(LAB, listed("rin"))).toThrow(
			"RoomOpened refused: RM-lab is already open",
		);
		expect(s.ledger.projections.rooms.rooms.get(LAB)?.membership).toEqual({
			tag: "Everyone",
		});
	});
});

describe("saying a Message", () => {
	beforeEach(() => {
		openRoom(LAB, { tag: "Everyone" });
		openRoom(PIA_RIN, listed("pia", "rin"), pia);
	});

	it("admits every recruited, unretired Agent to an Everyone Room", () => {
		sayIn(LAB, bram, "Nulls in the Receiving sheet again");
		s.retire(AgentId.parse("A-ines"), "left the lab");

		expect(() => sayIn(LAB, agent("ines"), "Still here")).toThrow(
			"MessageSent refused: A-ines is not a member of RM-lab",
		);
		expect(readable(agent("ines"))).toEqual([]);
		expect(readable(bram)).toEqual([LAB]);
	});

	it("refuses a Message from a non-member, and in a Room that is not open", () => {
		expect(() => sayIn(PIA_RIN, bram, "Let me in")).toThrow(
			"MessageSent refused: A-bram is not a member of RM-pia-rin",
		);
		expect(() => sayIn(RoomId.parse("RM-nowhere"), rin, "Hello?")).toThrow(
			"MessageSent refused: RM-nowhere is not an open Room",
		);
		expect(s.ledger.projections.rooms.messages).toEqual([]);
	});

	it("lets the Operator say a Message in a private Room", () => {
		const said = sayIn(PIA_RIN, operator, "Show me the checklist");

		expect(read(PIA_RIN, pia)).toEqual([
			{
				seq: said.seq,
				ts: "2026-10-01T00:00:00.000Z",
				actor: operator,
				room_id: PIA_RIN,
				body: "Show me the checklist",
			},
		]);
	});
});

describe("reading a Room", () => {
	beforeEach(() => {
		openRoom(LAB, { tag: "Everyone" });
		openRoom(PIA_RIN, listed("pia", "rin"), pia);
	});

	it("gives the Operator every Message of any Room, in seq order", () => {
		const first = sayIn(PIA_RIN, pia, "Checklist for T-1");
		sayIn(LAB, bram, "Morning");
		const third = sayIn(PIA_RIN, rin, "Merged cells in row 4");
		const fourth = sayIn(PIA_RIN, operator, "Unmerge them");

		const messages = read(PIA_RIN, operator);

		if (messages instanceof RoomRefused) throw new Error(messages.message);
		expect(messages.map((m) => [m.seq, m.body])).toEqual([
			[first.seq, "Checklist for T-1"],
			[third.seq, "Merged cells in row 4"],
			[fourth.seq, "Unmerge them"],
		]);
	});

	it("refuses a non-member Agent rather than returning no Messages", () => {
		sayIn(PIA_RIN, rin, "Merged cells in row 4");

		expect(read(PIA_RIN, bram)).toEqual(
			new RoomRefused("history refused: A-bram is not a member of RM-pia-rin"),
		);
		expect(readable(bram)).toEqual([LAB]);
	});
});

describe("replying to a Message", () => {
	beforeEach(() => {
		openRoom(LAB, { tag: "Everyone" });
		openRoom(PIA_RIN, listed("pia", "rin"), pia);
	});

	it("refuses a reply that points at a Message in another Room, or at an Event that is not a Message", () => {
		const elsewhere = sayIn(LAB, pia, "Morning");
		const opened = s
			.events()
			.find((e) => e.kind === "RoomOpened" && e.payload.room.id === PIA_RIN);

		expect(() => sayIn(PIA_RIN, rin, "Morning", elsewhere.seq)).toThrow(
			`MessageSent refused: seq ${elsewhere.seq} is not a Message in RM-pia-rin`,
		);
		expect(() => sayIn(PIA_RIN, rin, "Opened", opened?.seq)).toThrow(
			`MessageSent refused: seq ${opened?.seq} is not a Message in RM-pia-rin`,
		);
	});
});
