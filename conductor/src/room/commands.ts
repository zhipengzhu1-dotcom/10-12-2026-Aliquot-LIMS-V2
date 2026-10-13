import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
	actorText,
	parseActor,
	parseOrThrow,
	parseOrUsage,
	readAll,
	withLedger,
} from "../cli-support.js";
import { type CommandTable, UsageError } from "../command.js";
import { RoomId, Seq } from "../ids.js";
import { emptyProjections, type Projections } from "../projections.js";
import { Room } from "../types/room.js";
import { history, type Message, RoomRefused, roomsOf } from "./projection.js";
import { LAB_ROOM, seedRooms } from "./seed.js";

const asOption = { as: { type: "string" } } as const;

const SeqText = z.string().regex(/^\d+$/).transform(Number).pipe(Seq);

const roomIdOf = (command: string, positionals: string[]): RoomId => {
	const what = `room ${command} takes one Room id like RM-lab`;
	const [text, ...extra] = positionals;
	if (text === undefined || extra.length > 0) throw new UsageError(what);
	return parseOrUsage(RoomId, text, what);
};

const readProjections = (home: string): Projections =>
	existsSync(join(home, "ledger.sqlite"))
		? withLedger(home, false, (ledger) => ledger.projections)
		: emptyProjections();

const membersText = (room: Room) =>
	room.membership.tag === "Everyone"
		? "Everyone"
		: room.membership.agents.join(", ");

const messageLine = (m: Message) => {
	const reply =
		m.causation_id === undefined ? "" : ` (reply to ${m.causation_id})`;
	return `${m.seq}  ${m.ts}  ${actorText(m.actor)}${reply}: ${m.body}`;
};

export const roomCommands: CommandTable = {
	seed: {
		describe: "Open the Lab Room for every Agent; a second run appends nothing",
		run: async (args, ctx) => {
			parseArgs({ args });
			const opened = withLedger(ctx.home, true, seedRooms);
			ctx.stdout.write(
				opened
					? `Opened ${LAB_ROOM.id} (${LAB_ROOM.name}) for Everyone\n`
					: `${LAB_ROOM.id} is already open, nothing appended\n`,
			);
			return 0;
		},
	},
	open: {
		args: "[file]",
		describe:
			"Open a Room from a JSON Room {id, name, purpose, membership, opened_by, task_id?} in a file, or stdin",
		run: async (args, ctx) => {
			const { positionals } = parseArgs({ args, allowPositionals: true });
			if (positionals.length > 1) {
				throw new UsageError("room open takes at most one file");
			}
			const [file] = positionals;
			const text =
				file === undefined || file === "-"
					? await readAll(ctx.stdin)
					: readFileSync(file, "utf8");
			let json: unknown;
			try {
				json = JSON.parse(text);
			} catch (error) {
				throw new Error(`the Room is not JSON: ${(error as Error).message}`);
			}
			const room = parseOrThrow(Room, json, "not a Room");
			withLedger(ctx.home, true, (ledger) =>
				ledger.append({
					actor: room.opened_by,
					...(room.task_id === undefined ? {} : { task_id: room.task_id }),
					kind: "RoomOpened",
					payload: { room },
				}),
			);
			ctx.stdout.write(
				`Opened ${room.id} (${room.name}) for ${membersText(room)}\n`,
			);
			return 0;
		},
	},
	say: {
		args: "<room id> [--as <agent>] [--reply-to <seq>]",
		describe: "Say a Message in a Room; the body is stdin",
		run: async (args, ctx) => {
			const { values, positionals } = parseArgs({
				args,
				options: { ...asOption, "reply-to": { type: "string" } },
				allowPositionals: true,
			});
			const room_id = roomIdOf("say", positionals);
			const actor = parseActor(values.as);
			const replyTo = values["reply-to"];
			const causation_id =
				replyTo === undefined
					? undefined
					: parseOrUsage(SeqText, replyTo, "--reply-to must be a seq like 12");
			const body = (await readAll(ctx.stdin)).replace(/\n$/, "");
			const event = withLedger(ctx.home, true, (ledger) =>
				ledger.append({
					actor,
					kind: "MessageSent",
					payload: { room_id, body },
					...(causation_id === undefined ? {} : { causation_id }),
				}),
			);
			ctx.stdout.write(`${event.seq}  ${actorText(actor)} in ${room_id}\n`);
			return 0;
		},
	},
	list: {
		args: "[--as <agent>]",
		describe: "List the Rooms the Operator, or the Agent named, may read",
		run: async (args, ctx) => {
			const { values } = parseArgs({ args, options: asOption });
			const { rooms: state, org } = readProjections(ctx.home);
			const rooms = roomsOf(state, org, parseActor(values.as));
			if (rooms.length === 0) {
				ctx.stdout.write("No Rooms\n");
				return 0;
			}
			const lines = rooms.map(
				(r) => `${r.id}  ${r.name}  members: ${membersText(r)}`,
			);
			ctx.stdout.write(`${lines.join("\n")}\n`);
			return 0;
		},
	},
	history: {
		args: "<room id> [--as <agent>]",
		describe:
			"Print every Message of a Room in seq order, if the reader is a member",
		run: async (args, ctx) => {
			const { values, positionals } = parseArgs({
				args,
				options: asOption,
				allowPositionals: true,
			});
			const room_id = roomIdOf("history", positionals);
			const { rooms, org } = readProjections(ctx.home);
			const messages = history(rooms, org, room_id, parseActor(values.as));
			if (messages instanceof RoomRefused) {
				ctx.stderr.write(`${messages.message}\n`);
				return 1;
			}
			ctx.stdout.write(
				messages.length === 0
					? `No Messages in ${room_id}\n`
					: `${messages.map(messageLine).join("\n")}\n`,
			);
			return 0;
		},
	},
};
