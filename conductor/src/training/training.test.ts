import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendRefused } from "../append-guard.js";
import { AgentId, type Seq, SkillId, TaskId } from "../ids.js";
import { recruit, revise } from "../org/lifecycle.js";
import { handOff } from "../task/lifecycle.js";
import { type Scenario, scenario } from "../test-support/scenario.js";
import type { Actor } from "../types/actor.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import { giveCoaching, publishSkill, recordMemoryNote } from "./lifecycle.js";

const operator: Actor = { tag: "Operator" };
const rin = AgentId.parse("A-rin");
const pia = AgentId.parse("A-pia");
const asRin: Actor = { tag: "Agent", id: rin };
const asPia: Actor = { tag: "Agent", id: pia };
const parseForm = SkillId.parse("parse-submission-form");

let s: Scenario;
beforeEach(() => {
	s = scenario("2026-10-12T09:00:00.000Z");
});
afterEach(() => s.close());

const seqOf = (seq: Seq) => s.events().find((e) => e.seq === seq);

const note = {
	agent: rin,
	lesson: "The TAT code sits in the last column",
	applies_to: ["Submission Form"],
};

const definitionOf = (id: AgentId): AgentDefinition => {
	const definition = s.ledger.projections.org.agents.get(id)?.definition;
	if (definition === undefined) throw new Error(`${id} is not seeded`);
	return definition;
};

/** The next version of `id`'s definition, granting `skills`, by the Operator. */
const granting = (id: AgentId, skills: string[]): AgentDefinition => {
	const current = definitionOf(id);
	return {
		...current,
		version: current.version + 1,
		skills: skills.map((skill) => SkillId.parse(skill)),
		revised_by: operator,
		revision_reason: "Grant the form Skill",
	};
};

describe("a Memory note", () => {
	it("is noted by its Agent on a Task it was assigned, even after a Hand-off, naming the Task's previous Event as its cause", () => {
		const task_id = s.task(rin);
		handOff(s.ledger, { actor: asRin, task_id, to: pia, reason: "Pia knows" });
		const cause = s.events().at(-1)?.seq;

		const { seq } = recordMemoryNote(s.ledger, {
			actor: asRin,
			task_id,
			...note,
		});

		expect(seqOf(seq)).toMatchObject({
			actor: asRin,
			task_id,
			causation_id: cause,
			kind: "MemoryNoted",
			payload: { ...note, task_id },
		});
		expect(s.ledger.projections.training.notes.get(rin)).toEqual([
			{ ...note, task_id, seq },
		]);
	});

	it("is refused by anyone but its Agent, and on a Task the Agent was never assigned", () => {
		const task_id = s.task(pia);
		const before = s.events().length;

		expect(() =>
			recordMemoryNote(s.ledger, { actor: asPia, task_id, ...note }),
		).toThrow(
			new AppendRefused(
				"MemoryNoted refused: a Memory note is A-rin's own; A-pia tried to note one for it",
			),
		);
		expect(() =>
			recordMemoryNote(s.ledger, { actor: asRin, task_id, ...note }),
		).toThrow(
			new AppendRefused("MemoryNoted refused: A-rin was never assigned T-1"),
		);
		expect(() =>
			recordMemoryNote(s.ledger, {
				actor: asRin,
				task_id: TaskId.parse("T-9"),
				...note,
			}),
		).toThrow(new AppendRefused("MemoryNoted refused: T-9 does not exist"));
		expect(s.events(), "nothing is appended").toHaveLength(before);
	});
});

describe("a Skill", () => {
	it("is published as version 1, then version 2 naming version 1 as its cause, each authored by its publisher", () => {
		const first = publishSkill(s.ledger, {
			actor: operator,
			id: parseForm,
			title: "Parse a Submission Form",
			body_md: "Read every field.",
		});
		const second = publishSkill(s.ledger, {
			actor: asRin,
			id: parseForm,
			title: "Parse a Submission Form",
			body_md: "Read every field, TAT code last.",
		});

		expect(first.skill).toMatchObject({ version: 1, author: operator });
		expect(second.skill).toMatchObject({ version: 2, author: asRin });
		expect(seqOf(first.seq)?.causation_id).toBeUndefined();
		expect(seqOf(second.seq)).toMatchObject({
			actor: asRin,
			causation_id: first.seq,
			kind: "SkillPublished",
		});
		expect(
			s.ledger.projections.training.skills
				.get(parseForm)
				?.map((v) => [v.version, v.seq]),
		).toEqual([
			[1, first.seq],
			[2, second.seq],
		]);
	});

	it("is refused when a version skips one, names another author, or does not name the version before it", () => {
		const first = publishSkill(s.ledger, {
			actor: operator,
			id: parseForm,
			title: "Parse a Submission Form",
			body_md: "Read every field.",
		});
		const next = (version: number, author: Actor) => ({
			id: parseForm,
			version,
			title: "Parse a Submission Form",
			body_md: "Read every field.",
			author,
		});

		expect(() =>
			s.appendNonTask({
				actor: operator,
				causation_id: first.seq,
				kind: "SkillPublished",
				payload: next(3, operator),
			}),
		).toThrow(
			new AppendRefused(
				"SkillPublished refused: parse-submission-form is at version 1, so its next version is 2, not 3",
			),
		);
		expect(() =>
			s.appendNonTask({
				actor: asRin,
				causation_id: first.seq,
				kind: "SkillPublished",
				payload: next(2, operator),
			}),
		).toThrow(
			new AppendRefused(
				"SkillPublished refused: parse-submission-form version 2 names Operator as its author, but the actor is A-rin",
			),
		);
		expect(() =>
			s.appendNonTask({
				actor: operator,
				kind: "SkillPublished",
				payload: next(2, operator),
			}),
		).toThrow(
			new AppendRefused(
				`SkillPublished refused: parse-submission-form version 2 names version 1, seq ${first.seq}, as its cause, not none`,
			),
		);
	});

	it("is granted only once published: a Recruitment or Revision listing an unpublished Skill id is refused naming it", () => {
		expect(() =>
			revise(s.ledger, {
				actor: operator,
				definition: granting(rin, ["parse-submission-form"]),
			}),
		).toThrow(
			new AppendRefused(
				"AgentDefinitionRevised refused: A-rin's definition grants the Skill parse-submission-form, which has not been published",
			),
		);
		expect(() =>
			recruit(s.ledger, {
				actor: operator,
				definition: {
					...definitionOf(rin),
					id: AgentId.parse("A-noor"),
					version: 1,
					skills: [parseForm],
					revised_by: operator,
				},
			}),
		).toThrow(
			new AppendRefused(
				"AgentRecruited refused: A-noor's definition grants the Skill parse-submission-form, which has not been published",
			),
		);

		publishSkill(s.ledger, {
			actor: operator,
			id: parseForm,
			title: "Parse a Submission Form",
			body_md: "Read every field.",
		});
		const { agent } = revise(s.ledger, {
			actor: operator,
			definition: granting(rin, ["parse-submission-form"]),
		});

		expect(agent.definition.skills).toEqual([parseForm]);
	});
});

describe("Coaching", () => {
	it("is the Operator's, on a Task when one is named, whose previous Event is its cause", () => {
		const task_id = s.task(rin);
		const cause = s.events().at(-1)?.seq;

		const onTask = giveCoaching(s.ledger, {
			actor: operator,
			agent_id: rin,
			task_id,
			note: "Check the TAT code first",
		});
		const general = giveCoaching(s.ledger, {
			actor: operator,
			agent_id: rin,
			note: "Request help from Pia before a Hand-off",
		});

		expect(seqOf(onTask.seq)).toMatchObject({
			actor: operator,
			task_id,
			causation_id: cause,
			kind: "HumanCoached",
		});
		expect(seqOf(general.seq)?.causation_id).toBeUndefined();
		expect(
			s.ledger.projections.training.coaching.get(rin)?.map((c) => c.seq),
		).toEqual([onTask.seq, general.seq]);
	});

	it("is refused from anyone but the Operator, and for an Agent not in the Org", () => {
		const before = s.events().length;

		expect(() =>
			giveCoaching(s.ledger, {
				actor: asPia,
				agent_id: rin,
				note: "Slow down",
			}),
		).toThrow(
			new AppendRefused(
				"HumanCoached refused: only the Operator gives Coaching; A-pia tried to give it to A-rin",
			),
		);
		expect(() =>
			s.appendNonTask({
				actor: asPia,
				kind: "HumanCoached",
				payload: { agent_id: rin, note: "Slow down" },
			}),
		).toThrow(
			new AppendRefused(
				"HumanCoached refused: only the Operator gives Coaching; A-pia tried to give it to A-rin",
			),
		);
		expect(() =>
			giveCoaching(s.ledger, {
				actor: operator,
				agent_id: AgentId.parse("A-nobody"),
				note: "Slow down",
			}),
		).toThrow(
			new AppendRefused("HumanCoached refused: A-nobody is not in the Org"),
		);
		expect(s.events(), "nothing is appended").toHaveLength(before);
	});
});
