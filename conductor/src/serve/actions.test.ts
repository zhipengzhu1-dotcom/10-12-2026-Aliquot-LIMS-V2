import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event } from "../events.js";
import { AgentId } from "../ids.js";
import { pause } from "../org/lifecycle.js";
import { rosterDefinitions } from "../org/seed.js";
import { LAB_ROOM, seedRooms } from "../room/seed.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import type { Verb } from "./actions.js";
import { type Serving, serve } from "./http.js";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const OPERATOR = { tag: "Operator" } as const;
const SCORES = {
	quality: 3,
	traceability: 3,
	boundary_adherence: 3,
	collaboration: 3,
	timeliness: 3,
};

const definitionOf = (id: string) => {
	const definition = rosterDefinitions().find((d) => d.id === id);
	if (definition === undefined) throw new Error(`${id} is not in the roster`);
	return definition;
};

type Case = {
	/** Sets up what the action needs and returns its body. */
	readonly body: (s: Scenario) => unknown;
	/** The Event the action appends, as far as the test pins it. */
	readonly event: Pick<Event, "kind"> & { readonly payload: object };
	/** A body the Ledger refuses, and the command line that asks the same. */
	readonly refused?: {
		readonly body: unknown;
		readonly command: (home: string) => {
			args: string[];
			input?: string;
		};
	};
};

const CASES: Record<Verb, Case> = {
	pause: {
		body: () => ({ agent_id: "A-rin", reason: "Retries pile up" }),
		event: {
			kind: "AgentPaused",
			payload: { agent_id: "A-rin", reason: "Retries pile up" },
		},
		refused: {
			body: { agent_id: "A-nobody", reason: "Gone" },
			command: () => ({
				args: ["org", "pause", "A-nobody", "--reason", "Gone"],
			}),
		},
	},
	resume: {
		body: (s) => {
			pause(s.ledger, {
				actor: OPERATOR,
				agent_id: AgentId.parse("A-rin"),
				reason: "Retries pile up",
			});
			return { agent_id: "A-rin" };
		},
		event: { kind: "AgentResumed", payload: { agent_id: "A-rin" } },
		refused: {
			body: { agent_id: "A-bram" },
			command: () => ({ args: ["org", "resume", "A-bram"] }),
		},
	},
	revise: {
		body: () => ({
			definition: {
				...definitionOf("A-ines"),
				version: 2,
				revision_reason: "Flag unreadable scans sooner",
			},
		}),
		event: {
			kind: "AgentDefinitionRevised",
			payload: {
				definition: {
					id: "A-ines",
					version: 2,
					revision_reason: "Flag unreadable scans sooner",
				},
			},
		},
		refused: {
			body: {
				definition: { ...definitionOf("A-rin"), version: 3 },
			},
			command: (home) => {
				const file = join(home, "rin-v3.json");
				writeFileSync(
					file,
					JSON.stringify({ ...definitionOf("A-rin"), version: 3 }),
				);
				return { args: ["org", "revise", "A-rin", file] };
			},
		},
	},
	// No guard refuses a RetireAgent request the Gate lifecycle builds.
	"retire-request": {
		body: () => ({ agent_id: "A-bram", reason: "Slice 1 ends" }),
		event: {
			kind: "GateRequested",
			payload: {
				gate_id: "G-1",
				kind: "RetireAgent",
				payload: { agent_id: "A-bram", reason: "Slice 1 ends" },
			},
		},
	},
	"gate-decide": {
		body: (s) => {
			const gate_id = s.requested("RetireAgent", { agent_id: "A-bram" });
			return {
				gate_id,
				decision: "reject",
				hash: s.ledger.projections.gates.gates.get(gate_id)?.payload_hash,
				reason: "Bram stays",
			};
		},
		event: {
			kind: "GateDecided",
			payload: { gate_id: "G-1", meaning: "reject", reason: "Bram stays" },
		},
		refused: {
			body: {
				gate_id: "G-9",
				decision: "approve",
				hash: "0".repeat(64),
				reason: "Checked",
			},
			command: () => ({
				args: [
					"gate",
					"decide",
					"G-9",
					"--approve",
					"--hash",
					"0".repeat(64),
					"--reason",
					"Checked",
				],
			}),
		},
	},
	"task-assign": {
		body: (s) => ({
			task_id: s.task(AgentId.parse("A-rin"), { start: false }),
			assignee: "A-ines",
		}),
		event: {
			kind: "TaskAssigned",
			payload: { task_id: "T-1", assignee: "A-ines" },
		},
		refused: {
			body: { task_id: "T-9", assignee: "A-rin" },
			command: () => ({ args: ["task", "assign", "T-9", "A-rin"] }),
		},
	},
	"task-handoff": {
		body: (s) => ({
			task_id: s.task(AgentId.parse("A-rin")),
			to: "A-ines",
			reason: "It is a PDF",
		}),
		event: {
			kind: "TaskHandedOff",
			payload: {
				task_id: "T-1",
				from: "A-rin",
				to: "A-ines",
				reason: "It is a PDF",
			},
		},
		refused: {
			body: { task_id: "T-9", to: "A-ines", reason: "It is a PDF" },
			command: () => ({
				args: ["task", "handoff", "T-9", "A-ines", "--reason", "It is a PDF"],
			}),
		},
	},
	"task-review": {
		body: (s) => ({
			task_id: s.submitted(AgentId.parse("A-odile")),
			...SCORES,
			note: "Clean",
		}),
		event: {
			kind: "ReviewRecorded",
			payload: { reviewer: OPERATOR, ...SCORES, note: "Clean" },
		},
		refused: {
			body: { task_id: "T-9", ...SCORES, note: "Clean" },
			command: () => ({
				args: [
					"vitality",
					"review",
					"T-9",
					...["--quality", "3", "--traceability", "3", "--boundary", "3"],
					...["--collaboration", "3", "--timeliness", "3", "--note", "Clean"],
				],
			}),
		},
	},
	"room-say": {
		body: () => ({ room_id: "RM-lab", body: "Morning, all" }),
		event: {
			kind: "MessageSent",
			payload: { room_id: "RM-lab", body: "Morning, all" },
		},
		refused: {
			body: { room_id: "RM-nowhere", body: "Hello?" },
			command: () => ({ args: ["room", "say", "RM-nowhere"], input: "Hello?" }),
		},
	},
	"room-open": {
		body: () => ({
			id: "RM-pdf",
			name: "PDF",
			purpose: "Unreadable scans",
			membership: { tag: "Listed", agents: ["A-ines"] },
		}),
		event: {
			kind: "RoomOpened",
			payload: { room: { id: "RM-pdf", opened_by: OPERATOR } },
		},
		refused: {
			body: { ...LAB_ROOM, opened_by: undefined },
			command: () => ({
				args: ["room", "open"],
				input: JSON.stringify(LAB_ROOM),
			}),
		},
	},
	"rest-order": {
		body: () => ({ agent_id: "A-rin", action: "begin", reason: "Fatigued" }),
		event: {
			kind: "RestOrdered",
			payload: { agent_id: "A-rin", action: "begin", reason: "Fatigued" },
		},
		refused: {
			body: { agent_id: "A-bram", action: "end", reason: "Rested" },
			command: () => ({
				args: ["vitality", "rest", "A-bram", "--end", "--reason", "Rested"],
			}),
		},
	},
};

let home: string;
let s: Scenario;
let serving: Serving;
let stopped: boolean;

const stop = async () => {
	if (stopped) return;
	stopped = true;
	await serving.close();
	s.close();
};

const post = async (verb: string, body: unknown) => {
	const res = await fetch(`${serving.url}/api/actions/${verb}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, text: await res.text() };
};

const aliquot = ({ args, input = "" }: { args: string[]; input?: string }) =>
	spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--home", home, ...args],
		{ encoding: "utf8", input, env: { ...process.env, ALIQUOT_HOME: "" } },
	);

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "aliquot-actions-"));
	s = scenario("2026-10-01T00:00:00.000Z", { home });
	seedRooms(s.ledger);
	stopped = false;
	serving = await serve(s.ledger, { port: 0, bind: "127.0.0.1", ui: home });
});

afterEach(async () => {
	await stop();
	rmSync(home, { recursive: true, force: true });
});

describe("POST /api/actions/<verb>", () => {
	for (const [verb, { body, event, refused }] of Object.entries(CASES)) {
		it(`${verb} appends its Event as the Operator${refused ? ", or answers 409 in the command's words" : ""}`, async () => {
			const refusal = refused && (await post(verb, refused.body));

			const done = await post(verb, body(s));

			expect(done.status, done.text).toBe(200);
			const appended = JSON.parse(done.text) as Event;
			expect(appended).toMatchObject({ actor: OPERATOR, ...event });
			expect(
				s.ledger.all()[appended.seq - 1],
				"the answer is the Event the Ledger holds",
			).toEqual(appended);
			if (refused === undefined || refusal === undefined) return;

			await stop();
			const command = aliquot(refused.command(home));

			expect(refusal.status, refusal.text).toBe(409);
			expect(command.status).toBe(1);
			expect(command.stderr).toBe(`AppendRefused: ${refusal.text}`);
		});
	}
});
