import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentId, type ArtifactId, RoomId, Sha256 } from "../ids.js";
import { open, say } from "../room/lifecycle.js";
import { store } from "../sandbox/lifecycle.js";
import { assign, escalate, propose } from "../task/lifecycle.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import { messageArtifactId } from "../tools/message.js";
import { giveCoaching } from "../training/lifecycle.js";
import type { Actor } from "../types/actor.js";
import type { ArtifactType } from "../types/artifact.js";
import { finishTurn, startTurn } from "./lifecycle.js";
import { NO_USAGE } from "./model.js";
import { turnPrompt } from "./prompt.js";

const rin = AgentId.parse("A-rin");
const odile = AgentId.parse("A-odile");
const bram = AgentId.parse("A-bram");
const ines = AgentId.parse("A-ines");
const operator: Actor = { tag: "Operator" };
const lab = RoomId.parse("RM-lab");

let s: Scenario;
beforeEach(() => {
	s = scenario();
	open(s.ledger, {
		id: lab,
		name: "Lab",
		purpose: "The whole lab",
		membership: { tag: "Everyone" },
		opened_by: operator,
	});
});
afterEach(() => s.close());

const start = (agent: AgentId) =>
	startTurn(s.ledger, {
		agent,
		model: "claude-sonnet-5-5",
		energyBudgetTokens: 1_000_000,
	}).turn;

const promptOf = (agent: AgentId) => {
	const { standing, work } = turnPrompt(
		s.ledger.projections,
		start(agent),
		s.now(),
	);
	return `${standing}\n\n${work}`;
};

const count = (text: string, part: string) => text.split(part).length - 1;

describe("the prompt of a Turn", () => {
	it("renders a seeded Agent's Task, Message and Coaching once each, in that order, after its Charter", () => {
		const task_id = s.task(rin);
		say(s.ledger, {
			actor: operator,
			room_id: lab,
			body: "The balance on bench 2 is calibrated.",
		});
		giveCoaching(s.ledger, {
			actor: operator,
			agent_id: rin,
			note: "Name the Lot in every Message.",
		});

		const prompt = promptOf(rin);

		const parts = [
			"You are Rin (A-rin), the Specialist",
			"## Charter",
			`${task_id} Task 1: Do the work`,
			"RM-lab, Operator: The balance on bench 2 is calibrated.",
			"Name the Lot in every Message.",
		];
		for (const part of parts) {
			expect(count(prompt, part), `${part} appears once`).toBe(1);
		}
		const at = parts.map((part) => prompt.indexOf(part));
		expect(at, "each part follows the one before").toEqual(
			[...at].sort((a, b) => a - b),
		);
	});

	it("shows only the Messages and Coaching recorded since the Agent's previous Turn started", () => {
		say(s.ledger, { actor: operator, room_id: lab, body: "First word." });
		giveCoaching(s.ledger, { actor: operator, agent_id: rin, note: "Old." });
		const first = start(rin);
		finishTurn(s.ledger, {
			turn_id: first.started.turn_id,
			usage: NO_USAGE,
			outcome: { tag: "Completed" },
			tool_calls: 0,
		});
		say(s.ledger, { actor: operator, room_id: lab, body: "Second word." });
		giveCoaching(s.ledger, { actor: operator, agent_id: rin, note: "New." });

		const prompt = promptOf(rin);

		expect(prompt).toContain("RM-lab, Operator: Second word.");
		expect(prompt).toContain("- New.");
		expect(prompt).not.toContain("First word.");
		expect(prompt).not.toContain("- Old.");
	});

	it("shows a Task escalated to the Agent, who escalated it and why, until the Agent's next Turn", () => {
		const ines = AgentId.parse("A-ines");
		const pia = AgentId.parse("A-pia");
		const task_id = s.task(ines);
		escalate(s.ledger, {
			actor: { tag: "Agent", id: ines },
			task_id,
			to: { tag: "Agent", id: pia },
			reason: "The input is a .docx, outside my PDF Charter.",
		});
		const heading = "## Tasks escalated to you since your last Turn\n\n";

		const turn = start(pia);
		const first = turnPrompt(s.ledger.projections, turn, s.now()).work;

		expect(first).toContain(
			`${heading}An escalated Task stays Escalated. To take one on, propose a new Task with the same inputs with propose_task and assign it with assign_task, or say why not in a Room with send_message.\n\n- ${task_id} Task 1: Do the work\n  Inputs: none. Priority 1, TAT Regular.\n  Escalated by A-ines: The input is a .docx, outside my PDF Charter.`,
		);
		expect(promptOf(rin), "another Agent's prompt").toContain(
			`${heading}None.`,
		);

		finishTurn(s.ledger, {
			turn_id: turn.started.turn_id,
			usage: NO_USAGE,
			outcome: { tag: "Completed" },
			tool_calls: 0,
		});
		const second = promptOf(pia);

		expect(second).toContain(`${heading}None.`);
		expect(second).not.toContain("Escalated by A-ines");
	});

	it("carries no Mood or Policy line, even for a resting Agent with a Task InProgress", () => {
		s.task(rin);
		s.ledger.append({
			actor: { tag: "Agent", id: AgentId.parse("A-mabel") },
			kind: "RestOrdered",
			payload: { agent_id: rin, action: "begin", reason: "Long week" },
		});

		const prompt = promptOf(rin);

		expect(prompt).toContain("## Persona");
		expect(prompt).toContain("## Skills");
		expect(prompt.split("\n").filter((l) => /Mood|Policy/.test(l))).toEqual([]);
	});

	it("lists for the Director the Submission Forms no Task has been proposed for, and its refused Tools", () => {
		const { artifact } = store(
			s.ledger,
			{ actor: operator },
			{
				sha256: Sha256.parse("c".repeat(64)),
				media_type: "application/octet-stream",
				artifact_type: "SubmissionForm",
				produced_by: operator,
				lineage: [],
			},
		);

		const director = promptOf(odile);
		const specialist = promptOf(rin);

		expect(director).toContain(
			`## Submission Forms no Task has been proposed for\n\n- ${artifact.id}`,
		);
		expect(director).toContain(
			"run_script: refused, your Charter forbids RunScript",
		);
		expect(specialist).not.toContain("Submission Forms no Task");
		expect(specialist).not.toContain(artifact.id);
	});

	it("gives the Director the Operator's Messages in RM-lab with their Artifact ids as receiving work, and names the Message in its Task's line", () => {
		const report = say(s.ledger, {
			actor: operator,
			room_id: lab,
			body: "Received 3 bottles, Lot 2403A, Product Code VC500",
		});
		say(s.ledger, {
			actor: { tag: "Agent", id: rin },
			room_id: lab,
			body: "Rin's word",
		});
		const id = messageArtifactId(report);

		const director = promptOf(odile);

		const section = director.slice(
			director.indexOf("## The Operator's Messages in RM-lab"),
		);
		expect(section).toContain(
			"A Message in RM-lab that reports received Samples is work.",
		);
		expect(section).toContain("Then assign it to A-bram, who works stage 2.");
		expect(
			section,
			"the values the Report of Analysis needs, by the labels parse_message reads",
		).toContain(
			'the Product Type after "Product Type", and the Report To party after "Report to" with its company, Contact, Address and City, propose',
		);
		expect(section).toContain("naming each of those values it lacks");
		expect(
			section,
			"the goal names every Script id, which the Specialist has no Tool to look up",
		).toMatch(/S-parse_message.*S-log_receipt.*S-create_work_order/);
		expect(section).toContain(
			`- seq ${report.seq}, Artifact ${id}: Received 3 bottles, Lot 2403A, Product Code VC500`,
		);
		expect(section, "an Agent's Message is no receiving work").not.toContain(
			"Rin's word",
		);

		const { task } = propose(s.ledger, {
			actor: { tag: "Agent", id: odile },
			title: "Receive Lot 2403A",
			goal: "Log it",
			tat_class: "Regular",
			priority: 1,
			inputs: [id],
		});
		assign(s.ledger, { actor: operator, task_id: task.id, assignee: bram });

		expect(promptOf(bram)).toContain(
			`Inputs: ${id} (the Operator's Message seq ${report.seq} in RM-lab, not stored yet: store it with store_message).`,
		);
	});

	it("gives the Director a results Message as stage 4's work, naming every Script id of stages 4 to 6 and what an unreadable one lacks", () => {
		const results = say(s.ledger, {
			actor: operator,
			room_id: lab,
			body: "Lab Ref 26-0412, notebook NB-07 p.31. Container 1: 10.246 g for 20 capsules, 10.246 g taken.",
		});

		const director = promptOf(odile);

		const section = director.slice(
			director.indexOf("## The Operator's Messages in RM-lab"),
		);
		expect(section).toContain(
			"A Message in RM-lab that reports results is work too.",
		);
		expect(
			section,
			"the goals name every Script id, which no Specialist has a Tool to look up",
		).toMatch(
			/S-parse_results_message.*S-compute_results \(stage 4 Results\).*S-verify_results \(stage 5 Verification\).*S-render_roa \(stage 6 Report\)/,
		);
		expect(section).toContain(
			'titled "Stage 5 Verification: <the Work Order>" whose inputs are the Result Worksheet and the weighings',
		);
		expect(section).toContain("and assign it to A-bram, who works stage 5");
		expect(section).toContain("and assign it to A-ines, who works stage 6");
		expect(section).toContain("Then assign it to A-rin, who works stage 4.");
		expect(section).toContain(
			"asking for the Lab Reference, the notebook reference and the weighings it lacks, and propose no Task.",
		);
		expect(section).toContain(
			`- seq ${results.seq}, Artifact ${messageArtifactId(results)}: Lab Ref 26-0412`,
		);
	});

	it("tells the holder of a stage 6 Task to request the ExternalMessage Gate and answer the results Message its inputs came from, naming the stage's reviewer", () => {
		const receipt = say(s.ledger, {
			actor: operator,
			room_id: lab,
			body: "Received 3 bottles, Lot 2403A, Product Code VC500",
		});
		const results = say(s.ledger, {
			actor: operator,
			room_id: lab,
			body: "Lab Ref 26-0412, notebook NB-07 p.31.",
		});
		const stored = (
			artifact_type: ArtifactType,
			sha256: string,
			lineage: ArtifactId[] = [],
		) =>
			store(
				s.ledger,
				{ actor: operator },
				{
					sha256: Sha256.parse(sha256),
					media_type: "application/octet-stream",
					artifact_type,
					produced_by: operator,
					lineage,
				},
			).artifact.id;
		const n = (i: number) => i.toString(16).padStart(64, "0");
		const received = stored("Other", messageArtifactId(receipt));
		const message = stored("Other", messageArtifactId(results));
		const report = [
			stored("VerificationRecord", n(2)),
			stored("ReceivingLogRow", n(3), [received]),
			stored("Other", n(1), [message]),
			stored("LimsDatabase", n(4), [received]),
		];
		const receiving = [
			stored("ReceivingLogRow", n(5)),
			stored("LimsDatabase", n(6)),
		];
		for (const inputs of [report, receiving]) {
			const { task } = propose(s.ledger, {
				actor: operator,
				title: "Stage work",
				goal: "Work it",
				tat_class: "Regular",
				priority: 1,
				inputs,
			});
			assign(s.ledger, { actor: operator, task_id: task.id, assignee: ines });
		}

		const [, t1, t2] = promptOf(ines)
			.split(/\n- (?=T-\d)/)
			.map((part) => part.split("\n\n")[0]);

		expect(t1).toContain(
			`After run S-render_roa (stage 6 Report), request an ExternalMessage Gate with request_gate, naming no Task, whose payload is {"artifact_id": <the PDF Report of Analysis>, "lab_reference": <its Lab Reference>}; then reply to the Operator's Message seq ${results.seq} in RM-lab with send_message, naming the Gate id and the two Report of Analysis Artifact ids.`,
		);
		expect(t1, "stage 6's reviewer").toContain(
			"complete it with complete_task naming a reviewer, such as A-anselm.",
		);
		expect(t2, "a stage 3 Task asks for no Gate").not.toContain("Gate");
		expect(t2, "stage 3's reviewer").toContain("such as A-pia.");
	});
});
