import { requestGate } from "../gate/lifecycle.js";
import { type ArtifactId, ScriptId, type Seq, type TaskId } from "../ids.js";
import type { Ledger } from "../ledger.js";
import type { Projections } from "../projections.js";
import { say } from "../room/lifecycle.js";
import type { Message } from "../room/projection.js";
import { LAB_ROOM } from "../room/seed.js";
import { openArtifacts } from "../sandbox/artifacts.js";
import { assign, complete, fail, propose, start } from "../task/lifecycle.js";
import { LIVE_TAGS } from "../task/projection.js";
import {
	PARSE_MESSAGE,
	PARSE_RESULTS_MESSAGE,
	storeOperatorMessage,
} from "../tools/message.js";
import { runArtifacts, runScriptBy } from "../tools/run-script.js";
import type { ArtifactType } from "../types/artifact.js";
import type { Run } from "../types/script.js";
import { reviewerOf } from "../vitality/reviewers.js";
import { STAGES, type Stage, type StageArtifact } from "../workflow/stages.js";

/**
 * How long the Operator waits for the reply to a receipt or results, from
 * their MessageSent to the Conductor's, when the serve runs the Chain in its
 * warm Sandbox (ADR-0020).
 */
export const REPLY_BOUND_MS = 1_000;

const CONDUCTOR = { tag: "Conductor" } as const;

/** The two Chains an Operator's Message can start. */
export type ChainKind = "Receipt" | "Results";

/**
 * The Chain a Message's words mark it for, or none: results name a notebook,
 * a numbered container or results; a receipt says what was received. The
 * parse Script reads the values; these words only route the Message.
 */
export const chainKindOf = (body: string): ChainKind | undefined => {
	if (/\bnotebook\b|\bcontainer\s+\d+\s*:|\bresults?\b/i.test(body)) {
		return "Results";
	}
	if (/\breceived\b/i.test(body)) return "Receipt";
	return undefined;
};

/** One stage a Chain ran: its Run and the Artifacts it wrote. */
type Ran = {
	readonly stage: Stage;
	readonly run: Run;
	readonly outputs: readonly StageArtifact[];
};

/** What a Chain's reply reads once its Task completes. */
type Finished = {
	readonly ledger: Ledger;
	readonly completed: Seq;
	readonly ran: readonly Ran[];
};

/** One Chain: the Script that parses the Message, the stages it runs, and how it answers. */
type Chain = {
	readonly parser: string;
	/** The types the parser reads beside the Message, each the latest accepted. */
	readonly given: readonly ArtifactType[];
	readonly stages: readonly number[];
	readonly title: string;
	/** How a reply that names why nothing was done opens. */
	readonly refused: string;
	/** What follows the Task's completion, and the reply's text. */
	readonly finish: (done: Finished) => string;
};

const named = (ran: readonly Ran[], filename: string): StageArtifact => {
	const found = ran
		.flatMap((r) => r.outputs)
		.filter((o) => o.filename === filename)
		.at(-1);
	if (found === undefined) throw new Error(`no stage wrote ${filename}`);
	return found;
};

const jsonOf = (artifact: StageArtifact): unknown =>
	JSON.parse(artifact.bytes.toString("utf8"));

const CHAINS: Readonly<Record<ChainKind, Chain>> = {
	Receipt: {
		parser: PARSE_MESSAGE,
		given: [],
		stages: [2, 3],
		title: "Receive the Samples the Operator reported",
		refused: "I cannot receive these yet",
		finish: ({ ran }) => {
			const { rows } = jsonOf(named(ran, "receipt.json")) as {
				rows: string[][];
			};
			const { header } = jsonOf(named(ran, "work_order.json")) as {
				header: Record<string, string>;
			};
			return `Logged ${rows.map((row) => row[0]).join(", ")} on ${header["Work Order"]}, due ${header["Due Date"]}.`;
		},
	},
	Results: {
		parser: PARSE_RESULTS_MESSAGE,
		given: ["WorkOrder"],
		stages: [4, 5, 6],
		title: "Record the results the Operator reported",
		refused: "I cannot record these results yet",
		finish: ({ ledger, ran, completed }) => {
			const pdf = named(ran, "report_of_analysis.pdf").id;
			const xlsx = named(ran, "report_of_analysis.xlsx").id;
			const { sheet } = jsonOf(named(ran, "report_of_analysis.json")) as {
				sheet: unknown[][];
			};
			const lab_reference = String(
				sheet.find((row) => row[0] === "Lab Reference")?.[1] ?? "",
			);
			const { gate } = requestGate(ledger, {
				actor: CONDUCTOR,
				kind: "ExternalMessage",
				payload: { artifact_id: pdf, lab_reference },
				causation_id: completed,
			});
			return `The Report of Analysis of ${lab_reference} waits on ${gate.id}: PDF ${pdf}, xlsx ${xlsx}.`;
		},
	},
};

/**
 * The latest Artifact of `type` that a Run wrote whose stage Evaluation
 * passed: what a Chain carries from earlier work, such as the toy LIMS
 * database or the Work Order a results Message is about.
 */
const latestAccepted = (
	projections: Projections,
	type: ArtifactType,
): ArtifactId | undefined => {
	const passed = new Set(
		[...projections.work.evaluations.values()]
			.filter((e) => e.passed)
			.map((e) => e.run_id),
	);
	let latest: { id: ArtifactId; seq: Seq } | undefined;
	for (const productions of projections.artifacts.productions.values()) {
		for (const { seq, record } of productions) {
			if (
				record.artifact_type === type &&
				record.produced_by.tag === "Run" &&
				passed.has(record.produced_by.id) &&
				(latest === undefined || seq > latest.seq)
			) {
				latest = { id: record.id, seq };
			}
		}
	}
	return latest?.id;
};

/** Why a Chain stopped, in words the reply gives the Operator. */
class Stopped extends Error {}

export type Chains = {
	/**
	 * Take `message` when it is the Operator's in the Lab Room and its words
	 * mark it for a Chain: store it as the Conductor at once, so no Agent gets
	 * a Turn for it, and run its Chain after every Chain taken before it.
	 * Returns whether it took the Message.
	 */
	take(message: Message): boolean;
	/** Resolves once every Chain taken so far has replied. */
	settled(): Promise<void>;
};

/**
 * The Conductor's Chains (ADR-0021): it runs the Chain an Operator's Message
 * starts, with no Turn and no model, and replies in the Room. Each of its
 * Events names its cause, back to the Message. Chains run one at a time,
 * since each reads the toy LIMS database the one before wrote.
 */
export const openChains = ({
	ledger,
	home,
	timeoutMs = 60_000,
	report = () => {},
}: {
	readonly ledger: Ledger;
	readonly home: string;
	readonly timeoutMs?: number;
	/** Where each Chain's outcome and time are written, one line each. */
	readonly report?: (line: string) => void;
}): Chains => {
	const ctx = { ledger, home, stages: STAGES, timeoutMs, actor: CONDUCTOR };
	let tail: Promise<void> = Promise.resolve();

	const stageOf = (n: number): Stage => {
		const stage = STAGES.find((s) => s.number === n);
		if (stage === undefined) throw new Error(`the stage table has no ${n}`);
		return stage;
	};

	/** A refused parse's reason: the last line of its stderr, without the Script's name. */
	const refusalOf = (run: Run): string =>
		openArtifacts({ ledger, home })
			.read(run.stderr_ref)
			.toString("utf8")
			.trim()
			.split("\n")
			.at(-1)
			?.replace(/^\w+ refused its inputs?: /, "") ?? "";

	const finishedSeq = (run: Run): Seq => {
		const seq = ledger.projections.runs.runs.get(run.id)?.finished?.seq;
		if (seq === undefined) throw new Error(`${run.id} has not finished`);
		return seq;
	};

	/** The Chain's Task on the parsed Message, worked stage by stage, and the reply. */
	const work = async (
		chain: Chain,
		message: ArtifactId,
		given: readonly ArtifactId[],
		parsed: Run,
	): Promise<{ task_id: TaskId; reply: string }> => {
		const parsedOutputs = runArtifacts(ledger, home, parsed).outputs;
		const stages = chain.stages.map(stageOf);
		const [first] = stages;
		if (first === undefined) throw new Error("a Chain runs a stage");
		const { task } = propose(ledger, {
			actor: CONDUCTOR,
			causation_id: finishedSeq(parsed),
			title: chain.title,
			goal: `Run stages ${chain.stages.join(", ")} on the Operator's Message and pass each Evaluation`,
			tat_class: "Regular",
			priority: 1,
			inputs: [message, ...given, ...parsedOutputs.map((o) => o.id)],
		});
		const task_id = task.id;
		try {
			assign(ledger, { actor: CONDUCTOR, task_id, assignee: first.worked_by });
			start(ledger, { actor: CONDUCTOR, task_id });
			const ran: Ran[] = [];
			// What the Chain has in hand, oldest first: the given Artifacts, the
			// parse's outputs, then each stage's. A stage takes each type from
			// the latest of them, else from earlier accepted work; `Other` is
			// always the weighings the parse wrote, as in the workflow tracer.
			const pool: { id: ArtifactId; type: ArtifactType }[] = [
				...given.flatMap((id) => {
					const type =
						ledger.projections.artifacts.artifacts.get(id)?.artifact_type;
					return type === undefined ? [] : [{ id, type }];
				}),
				...parsedOutputs.map((o) => ({ id: o.id, type: o.artifact_type })),
			];
			const weighings = parsedOutputs.find((o) => o.artifact_type === "Other");
			const pick = (type: ArtifactType): ArtifactId | undefined =>
				type === "Other"
					? weighings?.id
					: (pool.filter((a) => a.type === type).at(-1)?.id ??
						latestAccepted(ledger.projections, type));
			let last: Seq | undefined;
			for (const stage of stages) {
				const inputs = stage.inputs.map((type) => {
					const id = pick(type);
					if (id === undefined) {
						throw new Stopped(
							`stage ${stage.number} ${stage.name} takes a ${type}, and the Ledger holds none`,
						);
					}
					return id;
				});
				const carried = stage.carried.flatMap((type) => pick(type) ?? []);
				const { run, evaluation, seq } = await runScriptBy(ctx, {
					script: ScriptId.parse(`S-${stage.script}`),
					inputs: [...inputs, ...carried],
					task_id,
				});
				if (evaluation === undefined || seq === undefined) {
					throw new Error(`${run.id} recorded no Evaluation`);
				}
				last = seq;
				if (!evaluation.passed) {
					throw new Stopped(
						`stage ${stage.number} ${stage.name} failed its Evaluation ${evaluation.eval_id}: ${evaluation.findings.join("; ")}`,
					);
				}
				const { outputs } = runArtifacts(ledger, home, run);
				ran.push({ stage, run, outputs });
				pool.push(...outputs.map((o) => ({ id: o.id, type: o.artifact_type })));
			}
			const completed = complete(ledger, {
				actor: CONDUCTOR,
				task_id,
				outputs: ran.flatMap((r) =>
					r.outputs
						.filter((o) => r.stage.outputs.includes(o.artifact_type))
						.map((o) => o.id),
				),
				reviewer: reviewerOf(ledger.projections, first.worked_by),
				causation_id: last,
			});
			return {
				task_id,
				reply: chain.finish({ ledger, completed: completed.seq, ran }),
			};
		} catch (error) {
			const state = ledger.projections.tasks.tasks.get(task_id)?.state.tag;
			if ((LIVE_TAGS as readonly string[]).includes(state ?? "")) {
				fail(ledger, {
					actor: CONDUCTOR,
					task_id,
					reason: `the Conductor's Chain stopped: ${(error as Error).message}`,
				});
			}
			throw error instanceof Stopped
				? new Stopped(`${task_id} stopped: ${error.message}`)
				: error;
		}
	};

	/** The reply's text, after running the Chain, or why it did nothing. */
	const replyOf = async (
		chain: Chain,
		message: Message,
		stored: ArtifactId,
		taken: Seq,
	): Promise<string> => {
		const given: ArtifactId[] = [];
		for (const type of chain.given) {
			const id = latestAccepted(ledger.projections, type);
			if (id === undefined) {
				return `${chain.refused}: the Ledger holds no ${type}.`;
			}
			given.push(id);
		}
		const { run: parsed } = await runScriptBy(
			{ ...ctx, causation_id: taken },
			{
				script: ScriptId.parse(`S-${chain.parser}`),
				inputs: [stored, ...given],
			},
		);
		if (parsed.exit_code !== 0) {
			return `${chain.refused}: ${refusalOf(parsed)}.`;
		}
		const { task_id, reply } = await work(chain, stored, given, parsed);
		report(`Chain: seq ${message.seq} ran ${task_id}`);
		return reply;
	};

	const run = async (
		chain: Chain,
		message: Message,
		stored: ArtifactId,
		taken: Seq,
	) => {
		const started = performance.now();
		let body: string;
		try {
			body = await replyOf(chain, message, stored, taken);
		} catch (error) {
			const why = (error as Error).message;
			body =
				error instanceof Stopped
					? `Stopped: ${why}.`
					: `${chain.refused}: the Conductor stopped: ${why}.`;
		}
		const reply = say(ledger, {
			actor: CONDUCTOR,
			room_id: message.room_id,
			body,
			reply_to: message.seq,
		});
		report(
			`Chain: replied to seq ${message.seq} at seq ${reply.seq} after ${Math.round(performance.now() - started)} ms: ${body}`,
		);
	};

	return {
		take: (message) => {
			const kind = chainKindOf(message.body);
			if (
				kind === undefined ||
				message.actor.tag !== "Operator" ||
				message.room_id !== LAB_ROOM.id
			) {
				return false;
			}
			const { artifact, seq } = storeOperatorMessage(
				{ ledger, home },
				CONDUCTOR,
				message,
			);
			const chain = CHAINS[kind];
			tail = tail
				.then(() => run(chain, message, artifact.id, seq))
				.catch((error: unknown) =>
					report(`Chain: seq ${message.seq} got no reply: ${String(error)}`),
				);
			return true;
		},
		settled: () => tail,
	};
};
