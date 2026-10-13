import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event } from "../events.js";
import { sha256Hex } from "../hash.js";
import { AgentId, ArtifactId, RoomId, Sha256, TaskId } from "../ids.js";
import { openLedger } from "../ledger.js";
import { say } from "../room/lifecycle.js";
import { seedRooms } from "../room/seed.js";
import { openArtifacts } from "../sandbox/artifacts.js";
import { register } from "../sandbox/lifecycle.js";
import { assign, propose, start } from "../task/lifecycle.js";
import { dockerAvailable, requireDocker } from "../test-support/docker.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import type { Actor } from "../types/actor.js";
import { aliquotServer, preToolUse, sdkToolName } from "./sdk.js";
import { TOOLS } from "./table.js";
import { toolContext } from "./tool.js";

type Reply = { result: { content: { text: string }[]; isError?: boolean } };

/**
 * An MCP client on an in-process transport: the JSON-RPC that the Agent SDK
 * sends an SDK server during a Turn, with no model and no network.
 */
const connect = async (server: Awaited<ReturnType<typeof aliquotServer>>) => {
	const replies = new Map<number, unknown>();
	let next = 0;
	const transport: Parameters<typeof server.instance.connect>[0] = {
		start: async () => {},
		close: async () => {},
		send: async (message) => {
			if ("id" in message && typeof message.id === "number") {
				replies.set(message.id, message);
			}
		},
	};
	await server.instance.connect(transport);
	const request = async (method: string, params?: Record<string, unknown>) => {
		const id = ++next;
		transport.onmessage?.({ jsonrpc: "2.0", id, method, params });
		for (let tries = 0; !replies.has(id); tries++) {
			if (tries > 1000) throw new Error(`no reply to ${method}`);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		return replies.get(id);
	};
	await request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "aliquot-test", version: "0" },
	});
	transport.onmessage?.({
		jsonrpc: "2.0",
		method: "notifications/initialized",
	});
	return {
		list: async () =>
			(
				(await request("tools/list")) as {
					result: { tools: { name: string }[] };
				}
			).result.tools,
		/** The Tool's text, and whether the server marked it an error. */
		call: async (name: string, args: object = {}) => {
			const { result } = (await request("tools/call", {
				name,
				arguments: args,
			})) as Reply;
			return { text: result.content[0]?.text ?? "", error: !!result.isError };
		},
	};
};

let s: Scenario;
let home: string;

beforeEach(() => {
	s = scenario("2026-10-12T09:00:00.000Z");
	home = mkdtempSync(join(tmpdir(), "aliquot-tools-"));
});

afterEach(() => {
	s.close();
	rmSync(home, { recursive: true, force: true });
});

/** The MCP client of one Agent's server. */
const as = async (slug: string) =>
	connect(
		await aliquotServer(
			toolContext({
				ledger: s.ledger,
				home,
				agent: AgentId.parse(`A-${slug}`),
			}),
		),
	);

/** The JSON a Tool returned, which it must not mark an error. */
const done = async (
	client: Awaited<ReturnType<typeof connect>>,
	name: string,
	args: object = {},
	// biome-ignore lint/suspicious/noExplicitAny: a Tool's JSON, read by each test
): Promise<any> => {
	const { text, error } = await client.call(name, args);
	expect(error, text).toBe(false);
	return JSON.parse(text);
};

const eventAt = (seq: number): Event | undefined =>
	s.events().find((e) => e.seq === seq);

const agent = (slug: string): Actor => ({
	tag: "Agent",
	id: AgentId.parse(`A-${slug}`),
});

describe("the Agent's MCP server", () => {
	it("lists every Tool of the table, each with an input schema", async () => {
		const rin = await as("rin");

		const listed = await rin.list();

		expect(listed.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
		expect(listed).toHaveLength(26);
	});

	it("gives every Agent list_scripts, which returns each registered Script's id, latest version, input types and stage (#64)", async () => {
		const receipt = {
			actor: { tag: "Operator" },
			name: "log_receipt",
			owner_agent: AgentId.parse("A-bram"),
			input_types: ["SubmissionRecord", "LimsDatabase"],
			output_types: ["ReceivingLogRow", "LimsDatabase"],
			entrypoint: "main.py",
			image_digest: Sha256.parse("c".repeat(64)),
		} as const;
		register(s.ledger, receipt);
		register(s.ledger, receipt);

		const agents = [...s.ledger.projections.org.agents.keys()];
		expect(agents, "the seeded roster").toHaveLength(8);
		for (const agent of agents) {
			const client = await as(agent.slice("A-".length));
			expect(
				(await client.list()).map((t) => t.name),
				`${agent}'s Tools`,
			).toContain("list_scripts");
			expect(await done(client, "list_scripts"), agent).toEqual([
				{ id: "S-copy", version: 1, input_types: [], output_types: [] },
				{
					id: "S-log_receipt",
					version: 2,
					input_types: ["SubmissionRecord", "LimsDatabase"],
					output_types: ["ReceivingLogRow", "LimsDatabase"],
					stage: "stage 2 Receipt, worked by A-bram",
				},
			]);
		}
	});

	it("walks a Task through propose, assign, start, Help, Memory note, complete, Review and completion, each as the calling Agent", async () => {
		const [pia, rin] = [await as("pia"), await as("rin")];

		expect(await done(rin, "read_tasks")).toEqual([]);
		const proposed = await done(pia, "propose_task", {
			title: "Parse the form",
			goal: "A SubmissionRecord",
			tat_class: "Regular",
			priority: 1,
		});
		expect(proposed.task).toMatchObject({
			id: "T-1",
			state: { tag: "Proposed" },
		});
		expect(eventAt(proposed.seq)).toMatchObject({
			kind: "TaskProposed",
			actor: agent("pia"),
		});

		const assigned = await done(pia, "assign_task", {
			task_id: "T-1",
			assignee: "A-rin",
		});
		expect(assigned.task.state).toEqual({ tag: "Assigned", assignee: "A-rin" });
		const started = await done(rin, "start_task", { task_id: "T-1" });
		expect(eventAt(started.seq)).toMatchObject({
			kind: "TaskStarted",
			actor: agent("rin"),
		});
		expect(
			(await done(rin, "read_tasks", { assignee: "A-rin" })).map(
				(t: { id: string }) => t.id,
			),
		).toEqual(["T-1"]);

		const help = await done(rin, "request_help", {
			task_id: "T-1",
			to: "A-pia",
			question: "Which column holds the TAT code?",
		});
		expect(eventAt(help.seq)).toMatchObject({
			kind: "HelpRequested",
			actor: agent("rin"),
			payload: { to: agent("pia") },
		});
		const note = await done(rin, "note_memory", {
			task_id: "T-1",
			lesson: "The TAT code is in column F",
			applies_to: ["SubmissionForm"],
		});
		expect(eventAt(note.seq)).toMatchObject({
			kind: "MemoryNoted",
			payload: { agent: "A-rin", task_id: "T-1" },
		});

		const completed = await done(rin, "complete_task", {
			task_id: "T-1",
			reviewer: "A-pia",
		});
		expect(completed.task.state).toEqual({
			tag: "UnderReview",
			assignee: "A-rin",
			reviewer: agent("pia"),
		});
		const reviewed = await done(pia, "review_task", {
			task_id: "T-1",
			quality: 3,
			traceability: 3,
			boundary_adherence: 3,
			collaboration: 2,
			timeliness: 3,
			note: "Clean",
		});
		expect(eventAt(reviewed.seq)).toMatchObject({
			kind: "ReviewRecorded",
			actor: agent("pia"),
			payload: { reviewer: agent("pia"), collaboration: 2 },
		});
		const closed = await done(pia, "complete_task", { task_id: "T-1" });
		expect(closed.task.state).toEqual({ tag: "Done", assignee: "A-rin" });
	});

	it("fails, escalates and hands off a Task, and returns the Ledger's refusal as text", async () => {
		const [pia, rin] = [await as("pia"), await as("rin")];
		for (let i = 1; i <= 3; i++) {
			await done(pia, "propose_task", {
				title: `Task ${i}`,
				goal: "",
				tat_class: "Regular",
				priority: 1,
			});
			await done(pia, "assign_task", { task_id: `T-${i}`, assignee: "A-rin" });
		}

		const failed = await done(rin, "fail_task", {
			task_id: "T-1",
			reason: "The form is blank",
		});
		expect(failed.task.state).toEqual({
			tag: "Failed",
			reason: "The form is blank",
		});
		const escalated = await done(rin, "escalate_task", {
			task_id: "T-2",
			to: "Operator",
			reason: "Outside my Charter",
		});
		expect(escalated.task.state).toEqual({
			tag: "Escalated",
			to: { tag: "Operator" },
		});
		expect(
			await rin.call("hand_off", {
				task_id: "T-3",
				to: "A-ines",
				reason: "Ines reads PDFs",
			}),
		).toEqual({
			text: "TaskHandedOff refused: T-3 is Assigned, expected InProgress",
			error: true,
		});
		await done(rin, "start_task", { task_id: "T-3" });
		const handed = await done(rin, "hand_off", {
			task_id: "T-3",
			to: "A-ines",
			reason: "Ines reads PDFs",
		});
		expect(eventAt(handed.seq)).toMatchObject({
			kind: "TaskHandedOff",
			actor: agent("rin"),
			payload: { from: "A-rin", to: "A-ines" },
		});
	});

	it("says, reads and opens Rooms as the Agent, under the Room membership rule", async () => {
		const [rin, ines] = [await as("rin"), await as("ines")];
		seedRooms(s.ledger);

		const said = await done(rin, "send_message", {
			room_id: "RM-lab",
			body: "Morning",
		});
		expect(eventAt(said.seq)).toMatchObject({
			kind: "MessageSent",
			actor: agent("rin"),
		});
		expect(
			(await done(ines, "read_room", { room_id: "RM-lab" })).map(
				(m: { body: string }) => m.body,
			),
		).toContain("Morning");

		const opened = await done(rin, "open_room", {
			room_id: "RM-rin-pia",
			name: "Rin and Pia",
			purpose: "Intake questions",
			agents: ["A-pia"],
		});
		expect(opened.room).toMatchObject({
			membership: { tag: "Listed", agents: ["A-rin", "A-pia"] },
			opened_by: agent("rin"),
		});
		expect(await ines.call("read_room", { room_id: "RM-rin-pia" })).toEqual({
			text: "read_room refused: history refused: A-ines is not a member of RM-rin-pia",
			error: true,
		});
	});

	it("stores the Operator's Message as an Other Artifact of its JSON, naming its MessageSent, once", async () => {
		const [bram, rin] = [await as("bram"), await as("rin")];
		seedRooms(s.ledger);
		const { seq } = say(s.ledger, {
			actor: { tag: "Operator" },
			room_id: RoomId.parse("RM-lab"),
			body: 'Received 3 bottles, "Lot 2403A"',
		});
		const json = `{"seq":${seq},"room":"RM-lab","said_by":"Operator","ts":"2026-10-12T09:00:00.000Z","body":"Received 3 bottles, \\"Lot 2403A\\""}`;
		const id = ArtifactId.parse(sha256Hex(json));

		const stored = await done(bram, "store_message", { seq });

		expect(stored.artifact).toMatchObject({
			id,
			artifact_type: "Other",
			media_type: "application/json",
			produced_by: { tag: "Operator" },
			lineage: [],
			filename: `message-${seq}.json`,
		});
		expect(eventAt(stored.seq)).toMatchObject({
			kind: "ArtifactStored",
			actor: agent("bram"),
			causation_id: seq,
		});
		expect(openArtifacts({ ledger: s.ledger, home }).read(id).toString()).toBe(
			json,
		);
		const count = s.events().length;
		expect(
			(await done(rin, "store_message", { seq })).seq,
			"storing it again returns the first ArtifactStored",
		).toBe(stored.seq);
		expect(s.events()).toHaveLength(count);

		const reply = await done(rin, "send_message", {
			room_id: "RM-lab",
			body: "Logged",
		});
		expect(await bram.call("store_message", { seq: reply.seq })).toEqual({
			text: `store_message refused: seq ${reply.seq} was said by A-rin; only the Operator's Messages are stored as Artifacts`,
			error: true,
		});
		expect(await bram.call("store_message", { seq: 999 })).toEqual({
			text: "store_message refused: seq 999 is not a Message",
			error: true,
		});
	});

	it("reads, lists and walks the Lineage of Artifacts", async () => {
		const rin = await as("rin");
		const store = openArtifacts({ ledger: s.ledger, home });
		const operator = { tag: "Operator" } as const;
		const form = store.store(
			Buffer.from("Lot 42\n"),
			{
				artifact_type: "SubmissionForm",
				media_type: "text/plain",
				produced_by: operator,
				lineage: [],
				filename: "form.txt",
			},
			{ actor: operator },
		).artifact;
		const record = store.store(
			Buffer.from('{"lot":"42"}'),
			{
				artifact_type: "SubmissionRecord",
				media_type: "application/json",
				produced_by: operator,
				lineage: [form.id],
				filename: "record.json",
			},
			{ actor: operator },
		).artifact;

		expect(await done(rin, "read_artifact", { artifact_id: form.id })).toEqual({
			artifact: expect.objectContaining({ id: form.id }),
			text: "Lot 42\n",
		});
		expect(
			(
				await done(rin, "list_artifacts", { artifact_type: "SubmissionRecord" })
			).map((a: { id: string }) => a.id),
		).toEqual([record.id]);
		expect(
			(await done(rin, "lineage", { artifact_id: record.id })).map(
				(l: { depth: number; record: { id: string } }) => [
					l.depth,
					l.record.id,
				],
			),
		).toEqual([
			[0, record.id],
			[1, form.id],
		]);
		expect(
			await rin.call("read_artifact", { artifact_id: "f".repeat(64) }),
		).toEqual({
			text: `read_artifact refused: Artifact ${"f".repeat(64)} is not in the Ledger`,
			error: true,
		});
	});

	it("publishes a Skill, revises a definition, requests a Gate, orders and ends Rest, and verifies the Ledger", async () => {
		const [pia, rin, bram, mabel] = [
			await as("pia"),
			await as("rin"),
			await as("bram"),
			await as("mabel"),
		];

		const skill = await done(pia, "publish_skill", {
			id: "parse-submission-form",
			title: "Parse a Submission Form",
			body_md: "1. Read the header table.",
		});
		expect(eventAt(skill.seq)).toMatchObject({
			kind: "SkillPublished",
			payload: { version: 1, author: agent("pia") },
		});
		const revised = await done(rin, "propose_revision", {
			agent_id: "A-rin",
			reason: "Granted the Skill",
			skills: ["parse-submission-form"],
		});
		expect(revised.agent.definition).toMatchObject({
			version: 2,
			skills: ["parse-submission-form"],
			revised_by: agent("rin"),
			charter: { forbidden: ["RunOutsideSandbox"] },
		});
		const gate = await done(bram, "request_gate", {
			kind: "Deploy",
			payload: { app: "receiving" },
		});
		expect(eventAt(gate.seq)).toMatchObject({
			kind: "GateRequested",
			actor: agent("bram"),
			payload: { kind: "Deploy", payload: { app: "receiving" } },
		});
		const rest = await done(mabel, "order_rest", {
			agent_id: "A-ines",
			reason: "Long week",
		});
		expect(eventAt(rest.seq)).toMatchObject({
			kind: "RestOrdered",
			actor: agent("mabel"),
			payload: { agent_id: "A-ines", action: "begin" },
		});
		const ended = await done(mabel, "end_rest", {
			agent_id: "A-ines",
			reason: "Rested",
		});
		expect(eventAt(ended.seq)).toMatchObject({
			kind: "RestOrdered",
			payload: { action: "end" },
		});
		expect(await done(rin, "verify_ledger")).toEqual({
			ok: true,
			count: s.events().length,
		});
	});

	it("records a Charter refusal as ActionRefused by the Conductor and tells the model why", async () => {
		const odile = await as("odile");
		const before = s.events().length;

		expect(
			await odile.call("run_script", {
				script: "S-parse_submission",
				inputs: [],
			}),
		).toEqual({
			text: "run_script refused: A-odile's Charter forbids RunScript: run_script performs it",
			error: true,
		});
		expect(s.events().slice(before)).toMatchObject([
			{
				kind: "ActionRefused",
				actor: { tag: "Conductor" },
				payload: {
					agent: "A-odile",
					tool: "run_script",
					action: "RunScript",
					reason: "A-odile's Charter forbids RunScript: run_script performs it",
				},
			},
		]);
	});
});

describe("the PreToolUse hook", () => {
	const hook = (tool_name: string) =>
		preToolUse(
			{
				hook_event_name: "PreToolUse",
				tool_name,
				tool_input: {},
				tool_use_id: "toolu_1",
				session_id: "s",
				transcript_path: "/dev/null",
				cwd: "/",
			},
			"toolu_1",
			{ signal: new AbortController().signal },
		);

	it("lets the Aliquot server's Tools through to their own hook and denies every other tool", async () => {
		expect(await hook(sdkToolName("run_script"))).toEqual({});
		expect(await hook("Bash")).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason:
					"Bash is not an Aliquot Tool; an Agent calls only the Tools of the aliquot server",
			},
		});
	});
});

const suite = dockerAvailable
	? "run_script through the server (Docker)"
	: "run_script through the server: SKIPPED because `docker info` failed; start Docker to run these";

const fixture = fileURLToPath(
	new URL("../../../fixtures/submission-form-seed1.docx", import.meta.url),
);
const fixtureId = ArtifactId.parse(sha256Hex(readFileSync(fixture)));
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

describe.skipIf(!requireDocker())(suite, () => {
	it("runs the stage 1 Script for Rin, then the stage 2 Script for Bram on its record and the carried LimsDatabase, each returning the Run with the stage's Evaluation", async () => {
		const workflow = spawnSync(
			process.execPath,
			["--import", "tsx", cli, "--home", home, "workflow", "run", fixture],
			{ encoding: "utf8", env: { ...process.env, ALIQUOT_HOME: "" } },
		);
		expect(workflow.status, workflow.stderr).toBe(0);
		const ledger = openLedger({ home, writer: true });
		try {
			const operator = { tag: "Operator" } as const;
			/** `slug` runs `script` on `inputs` through its server, on a Task assigned to it and started. */
			const runAs = async (
				slug: string,
				script: string,
				inputs: readonly ArtifactId[],
			) => {
				const task_id = propose(ledger, {
					actor: operator,
					title: `${script} again`,
					goal: "",
					tat_class: "Regular",
					priority: 1,
					inputs,
				}).task.id;
				assign(ledger, {
					actor: operator,
					task_id,
					assignee: AgentId.parse(`A-${slug}`),
				});
				start(ledger, { actor: agent(slug), task_id });
				const client = await connect(
					await aliquotServer(
						toolContext({ ledger, home, agent: AgentId.parse(`A-${slug}`) }),
					),
				);
				const { text, error } = await client.call("run_script", {
					script,
					inputs,
					task_id,
				});
				expect(error, text).toBe(false);
				const ran = JSON.parse(text);
				expect(ran.run.exit_code).toBe(0);
				expect(ran.evaluation).toMatchObject({
					run_id: ran.run.id,
					task_id: TaskId.parse(task_id),
					score: 1,
					passed: true,
				});
				expect(ledger.all().find((e) => e.seq === ran.seq)).toMatchObject({
					kind: "EvaluationRecorded",
					actor: agent(slug),
				});
				return ran;
			};
			const typeOf = (id: ArtifactId) =>
				ledger.projections.artifacts.artifacts.get(id)?.artifact_type;
			const latestDatabase = [
				...ledger.projections.artifacts.artifacts.values(),
			]
				.filter((a) => a.artifact_type === "LimsDatabase")
				.at(-1)?.id;
			if (latestDatabase === undefined) {
				throw new Error("the workflow's stage 2 stored no LimsDatabase");
			}

			const parsed = await runAs("rin", "S-parse_submission", [fixtureId]);
			expect(parsed.evaluation.stage).toBe(1);
			const record = parsed.run.outputs.find(
				(id: ArtifactId) => typeOf(id) === "SubmissionRecord",
			);
			const received = await runAs("bram", "S-log_receipt", [
				record,
				latestDatabase,
			]);

			expect(received.evaluation.stage).toBe(2);
			expect(received.run.inputs).toEqual([record, latestDatabase]);
			expect(ledger.verify().ok).toBe(true);
		} finally {
			ledger.close();
		}
	}, 120_000);
});
