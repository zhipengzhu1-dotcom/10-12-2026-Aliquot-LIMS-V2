import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
	actorText,
	nextId,
	parseActor,
	parseOrUsage,
	readAll,
	withLedger,
} from "../cli-support.js";
import {
	type CommandContext,
	type CommandTable,
	UsageError,
} from "../command.js";
import type { Event, NewEvent } from "../events.js";
import { canonicalJson, sha256Hex } from "../hash.js";
import { GateId, IsoTime, TaskId } from "../ids.js";
import { openLedger } from "../ledger.js";
import { fold } from "../reduce.js";
import { GateKind } from "../types/gate.js";
import {
	expiresAt,
	type Gate,
	GateProjection,
	type Gates,
	gateState,
} from "./projection.js";

const DEFAULT_LIFETIME_S = 86400;
const SUMMARY_WIDTH = 60;

const gatesOf = (ledger: { events(): Iterable<Event> }): Gates =>
	fold(ledger.events(), GateProjection.reduce, GateProjection.init);

const readGates = (home: string): Gates => withLedger(home, false, gatesOf);

const gateOf = (gates: Gates, id: string): Gate => {
	const gate = gates.gates.get(
		parseOrUsage(GateId, id, "the gate id must look like G-1"),
	);
	if (gate === undefined) throw new Error(`no Gate ${id} was requested`);
	return gate;
};

/** `45s`, `12m`, `2h 5m`, `3d 0h`. */
const ageOf = (ms: number): string => {
	const s = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(s / 60);
	const h = Math.floor(m / 60);
	const d = Math.floor(h / 24);
	if (m < 1) return `${s}s`;
	if (h < 1) return `${m}m`;
	if (d < 1) return `${h}h ${m % 60}m`;
	return `${d}d ${h % 24}h`;
};

const summaryOf = (payload: unknown) => {
	const json = canonicalJson(payload);
	return json.length <= SUMMARY_WIDTH
		? json
		: `${json.slice(0, SUMMARY_WIDTH - 1)}…`;
};

const table = (rows: string[][]) => {
	const widths = rows[0]?.map((_, i) =>
		Math.max(...rows.map((row) => row[i]?.length ?? 0)),
	);
	return rows
		.map((row) =>
			row
				.map((cell, i) =>
					i === row.length - 1 ? cell : cell.padEnd(widths?.[i] ?? 0),
				)
				.join("  "),
		)
		.join("\n");
};

/** Open Gates, or every Gate with its state when `all` is set. */
const gateListing = (gates: Gates, now: Date, all: boolean): string => {
	const listed = [...gates.gates.values()].filter(
		(gate) => all || gateState(gate, now) === "Open",
	);
	if (listed.length === 0) return all ? "No Gates\n" : "No open Gates\n";
	const header = [
		"ID",
		...(all ? ["STATE"] : []),
		"KIND",
		"REQUESTER",
		"AGE",
		"PAYLOAD",
	];
	const rows = listed.map((gate) => [
		gate.id,
		...(all ? [gateState(gate, now)] : []),
		gate.kind,
		actorText(gate.requester),
		ageOf(now.getTime() - Date.parse(gate.requested_at)),
		summaryOf(gate.payload),
	]);
	return `${table([header, ...rows])}\n`;
};

const requestGate = async (args: string[], ctx: CommandContext) => {
	const { values } = parseArgs({
		args,
		options: {
			kind: { type: "string" },
			payload: { type: "string" },
			task: { type: "string" },
			lifetime: { type: "string" },
			as: { type: "string" },
		},
	});
	if (values.kind === undefined || values.payload === undefined) {
		throw new UsageError("gate request needs --kind and --payload");
	}
	const kind = parseOrUsage(
		GateKind,
		values.kind,
		`--kind must be one of ${GateKind.options.join(", ")}`,
	);
	const lifetime_s =
		values.lifetime === undefined
			? DEFAULT_LIFETIME_S
			: Number(values.lifetime);
	if (!Number.isInteger(lifetime_s) || lifetime_s <= 0) {
		throw new UsageError(
			`--lifetime ${values.lifetime} is not a positive whole number of seconds`,
		);
	}
	const actor = parseActor(values.as);
	const task_id =
		values.task === undefined
			? undefined
			: parseOrUsage(TaskId, values.task, "--task must look like T-1");

	const text =
		values.payload === "-"
			? await readAll(ctx.stdin)
			: readFileSync(values.payload, "utf8");
	let payload: Gate["payload"];
	try {
		payload = z.json().parse(JSON.parse(text));
	} catch (error) {
		throw new Error(
			`the Gate payload is not JSON: ${(error as Error).message}`,
		);
	}

	return withLedger(ctx.home, true, (ledger) => {
		const gate_id = GateId.parse(nextId("G", gatesOf(ledger).gates.keys()));
		const payload_hash = sha256Hex(canonicalJson(payload));
		ledger.append({
			actor,
			...(task_id === undefined ? {} : { task_id }),
			kind: "GateRequested",
			payload: {
				gate_id,
				kind,
				payload,
				payload_hash,
				lifetime_s,
			},
		});
		ctx.stdout.write(`${gate_id} ${payload_hash}\n`);
		return 0;
	});
};

const decideGate = async (args: string[], ctx: CommandContext) => {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			approve: { type: "boolean" },
			reject: { type: "boolean" },
			reason: { type: "string" },
		},
	});
	const [id, ...extra] = positionals;
	if (id === undefined || extra.length > 0) {
		throw new UsageError("gate decide takes one gate id");
	}
	if (Boolean(values.approve) === Boolean(values.reject)) {
		throw new UsageError(
			"gate decide takes exactly one of --approve or --reject",
		);
	}
	if (!values.reason?.trim()) {
		throw new UsageError("gate decide needs --reason");
	}

	// The signature time and the Event's ts are one instant, so this opens
	// the Ledger with its own clock rather than through withLedger.
	const now = new Date();
	const ledger = openLedger({ home: ctx.home, writer: true, clock: () => now });
	try {
		const gate = gateOf(gatesOf(ledger), id);
		const decision: NewEvent = {
			actor: { tag: "Operator" },
			...(gate.task_id === undefined ? {} : { task_id: gate.task_id }),
			kind: "GateDecided",
			payload: {
				gate_id: gate.id,
				decided_by: { tag: "Operator" },
				decided_at: IsoTime.parse(now.toISOString()),
				payload_hash: sha256Hex(canonicalJson(gate.payload)),
				meaning: values.approve ? "approve" : "reject",
				reason: values.reason,
			},
		};
		ctx.stdout.write(`${canonicalJson(ledger.append(decision))}\n`);
		return 0;
	} finally {
		ledger.close();
	}
};

const showGate = (gate: Gate, now: Date) => {
	const lines = [
		`Gate ${gate.id}`,
		`kind: ${gate.kind}`,
		`state: ${gateState(gate, now)}`,
		`requester: ${actorText(gate.requester)}`,
		`requested_at: ${gate.requested_at}`,
		...(gate.task_id === undefined ? [] : [`task: ${gate.task_id}`]),
		`expires_at: ${expiresAt(gate).toISOString()}`,
		`payload_hash: ${gate.payload_hash}`,
	];
	const d = gate.decision;
	if (d !== undefined) {
		lines.push(
			`decision: ${d.meaning} by Operator at ${d.decided_at}: ${d.reason}`,
		);
	}
	return `${lines.join("\n")}\n\n${JSON.stringify(gate.payload, null, 2)}\n`;
};

export const gateCommands: CommandTable = {
	request: {
		args: "--kind <kind> --payload <file|-> [--task T-n] [--lifetime s] [--as A-id]",
		describe: `Request a Gate (${GateKind.options.join(", ")}); prints its id and payload hash`,
		run: requestGate,
	},
	list: {
		args: "[--all]",
		describe: "List open Gates, or every Gate with its state",
		run: async (args, ctx) => {
			const { values } = parseArgs({
				args,
				options: { all: { type: "boolean" } },
			});
			ctx.stdout.write(
				gateListing(readGates(ctx.home), new Date(), Boolean(values.all)),
			);
			return 0;
		},
	},
	show: {
		args: "<gate id>",
		describe: "Show a Gate with its full payload",
		run: async (args, ctx) => {
			const { positionals } = parseArgs({ args, allowPositionals: true });
			const [id, ...extra] = positionals;
			if (id === undefined || extra.length > 0) {
				throw new UsageError("gate show takes one gate id");
			}
			ctx.stdout.write(showGate(gateOf(readGates(ctx.home), id), new Date()));
			return 0;
		},
	},
	decide: {
		args: "<gate id> --approve|--reject --reason <text>",
		describe: "Sign the Operator's decision on an open Gate",
		run: decideGate,
	},
};
