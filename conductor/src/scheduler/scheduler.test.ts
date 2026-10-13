import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId, RoomId, TaskId } from "../ids.js";
import { intake } from "../intake/command.js";
import { open, say } from "../room/lifecycle.js";
import { assign, complete, propose, start } from "../task/lifecycle.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import { finishTurn, startTurn } from "../turn/lifecycle.js";
import {
	type ModelRequest,
	type RunModel,
	type ScriptedModel,
	scriptedModel,
} from "../turn/model.js";
import type { TurnUsage } from "../types/turn.js";
import { orderRest, sample } from "../vitality/lifecycle.js";
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

/** Bram strained: 80,000 tokens six hours ago are fatigue 0.64 in a sample taken then. */
const strainBram = (s: Scenario) => {
	s.at(new Date(Date.parse(T0) - 6 * 3_600_000).toISOString());
	spent(s, bram, 80_000);
	const { vitality } = sample(s.ledger, {
		actor: operator,
		agent: bram,
		now: s.now(),
		energyBudgetTokens: OPTIONS.energyBudgetTokens,
	});
	expect(vitality.fatigue, "Bram is strained by fatigue").toBe(0.64);
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
	it("assigns the Director's proposal by the weighted pick, starts at most two Turns at once, skips a resting and a strained Agent, and records every Turn", async () => {
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
		const winner = expectedPick(proposed, [
			[ines, 100],
			[rin, 67],
		]);
		expect(assigned).toEqual({ tag: "Assigned", assignee: winner });
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
		expect(assignLine?.why).toContain(
			`over A-ines 100, A-rin 67; passed over: A-bram is strained and may not accept a Task`,
		);

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
			said.filter((d) => d.agent === mabel).map((d) => d.verb),
			"the resting Steward never starts",
		).toEqual(["skip", "skip", "skip", "skip"]);
		expect(said.find((d) => d.agent === mabel)?.why).toMatch(
			/^A-mabel is resting; standing duty/,
		);
		expect(starts.map((d) => d.agent)).not.toContain(mabel);
		expect(starts.map((d) => d.agent)).not.toContain(bram);

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

	it("tells a Specialist on Probation whom its completion names, so it completes its Task, and then gives the reviewer a Turn", async () => {
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

		s.at(later(20));
		const next = scheduler.tick();
		await scheduler.settled();

		expect(next.decisions).toContainEqual(
			expect.objectContaining({
				agent: "A-pia",
				verb: "start",
				why: `reviews ${held}`,
			}),
		);
		expect(prompts.get(id("A-pia"))).toContain(
			`## Tasks UnderReview that you review\n\n- ${held} Task 1`,
		);
	});

	it("finishes, late and as an Error, a Turn a stopped Conductor left open, before its first Tick", async () => {
		fresh();
		const { turn } = startTurn(s.ledger, {
			agent: rin,
			model: "claude-sonnet-5-5",
			energyBudgetTokens: OPTIONS.energyBudgetTokens,
		});
		s.at(later(60));
		const lines: string[] = [];
		const scheduler = openScheduler(s.ledger, {
			home,
			options: OPTIONS,
			maxTurns: 5,
			login: { tag: "Subscription" },
			modelFor: () =>
				scriptedModel({
					calls: [],
					usage_per_round: usage(1),
					stop: { tag: "Completed" },
				}),
			say: (line) => lines.push(line),
		});

		scheduler.start();
		await scheduler.stop();

		const [finished, sampled] = s
			.events()
			.filter((e) => e.seq > turn.seq)
			.slice(0, 2);
		expect(finished).toMatchObject({
			kind: "TurnFinished",
			actor: { tag: "Conductor" },
			causation_id: turn.seq,
			payload: {
				turn_id: turn.started.turn_id,
				outcome: {
					tag: "Error",
					message: `the Conductor stopped during ${turn.started.turn_id}; recorded late, at ${later(60)} when the Scheduler started, with its usage and Tool calls unknown`,
				},
			},
		});
		expect(sampled).toMatchObject({
			kind: "VitalitySampled",
			causation_id: finished?.seq,
		});
		expect(lines[0]).toBe(
			`scheduler ${later(60)} A-rin finished ${turn.started.turn_id} late: the Conductor stopped during it`,
		);
		expect(s.ledger.projections.turns.open.size).toBe(0);
	});

	it("finishes a left-open Turn of an Agent retired since, without a sample, and keeps ticking", async () => {
		fresh();
		const { turn } = startTurn(s.ledger, {
			agent: rin,
			model: "claude-sonnet-5-5",
			energyBudgetTokens: OPTIONS.energyBudgetTokens,
		});
		s.retire(rin, "Replaced");
		const lines: string[] = [];
		const scheduler = openScheduler(s.ledger, {
			home,
			options: OPTIONS,
			maxTurns: 5,
			login: { tag: "Subscription" },
			modelFor: () =>
				scriptedModel({
					calls: [],
					usage_per_round: usage(1),
					stop: { tag: "Completed" },
				}),
			say: (line) => lines.push(line),
		});

		scheduler.start();
		await scheduler.stop();

		expect(
			s.ledger.projections.turns.turns.get(turn.started.turn_id)?.finished
				?.payload.outcome.tag,
		).toBe("Error");
		expect(
			s
				.events()
				.filter((e) => e.kind === "VitalitySampled" && e.payload.agent === rin),
			"a retired Agent takes no sample",
		).toEqual([]);
		expect(lines[0]).toMatch(/ A-rin finished TN-1 late: /);
		expect(scheduler.report().last, "the first Tick ran").not.toBeNull();
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
			"the society used 810000 of 1000000 tokens in 5 hours, over 80 percent, and A-mabel holds or reviews no rush Task",
		);

		const under = decide(790_000);
		expect(
			under.filter((d) => d.tag === "Start").map((d) => d.agent),
			"under the line every Agent with work starts",
		).toEqual([ines, mabel, rin]);
	});

	it("over 80 percent still starts the reviewer of a rush Task UnderReview", () => {
		fresh();
		spent(s, thorne, 810_000);
		const rush = task(s, "Rush1to2Days");
		assign(s.ledger, { actor: operator, task_id: rush, assignee: rin });
		start(s.ledger, { actor: { tag: "Agent", id: rin }, task_id: rush });
		complete(s.ledger, {
			actor: { tag: "Agent", id: rin },
			task_id: rush,
			reviewer: { tag: "Agent", id: pia },
		});

		const decisions = plan(s.ledger.projections, s.now(), OPTIONS, new Map());

		expect(decisions).toContainEqual({
			tag: "Start",
			agent: pia,
			why: `reviews ${rush}; rush ${rush}`,
		});
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
});
