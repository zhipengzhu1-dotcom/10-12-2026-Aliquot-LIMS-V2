import { AppendRefused } from "../append-guard.js";
import type { AgentId, TaskId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import { liveAgent } from "../org/projection.js";
import { Refusal } from "../reduce.js";
import { assign } from "../task/lifecycle.js";
import type { Login } from "../turn/auth.js";
import { finishTurn, sampleAfterTurn } from "../turn/lifecycle.js";
import { NO_USAGE, type RunModel } from "../turn/model.js";
import { countedTokens } from "../turn/projection.js";
import { runTurn } from "../turn/run.js";
import { type Decision, plan, type SchedulerOptions } from "./plan.js";

/** What a line of the Scheduler says an Agent, or nobody, does. */
export type Verb =
	| "assign"
	| "start"
	| "skip"
	| "idle"
	| "refused"
	| "finished"
	| "failed";

/** One line the Scheduler prints: `scheduler <at> <agent or nobody> <verb> <why>`. */
export type Said = {
	readonly at: string;
	readonly agent: AgentId | "nobody";
	readonly verb: Verb;
	readonly why: string;
};

export const lineOf = ({ at, agent, verb, why }: Said): string =>
	`scheduler ${at} ${agent} ${verb} ${why}`;

/** One Tick: when it ran, and what it decided and met applying it. */
export type TickReport = {
	readonly at: string;
	readonly decisions: readonly Said[];
};

/** What `GET /api/scheduler` serves. */
export type SchedulerReport = {
	readonly options: SchedulerOptions;
	readonly last: TickReport | null;
};

export type Scheduler = {
	/** Plan one Tick from the Ledger and apply it. Its Turns run on after it returns. */
	tick(): TickReport;
	report(): SchedulerReport;
	/** Close the Turns a stopped Conductor left open, then Tick now and every `tickMs`. */
	start(): void;
	/** Stop ticking and wait for the Turns still open. */
	stop(): Promise<void>;
	/** Settles when every Turn started so far has finished. */
	settled(): Promise<void>;
};

export type SchedulerSetup = {
	readonly home: string;
	readonly options: SchedulerOptions;
	readonly maxTurns: number;
	readonly login: Login;
	/** The model an Agent's Turn runs on. */
	readonly modelFor: (agent: AgentId) => RunModel;
	/** Where each line goes, without its newline. */
	readonly say: (line: string) => void;
};

const CONDUCTOR = { tag: "Conductor" } as const;

const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/**
 * The Scheduler inside `aliquot serve`: each Tick plans from the Ledger with
 * `plan` and applies the decisions through the Task lifecycle and `runTurn`,
 * as the Conductor. A refusal is a line, never a crash.
 */
export const openScheduler = (
	ledger: Ledger,
	setup: SchedulerSetup,
): Scheduler => {
	const { options } = setup;
	const open = new Set<Promise<void>>();
	let last: TickReport | null = null;
	let timer: NodeJS.Timeout | undefined;

	const said = (
		agent: AgentId | "nobody",
		verb: Verb,
		why: string,
		into?: Said[],
	) => {
		const line: Said = { at: ledger.now().toISOString(), agent, verb, why };
		into?.push(line);
		setup.say(lineOf(line));
	};

	/** When each Task still Proposed was proposed: the time of its TaskProposed. */
	const proposedAt = (): ReadonlyMap<TaskId, Date> => {
		const { tasks, lastSeq } = ledger.projections.tasks;
		const waiting = new Set(
			[...tasks.values()]
				.filter((t) => t.state.tag === "Proposed")
				.map((t) => lastSeq.get(t.id)),
		);
		const at = new Map<TaskId, Date>();
		if (waiting.size === 0) return at;
		for (const event of ledger.events()) {
			if (event.kind === "TaskProposed" && waiting.has(event.seq)) {
				at.set(event.payload.task_id, new Date(event.ts));
			}
		}
		return at;
	};

	const startTurnOf = (agent: AgentId) => {
		const running = runTurn(ledger, {
			home: setup.home,
			agent,
			maxTurns: setup.maxTurns,
			maxBudgetUsd: undefined,
			energyBudgetTokens: options.energyBudgetTokens,
			login: setup.login,
			runModel: setup.modelFor(agent),
		})
			.then(({ turn, mood }) => {
				const finished = turn.finished?.payload;
				if (finished === undefined) return;
				const { outcome, usage, tool_calls } = finished;
				said(
					agent,
					"finished",
					`${turn.started.turn_id} ${outcome.tag === "Error" ? `Error: ${outcome.message}` : outcome.tag}: ${tool_calls} Tool call${tool_calls === 1 ? "" : "s"}, ${countedTokens(usage)} tokens; Mood ${mood}`,
				);
			})
			.catch((error: unknown) =>
				said(
					agent,
					error instanceof AppendRefused ? "refused" : "failed",
					messageOf(error),
				),
			)
			.finally(() => open.delete(running));
		open.add(running);
	};

	const apply = (decision: Decision, into: Said[]) => {
		switch (decision.tag) {
			case "Assign": {
				said(decision.agent, "assign", decision.why, into);
				try {
					assign(ledger, {
						actor: CONDUCTOR,
						task_id: decision.task_id,
						assignee: decision.agent,
					});
				} catch (error) {
					if (!(error instanceof AppendRefused)) throw error;
					said(decision.agent, "refused", error.message, into);
				}
				return;
			}
			case "NoAssignee":
				return said("nobody", "assign", decision.why, into);
			case "Start":
				said(decision.agent, "start", decision.why, into);
				return startTurnOf(decision.agent);
			case "Skip":
				return said(decision.agent, "skip", decision.why, into);
			case "Idle":
				return said("nobody", "idle", decision.why, into);
		}
	};

	const tick = (): TickReport => {
		const now = ledger.now();
		const decisions: Said[] = [];
		for (const decision of plan(
			ledger.projections,
			now,
			options,
			proposedAt(),
		)) {
			apply(decision, decisions);
		}
		last = { at: now.toISOString(), decisions };
		return last;
	};

	/** A Turn open in the Ledger while no Turn runs was left by a Conductor that stopped during it. */
	const closeLeftOpen = () => {
		for (const [agent, turn_id] of [...ledger.projections.turns.open]) {
			try {
				const finished = finishTurn(ledger, {
					turn_id,
					usage: NO_USAGE,
					outcome: {
						tag: "Error",
						message: `the Conductor stopped during ${turn_id}; recorded late, at ${ledger.now().toISOString()} when the Scheduler started, with its usage and Tool calls unknown`,
					},
					tool_calls: 0,
				});
				// A retired Agent takes no sample; its Turn still finishes.
				if (!(liveAgent(ledger.projections.org, agent) instanceof Refusal)) {
					sampleAfterTurn(ledger, {
						agent,
						finished: finished.seq,
						now: ledger.now(),
						energyBudgetTokens: options.energyBudgetTokens,
					});
				}
				said(
					agent,
					"finished",
					`${turn_id} late: the Conductor stopped during it`,
				);
			} catch (error) {
				said(agent, "failed", messageOf(error));
			}
		}
	};

	const safeTick = () => {
		try {
			tick();
		} catch (error) {
			said("nobody", "failed", messageOf(error));
		}
	};

	const settled = async () => {
		while (open.size > 0) await Promise.all(open);
	};

	return {
		tick,
		report: () => ({ options, last }),
		start: () => {
			closeLeftOpen();
			safeTick();
			timer = setInterval(safeTick, options.tickMs);
		},
		stop: async () => {
			clearInterval(timer);
			await settled();
		},
		settled,
	};
};
