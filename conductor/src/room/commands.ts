import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { type CommandTable, readAll, UsageError } from "../command.js";
import type { Event } from "../events.js";
import { AgentId, RoomId, Seq } from "../ids.js";
import { openLedger } from "../ledger.js";
import { orgState } from "../org/projection.js";
import type { Actor } from "../types/actor.js";
import { Room } from "../types/room.js";
import {
	history,
	type Message,
	RoomRefused,
	roomState,
	roomsOf,
	who,
} from "./projection.js";
import { LAB_ROOM, seedRooms } from "./seed.js";

const asOption = { as: { type: "string" } } as const;

/** The reader or speaker: the Operator, unless `--as A-<slug>` names an Agent. */
const actorOf = (as: string | undefined): Actor => {
	if (as === undefined) return { tag: "Operator" };
	const id = AgentId.safeParse(as);
	if (!id.success) {
		throw new UsageError(`--as must be an Agent id like A-rin, not ${as}`);
	}
	return { tag: "Agent", id: id.data };
};

const roomIdOf = (command: string, positionals: string[]): RoomId => {
	const [text, ...extra] = positionals;
	const id = RoomId.safeParse(text);
	if (text === undefined || extra.length > 0 || !id.success) {
		throw new UsageError(`room ${command} takes one Room id like RM-lab`);
	}
	return id.data;
};

const ledgerEvents = (home: string): Event[] => {
	if (!existsSync(join(home, "ledger.sqlite"))) return [];
	const ledger = openLedger({ home, writer: false });
	try {
		return ledger.all();
	} finally {
		ledger.close();
	}
};

const membersText = (room: Room) =>
	room.membership.tag === "Everyone"
		? "Everyone"
		: room.membership.agents.join(", ");

const messageLine = (m: Message) => {
	const reply =
		m.causation_id === undefined ? "" : ` (reply to ${m.causation_id})`;
	return `${m.seq}  ${m.ts}  ${who(m.actor)}${reply}: ${m.body}`;
};

export const roomCommands: CommandTable = {
	seed: {
		describe: "Open the Lab Room for every Agent; a second run appends nothing",
		run: async (args, ctx) => {
			parseArgs({ args });
			const ledger = openLedger({ home: ctx.home, writer: true });
			try {
				const opened = seedRooms(ledger);
				ctx.stdout.write(
					opened
						? `Opened ${LAB_ROOM.id} (${LAB_ROOM.name}) for Everyone\n`
						: `${LAB_ROOM.id} is already open, nothing appended\n`,
				);
				return 0;
			} finally {
				ledger.close();
			}
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
			const parsed = Room.safeParse(json);
			if (!parsed.success) {
				throw new Error(`not a Room: ${z.prettifyError(parsed.error)}`);
			}
			const room = parsed.data;
			const ledger = openLedger({ home: ctx.home, writer: true });
			try {
				ledger.append({
					actor: room.opened_by,
					...(room.task_id === undefined ? {} : { task_id: room.task_id }),
					kind: "RoomOpened",
					payload: { room },
				});
			} finally {
				ledger.close();
			}
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
			const actor = actorOf(values.as);
			const replyTo = values["reply-to"];
			let causation_id: Seq | undefined;
			if (replyTo !== undefined) {
				const seq = Seq.safeParse(Number(replyTo));
				if (!/^\d+$/.test(replyTo) || !seq.success) {
					throw new UsageError(
						`--reply-to must be a seq like 12, not ${replyTo}`,
					);
				}
				causation_id = seq.data;
			}
			const body = (await readAll(ctx.stdin)).replace(/\n$/, "");
			const ledger = openLedger({ home: ctx.home, writer: true });
			try {
				const event = ledger.append({
					actor,
					kind: "MessageSent",
					payload: { room_id, body },
					...(causation_id === undefined ? {} : { causation_id }),
				});
				ctx.stdout.write(`${event.seq}  ${who(actor)} in ${room_id}\n`);
				return 0;
			} finally {
				ledger.close();
			}
		},
	},
	list: {
		args: "[--as <agent>]",
		describe: "List the Rooms the Operator, or the Agent named, may read",
		run: async (args, ctx) => {
			const { values } = parseArgs({ args, options: asOption });
			const events = ledgerEvents(ctx.home);
			const rooms = roomsOf(
				roomState(events),
				orgState(events),
				actorOf(values.as),
			);
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
			const events = ledgerEvents(ctx.home);
			const messages = history(
				roomState(events),
				orgState(events),
				room_id,
				actorOf(values.as),
			);
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
