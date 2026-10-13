import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { AgentId, RoomId, Sha256, TaskId } from "../ids.js";
import { intake } from "../intake/command.js";
import { pause, resume } from "../org/lifecycle.js";
import { open, say } from "../room/lifecycle.js";
import { buildImage, scriptsRoot } from "../sandbox/image.js";
import { store } from "../sandbox/lifecycle.js";
import { assign, escalate, propose, start } from "../task/lifecycle.js";
import { dockerAvailable, requireDocker } from "../test-support/docker.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import { finishTurn, startTurn } from "../turn/lifecycle.js";
import {
	type ModelRequest,
	type RunModel,
	type ScriptedModel,
	scriptedModel,
} from "../turn/model.js";
import type { ArtifactType } from "../types/artifact.js";
import type { TurnUsage } from "../types/turn.js";
import { orderRest, sample } from "../vitality/lifecycle.js";
import { moodOf } from "../vitality/mood.js";
import { vitalityProjection } from "../vitality/projection.js";
import { STAGES } from "../workflow/stages.js";
import { ensureScript, runWorkflow } from "../workflow/tracer.js";
import { plan, type SchedulerOptions } from "./plan.js";
import { lineOf, openScheduler, type Said } from "./scheduler.js";

const id = AgentId.parse;
const odile = id("A-odile");
const rin = id("A-rin");
const ines = id("A-ines");
const bram = id("A-bram");
const mabel = id("A-mabel");
const thorne = id("A-thorne");
const pia = id("A-pia");
const operator = { tag: "Operator" } as const;
const lab = RoomId.parse("RM-lab");

const FIXTURE = fileURLToPath(
	new URL("../../../fixtures/submission-form-seed1.docx", import.meta.url),
);
const T0 = "2026-10-12T09:00:00.000Z";
const later = (seconds: number) =>
	new Date(Date.parse(T0) + seconds * 1000).toISOString();

const OPTIONS: SchedulerOptions = {
	tickMs: 15_000,
	dutyMs: 30 * 60_000,
	concurrency: 2,
	energyBudgetTokens: 1_000_000,
};

const usage = (tokens: number): TurnUsage => ({
	input_tokens: tokens,
	output_tokens: 0,
	cache_creation_tokens: 0,
	cache_read_tokens: 0,
	cost_usd: 0.01,
});

/** The weighted pick, computed apart from the Scheduler: sha256 of the Task id, first 32 bits, mod the total. */
const expectedPick = (task_id: string, weights: [AgentId, number][]) => {
	const total = weights.reduce((sum, [, w]) => sum + w, 0);
	const pick =
		Number.parseInt(
			createHash("sha256").update(task_id).digest("hex").slice(0, 8),
			16,
		) % total;
	let below = 0;
	return weights.find(([, w]) => {
		below += w;
		return pick < below;
	})?.[0];
};

/** A finished Turn of `tokens` by `agent`, at the scenario's clock. */
const spent = (s: Scenario, agent: AgentId, tokens: number) => {
	const { turn } = startTurn(s.ledger, {
		agent,
		model: "claude-sonnet-5-5",
		energyBudgetTokens: OPTIONS.energyBudgetTokens,
	});
	finishTurn(s.ledger, {
		turn_id: turn.started.turn_id,
		usage: usage(tokens),
		outcome: { tag: "Completed" },
		tool_calls: 0,
	});
};

/**
 * Bram fatigued: 80,000 tokens six hours ago are fatigue 0.64 in a sample
 * taken then, over the 0.6 the Mood table, not in force (#62), reads as
 * strained.
 */
const strainBram = (s: Scenario) => {
	s.at(new Date(Date.parse(T0) - 6 * 3_600_000).toISOString());
	spent(s, bram, 80_000);
	const { vitality } = sample(s.ledger, {
		actor: operator,
		agent: bram,
		now: s.now(),
		energyBudgetTokens: OPTIONS.energyBudgetTokens,
	});
	expect(vitality.fatigue).toBe(0.64);
};

const task = (
	s: Scenario,
	tat_class: "Regular" | "Rush1to2Days" = "Regular",
): TaskId =>
	propose(s.ledger, {
		actor: operator,
		title: `Task ${s.ledger.projections.tasks.tasks.size + 1}`,
		goal: "Do the work",
		tat_class,
		priority: 1,
	}).task.id;

let s: Scenario;
let opened: Scenario[];
let home: string;
const fresh = () => {
	s = scenario(T0);
	opened.push(s);
	return s;
};
beforeEach(() => {
	opened = [];
	home = mkdtempSync(join(tmpdir(), "aliquot-scheduler-"));
});
afterEach(() => {
	for (const each of opened) each.close();
	rmSync(home, { recursive: true, force: true });
});

describe("the Scheduler on the scripted model", () => {
	it("assigns the Director's stage 1 proposal to the Agent who works stage 1, starts at most two Turns at once, starts a resting Agent, and records every Turn", async () => {
		fresh();
		strainBram(s);
		s.at(T0);
		const form = intake(s.ledger, home, FIXTURE).artifact.id;
		const held = task(s);
		assign(s.ledger, { actor: operator, task_id: held, assignee: rin });
		orderRest(s.ledger, {
			actor: operator,
			agent_id: mabel,
			action: "begin",
			reason: "fatigue",
		});

		const prompts = new Map<AgentId, string[]>();
		const scripted = (calls: ScriptedModel["calls"]) =>
			scriptedModel({
				calls,
				usage_per_round: usage(100),
				stop: { tag: "Completed" },
			});
		const modelFor =
			(agent: AgentId): RunModel =>
			(request: ModelRequest) => {
				prompts.set(agent, [
					...(prompts.get(agent) ?? []),
					request.prompt.work,
				]);
				return scripted(
					agent === odile
						? [
								{
									tool: "propose_task",
									input: {
										title: "Stage 1 Submission: submission-form-seed1.docx",
										goal: "Parse the Submission Form",
										tat_class: "Regular",
										priority: 1,
										inputs: [form],
									},
								},
							]
						: [],
				)(request);
			};
		const lines: string[] = [];
		const scheduler = openScheduler(s.ledger, {
			home,
			options: OPTIONS,
			maxTurns: 5,
			login: { tag: "Subscription" },
			modelFor,
			say: (line) => lines.push(line),
		});
		let mostOpen = 0;
		s.ledger.onAppend(() => {
			mostOpen = Math.max(mostOpen, s.ledger.projections.turns.open.size);
		});
		const said: Said[] = [];
		const tickAt = async (at: string) => {
			s.at(at);
			said.push(...scheduler.tick().decisions);
			await scheduler.settled();
		};

		await tickAt(T0);
		expect(
			prompts.get(odile)?.[0],
			"the Director's prompt lists the Submission Form",
		).toContain(`${form} submission-form-seed1.docx`);
		const proposal = [...s.ledger.projections.tasks.tasks.values()].find((t) =>
			t.inputs.includes(form),
		);
		expect(proposal?.state, "the Director proposed the stage 1 Task").toEqual({
			tag: "Proposed",
		});
		const proposed = proposal?.id ?? TaskId.parse("T-0");

		await tickAt(later(1));
		expect(
			said.filter((d) => d.verb === "assign"),
			"a proposal younger than one Tick waits for its proposer",
		).toEqual([]);

		await tickAt(later(20));
		await tickAt(later(40));

		const assigned = s.ledger.projections.tasks.tasks.get(proposed)?.state;
		expect(assigned).toEqual({ tag: "Assigned", assignee: rin });
		const assignment = s
			.events()
			.find((e) => e.kind === "TaskAssigned" && e.payload.task_id === proposed);
		expect(assignment?.actor).toEqual({ tag: "Conductor" });
		expect(assignment?.causation_id, "it names the TaskProposed").toBe(
			s
				.events()
				.find(
					(e) => e.kind === "TaskProposed" && e.payload.task_id === proposed,
				)?.seq,
		);
		const assignLine = said.find(
			(d) => d.verb === "assign" && d.agent !== "nobody",
		);
		expect(assignLine?.why).toBe(`${proposed}: A-rin works stage 1 Submission`);

		expect(mostOpen, "two Turns were open at once").toBe(2);
		const starts = said.filter((d) => d.verb === "start");
		expect(
			said.some(
				(d) =>
					d.agent === thorne &&
					d.verb === "skip" &&
					d.why.startsWith("2 Turns open"),
			),
			"the third Agent with work waits for a free Turn",
		).toBe(true);
		expect(
			said.find((d) => d.agent === mabel),
			"the resting Steward starts on its standing duty",
		).toMatchObject({ verb: "start", why: "standing duty, no Turn yet" });

		const turns = [...s.ledger.projections.turns.turns.values()].filter(
			(t) => t.started.agent !== bram,
		);
		expect(turns.map((t) => t.started.agent)).toEqual(
			starts.map((d) => d.agent),
		);
		expect(
			turns.every((t) => t.finished?.payload.outcome.tag === "Completed"),
			"every started Turn finished and is recorded",
		).toBe(true);
		expect(lines).toEqual(expect.arrayContaining(said.map(lineOf)));
		expect(s.ledger.verify().ok).toBe(true);
	});

	it("tells a Specialist on Probation whom its completion names, so it completes its Task", async () => {
		fresh();
		const held = task(s);
		assign(s.ledger, { actor: operator, task_id: held, assignee: rin });
		const prompts = new Map<AgentId, string>();
		/** A model that completes its Task naming the reviewer its prompt names, as the live Turn of #35 could not. */
		const following: RunModel = async (request) => {
			const agent = id(
				/\((A-[a-z]+)\)/.exec(request.prompt.standing)?.[1] ?? "",
			);
			prompts.set(agent, request.prompt.work);
			const reviewer = /naming a reviewer, such as (A-[a-z]+)/.exec(
				request.prompt.work,
			)?.[1];
			return scriptedModel({
				calls:
					agent === rin
						? [
								{ tool: "start_task", input: { task_id: held } },
								{
									tool: "complete_task",
									input: { task_id: held, reviewer },
								},
							]
						: [],
				usage_per_round: usage(100),
				stop: { tag: "Completed" },
			})(request);
		};
		const scheduler = openScheduler(s.ledger, {
			home,
			options: { ...OPTIONS, concurrency: 8 },
			maxTurns: 5,
			login: { tag: "Subscription" },
			modelFor: () => following,
			say: () => {},
		});

		scheduler.tick();
		await scheduler.settled();

		expect(prompts.get(rin)).toContain(
			`${held} Task 1: Do the work\n  Inputs: none. Priority 1, TAT Regular.\n  Sampled for Review at Probation: complete it with complete_task naming a reviewer, such as A-pia.`,
		);
		expect(s.ledger.projections.tasks.tasks.get(held)?.state).toEqual({
			tag: "UnderReview",
			assignee: rin,
			reviewer: { tag: "Agent", id: id("A-pia") },
		});
	});

	it("assigns to and starts a Turn for an Agent whose Turns and open Tasks the Mood table would call overloaded: its Mood is fresh", async () => {
		fresh();
		spent(s, rin, 110_000);
		const capacity =
			s.ledger.projections.org.agents.get(rin)?.definition.capacity ?? 0;
		for (let i = 0; i <= capacity; i += 1) {
			assign(s.ledger, { actor: operator, task_id: task(s), assignee: rin });
		}
		const { vitality } = sample(s.ledger, {
			actor: operator,
			agent: rin,
			now: s.now(),
			energyBudgetTokens: OPTIONS.energyBudgetTokens,
		});
		expect(vitality.fatigue, "110,000 tokens of a 125,000 share").toBe(0.88);
		expect(vitality.load, "more open Tasks than capacity").toBeGreaterThan(1);
		expect(moodOf(vitality, false, false), "the table, not in force").toBe(
			"overloaded",
		);
		const shown = vitalityProjection(s.ledger.projections, {
			now: s.now(),
			energyBudgetTokens: OPTIONS.energyBudgetTokens,
		}).get(rin);
		expect(shown?.mood).toBe("fresh");
		expect(shown?.policy.mayAcceptTasks).toBe(true);

		const another = task(s);
		assign(s.ledger, { actor: operator, task_id: another, assignee: rin });
		expect(s.ledger.projections.tasks.tasks.get(another)?.state).toEqual({
			tag: "Assigned",
			assignee: rin,
		});

		const scheduler = openScheduler(s.ledger, {
			home,
			options: { ...OPTIONS, concurrency: 8 },
			maxTurns: 5,
			login: { tag: "Subscription" },
			modelFor: () =>
				scriptedModel({
					calls: [],
					usage_per_round: usage(1),
					stop: { tag: "Completed" },
				}),
			say: () => {},
		});
		const report = scheduler.tick();
		await scheduler.settled();

		expect(report.decisions.find((d) => d.agent === rin)).toMatchObject({
			verb: "start",
		});
		expect(
			[...s.ledger.projections.turns.turns.values()]
				.filter((t) => t.started.agent === rin)
				.map((t) => [t.started.mood, t.finished?.payload.outcome.tag]),
			"the Turn spent above, then the Scheduler's",
		).toEqual([
			["fresh", "Completed"],
			["fresh", "Completed"],
		]);
	});

	it("starts a Turn for a resting Agent and none for a paused one", async () => {
		fresh();
		orderRest(s.ledger, {
			actor: operator,
			agent_id: mabel,
			action: "begin",
			reason: "fatigue",
		});
		pause(s.ledger, {
			actor: operator,
			agent_id: thorne,
			reason: "audit window",
		});
		const scheduler = openScheduler(s.ledger, {
			home,
			options: { ...OPTIONS, concurrency: 8 },
			maxTurns: 5,
			login: { tag: "Subscription" },
			modelFor: () =>
				scriptedModel({
					calls: [],
					usage_per_round: usage(1),
					stop: { tag: "Completed" },
				}),
			say: () => {},
		});

		const report = scheduler.tick();
		await scheduler.settled();

		expect(report.decisions.map((d) => [d.agent, d.verb, d.why])).toEqual([
			[thorne, "skip", "A-thorne is paused; standing duty, no Turn yet"],
			[mabel, "start", "standing duty, no Turn yet"],
		]);
		expect(
			[...s.ledger.projections.turns.turns.values()].map(
				(t) => t.started.agent,
			),
		).toEqual([mabel]);
	});

	it("records a Turn the Ledger refuses to start as a skip of its Tick, and goes on", async () => {
		fresh();
		const scheduler = openScheduler(s.ledger, {
			home,
			options: OPTIONS,
			maxTurns: 5,
			login: { tag: "Subscription" },
			modelFor: (agent) => {
				// Paused after the plan and before the Turn starts.
				if (agent === thorne) {
					pause(s.ledger, {
						actor: operator,
						agent_id: thorne,
						reason: "audit window",
					});
				}
				return scriptedModel({
					calls: [],
					usage_per_round: usage(1),
					stop: { tag: "Completed" },
				});
			},
			say: () => {},
		});

		const report = scheduler.tick();
		await scheduler.settled();

		expect(report.decisions.map((d) => [d.agent, d.verb, d.why])).toEqual([
			[mabel, "start", "standing duty, no Turn yet"],
			[thorne, "start", "standing duty, no Turn yet"],
			[thorne, "skip", "TurnStarted refused: A-thorne is paused"],
		]);
		expect(scheduler.report().last).toBe(report);
		expect(
			[...s.ledger.projections.turns.turns.values()].map((t) => [
				t.started.agent,
				t.finished?.payload.outcome.tag,
			]),
		).toEqual([[mabel, "Completed"]]);
	});
});

describe("the plan", () => {
	it("over 80 percent of the Energy budget starts a Turn only for an Agent holding a rush Task", () => {
		const decide = (tokens: number) => {
			fresh();
			spent(s, thorne, tokens);
			assign(s.ledger, { actor: operator, task_id: task(s), assignee: rin });
			assign(s.ledger, {
				actor: operator,
				task_id: task(s, "Rush1to2Days"),
				assignee: ines,
			});
			const decisions = plan(
				s.ledger.projections,
				s.now(),
				{ ...OPTIONS, concurrency: 8 },
				new Map(),
			);
			return decisions;
		};

		const over = decide(810_000);
		expect(over.filter((d) => d.tag === "Start").map((d) => d.agent)).toEqual([
			ines,
		]);
		expect(over.filter((d) => d.tag === "Skip").map((d) => d.agent)).toEqual([
			mabel,
			rin,
		]);
		expect(over.find((d) => d.tag === "Skip")?.why).toContain(
			"the society used 810000 of 1000000 tokens in 5 hours, over 80 percent, and A-mabel holds no rush Task",
		);

		const under = decide(790_000);
		expect(
			under.filter((d) => d.tag === "Start").map((d) => d.agent),
			"under the line every Agent with work starts",
		).toEqual([ines, mabel, rin]);
	});

	it("wakes an Agent for a Message sent while its last Turn ran", () => {
		fresh();
		open(s.ledger, {
			id: lab,
			name: "Lab",
			purpose: "The whole lab",
			membership: { tag: "Everyone" },
			opened_by: operator,
		});
		const { turn } = startTurn(s.ledger, {
			agent: rin,
			model: "claude-sonnet-5-5",
			energyBudgetTokens: OPTIONS.energyBudgetTokens,
		});
		say(s.ledger, { actor: operator, room_id: lab, body: "Bench 2 is free." });
		finishTurn(s.ledger, {
			turn_id: turn.started.turn_id,
			usage: usage(10),
			outcome: { tag: "Completed" },
			tool_calls: 0,
		});

		const decisions = plan(
			s.ledger.projections,
			s.now(),
			{ ...OPTIONS, concurrency: 8 },
			new Map(),
		);

		expect(decisions).toContainEqual({
			tag: "Start",
			agent: rin,
			why: "1 new Message in its Rooms",
		});
	});

	it("wakes the target of an escalation once, as A-pia after A-ines escalated T-1 in the live run", () => {
		fresh();
		spent(s, mabel, 10);
		spent(s, thorne, 10);
		const t1 = task(s);
		assign(s.ledger, { actor: operator, task_id: t1, assignee: ines });
		const asInes = { tag: "Agent", id: ines } as const;
		const { turn } = startTurn(s.ledger, {
			agent: ines,
			model: "claude-sonnet-5-5",
			energyBudgetTokens: OPTIONS.energyBudgetTokens,
		});
		start(s.ledger, { actor: asInes, task_id: t1 });
		escalate(s.ledger, {
			actor: asInes,
			task_id: t1,
			to: { tag: "Agent", id: pia },
			reason: "The input is a .docx, outside my PDF Charter.",
		});
		finishTurn(s.ledger, {
			turn_id: turn.started.turn_id,
			usage: usage(10),
			outcome: { tag: "Completed" },
			tool_calls: 0,
		});
		const decide = () =>
			plan(
				s.ledger.projections,
				s.now(),
				{ ...OPTIONS, concurrency: 8 },
				new Map(),
			);

		expect(decide(), "the Tick after the escalation").toEqual([
			{ tag: "Start", agent: pia, why: "escalated T-1 from A-ines" },
		]);

		spent(s, pia, 10);

		expect(decide(), "the Tick after A-pia's Turn").toEqual([
			{ tag: "Idle", why: "no Agent has anything to do" },
		]);
	});

	it("is reproducible: the same Ledger gives the same assignee twice", () => {
		const assigneeOf = () => {
			fresh();
			const held = task(s);
			assign(s.ledger, { actor: operator, task_id: held, assignee: ines });
			const waiting = task(s);
			const proposedAt = new Map([[waiting, new Date(T0)]]);
			const now = new Date(Date.parse(T0) + OPTIONS.tickMs);
			const first = plan(s.ledger.projections, now, OPTIONS, proposedAt);
			const second = plan(s.ledger.projections, now, OPTIONS, proposedAt);
			expect(second, "planning twice on one Ledger").toEqual(first);
			const [decision] = first;
			return decision?.tag === "Assign" ? decision.agent : undefined;
		};

		const once = assigneeOf();
		const again = assigneeOf();

		expect(again).toBe(once);
		expect(once).toBe(
			expectedPick("T-2", [
				[bram, 100],
				[ines, 67],
				[rin, 100],
			]),
		);
	});

	it("reads a Task on stage 6's inputs as stage 6, though they cover stage 3's, and gives it to the Agent who works stage 6 (#59)", () => {
		fresh();
		const stored = (artifact_type: ArtifactType, i: number) =>
			store(
				s.ledger,
				{ actor: operator },
				{
					sha256: Sha256.parse(i.toString(16).padStart(64, "e")),
					media_type: "application/octet-stream",
					artifact_type,
					produced_by: operator,
					lineage: [],
				},
			).artifact.id;
		const report = propose(s.ledger, {
			actor: operator,
			title: "Stage 6 Report: Lot 2403A",
			goal: "Render the report",
			tat_class: "Regular",
			priority: 1,
			inputs: [
				stored("VerificationRecord", 1),
				stored("ReceivingLogRow", 2),
				stored("Other", 3),
				stored("LimsDatabase", 4),
			],
		}).task.id;

		const [decision] = plan(
			s.ledger.projections,
			new Date(Date.parse(T0) + OPTIONS.tickMs),
			OPTIONS,
			new Map([[report, new Date(T0)]]),
		);

		expect(decision).toEqual({
			tag: "Assign",
			task_id: report,
			agent: ines,
			why: `${report}: A-ines works stage 6 Report`,
		});
	});
});

const suite = dockerAvailable
	? "the Scheduler on seed 1's run (Docker)"
	: "the Scheduler on seed 1's run: SKIPPED because `docker info` failed; start Docker to run these";

describe.skipIf(!requireDocker())(suite, () => {
	// Each build gives its tag a new image id, so this process's tag is its own.
	const IMAGE = `aliquot-sandbox:scheduler-${process.pid}`;
	let image: Sha256;
	beforeAll(async () => {
		({ id: image } = await buildImage({ tag: IMAGE }));
	}, 600_000);
	afterAll(() => {
		spawnSync("docker", ["rmi", IMAGE], { stdio: "ignore" });
	});

	it("assigns each stage's Task of seed 1's run to the Agent who works the stage, and with that Agent paused to another active Agent of its role, naming the paused Agent", async () => {
		fresh();
		const { stages } = await runWorkflow({
			ledger: s.ledger,
			home,
			formPath: FIXTURE,
			plan: STAGES.map((stage) => {
				const script = ensureScript({
					ledger: s.ledger,
					home,
					stage,
					source: join(scriptsRoot, stage.script),
					image,
				});
				return { stage, script: { id: script.id, version: script.version } };
			}),
			timeoutMs: 60_000,
		});
		expect(
			stages.map((r) => [r.stage.number, r.state.tag]),
			"seed 1's run ends Done at every stage",
		).toEqual(STAGES.map((stage) => [stage.number, "Done"]));

		for (const { stage, task_id } of stages) {
			const ran = s.ledger.projections.tasks.tasks.get(task_id);
			if (ran === undefined) throw new Error(`${task_id} is not in the Ledger`);
			const again = propose(s.ledger, {
				actor: operator,
				title: ran.title,
				goal: ran.goal,
				tat_class: ran.tat_class,
				priority: ran.priority,
				inputs: ran.inputs,
			}).task.id;
			const decide = () =>
				plan(
					s.ledger.projections,
					new Date(s.now().getTime() + OPTIONS.tickMs),
					OPTIONS,
					new Map([[again, s.now()]]),
				).find((d) => "task_id" in d && d.task_id === again);
			const named = stage.worked_by;
			const works = `${named} works stage ${stage.number} ${stage.name}`;

			expect(decide(), `stage ${stage.number} with every Agent active`).toEqual(
				{
					tag: "Assign",
					task_id: again,
					agent: named,
					why: `${again}: ${works}`,
				},
			);

			pause(s.ledger, {
				actor: operator,
				agent_id: named,
				reason: "bench down",
			});
			const fallback = decide();
			const role = (agent: AgentId) =>
				s.ledger.projections.org.agents.get(agent)?.definition.role;
			expect(fallback?.tag, `stage ${stage.number} with ${named} paused`).toBe(
				"Assign",
			);
			if (fallback?.tag !== "Assign") throw new Error("not an assignment");
			expect(fallback.agent).not.toBe(named);
			expect(role(fallback.agent)).toBe(role(named));
			expect(fallback.why).toContain(
				`${again}: ${works}, but ${named} is paused; pick `,
			);
			resume(s.ledger, { actor: operator, agent_id: named });
		}
	}, 300_000);
});
