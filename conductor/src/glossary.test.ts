import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Exemption = {
	/** Word or phrase blanked out before the scan. */
	readonly phrase: string;
	/** Path prefix under conductor/src the exemption covers; every file when absent. */
	readonly in?: string;
	readonly reason: string;
};

const ALLOWED: readonly Exemption[] = [
	{
		phrase: "record",
		reason: "TypeScript's Record<> and the verb, as in 'recorded as an Event'",
	},
	{
		phrase: "output",
		reason: "a Run's outputs, the glossary's own phrase, and process output",
	},
	{
		phrase: "owner",
		reason: "the Agent that owns a Script, never the Operator",
	},
	{ phrase: "reviewer", reason: "the giver of a Review, a society term" },
	{ phrase: "entry", reason: "roster, directory and manifest entries" },
	{
		phrase: "rules",
		reason:
			"Gate, org and Task-state rules enforced at append, not a Mood's Policy",
	},
	{ phrase: "step", reason: "a reducer step and the tracer's append helper" },
	{ phrase: "priority", reason: "the Task field the glossary names under TAT" },
	{
		phrase: "status",
		reason: "process exit status and an Agent's paused or retired status",
	},
	{ phrase: "approval", reason: "a Gate's approve decision, not the Gate" },
	{ phrase: "split", reason: "String.prototype.split" },
	{ phrase: "invocation", reason: "the CLI process's working directory" },
	{ phrase: "break", reason: "the JavaScript keyword and 'the chain breaks'" },
	{
		phrase: "container",
		reason: "Docker containers and the lab's shipping containers",
	},
	{ phrase: "Energy budget", reason: "a glossary term" },
	{ phrase: "Memory note", reason: "a glossary term" },
	{ phrase: "Receiving Log", reason: "a lab term" },
	{ phrase: "of Analysis", reason: "Report of Analysis, a lab term" },
	{
		phrase: "toy LIMS",
		reason: "the glossary's own name for the practice database",
	},
	{ phrase: "tools", reason: "the Agent definition field the glossary names" },
	{ phrase: "MemoryNoted", reason: "the Event kind for a Memory note" },
	{ phrase: "team-level", reason: "English" },
	{ phrase: "update(", reason: "Node's Hash.update" },
	{
		phrase: "level",
		in: "events.ts",
		reason: "nesting levels of a payload schema",
	},
	{ phrase: "--format", reason: "a docker CLI flag" },
	{ phrase: "--memory", reason: "a docker CLI flag" },
	{
		phrase: "history",
		in: "room/",
		reason: "a Room's Messages, the `room history` command",
	},
	{
		phrase: "log",
		in: "sandbox/runner.ts",
		reason: "stdout and stderr captures, not the Ledger",
	},
	{
		phrase: "sleep",
		in: "sandbox/runner.ts",
		reason: "node:timers setTimeout",
	},
	{ phrase: "item", in: "sandbox/runner.ts", reason: "array elements" },
	{
		phrase: "blob",
		in: "sandbox/artifacts.ts",
		reason: "files in the content-addressed store",
	},
	{
		phrase: "config",
		in: "sandbox/image.ts",
		reason: "a Docker image's config",
	},
	{
		phrase: "points",
		in: "vitality/vitality.ts",
		reason: "regression data points",
	},
	{
		phrase: "rank",
		in: "vitality/trust.ts",
		reason: "a Trust tier's index in tier order",
	},
	{
		phrase: "group",
		in: "task/commands.ts",
		reason: "Tasks grouped by state in a listing",
	},
	{ phrase: "ask", in: "org/seed.ts", reason: "a Persona's quirk text" },
	{
		phrase: "lesson",
		in: "types/skill.ts",
		reason: "the Memory note field the glossary names",
	},
	{ phrase: "ticket", in: "events.ts", reason: "a GitHub issue, not a Task" },
	{
		phrase: "inspector",
		in: "gate/guards.ts",
		reason: "a regulatory inspector, not the Auditor",
	},
	{ phrase: "edit", in: "vitality/work.ts", reason: "a source-code edit" },
];

/** True positives left in place for a rename. A fixed one fails the test until its line here goes. */
const KNOWN_DRIFT: readonly { readonly file: string; readonly word: string }[] =
	[
		{ file: "sandbox/artifacts.ts", word: "provenance" },
		{ file: "sandbox/commands.ts", word: "provenance" },
		{ file: "sandbox/guards.ts", word: "provenance" },
		{ file: "org/seed.ts", word: "memory" },
		{ file: "types/agent-definition.ts", word: "memory" },
	];

type Entry = { readonly term: string; readonly avoided: readonly string[] };

const parseGlossary = (text: string): Entry[] => {
	const entries: Entry[] = [];
	let term: string | undefined;
	for (const line of text.split("\n")) {
		term = /^\*\*(.+)\*\*:$/.exec(line)?.[1] ?? term;
		const avoid = /^_Avoid_: (.*)$/.exec(line)?.[1];
		if (avoid === undefined || term === undefined) continue;
		const [firstSentence = ""] = avoid.split(/\.(?:\s|$)/);
		entries.push({
			term,
			avoided: firstSentence
				.split(",")
				.map((word) => word.replace(/\(.*$/, "").trim())
				.filter((word) => word !== ""),
		});
	}
	return entries;
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The word or phrase, whole, with an optional plural "s". */
const matcher = (phrase: string, flags: string) => {
	const body = phrase.split(/\s+/).map(escapeRegExp).join("\\s+");
	const start = /^[A-Za-z0-9]/.test(phrase) ? "(?<![A-Za-z0-9])" : "";
	const end = /[A-Za-z0-9]$/.test(phrase) ? "s?(?![A-Za-z0-9])" : "";
	return new RegExp(`${start}${body}${end}`, flags);
};

/** Splits camelCase and snake_case so each part of an identifier reads as a word. */
const words = (line: string) =>
	line.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");

const src = new URL("./", import.meta.url);
const entries = parseGlossary(
	readFileSync(new URL("../../GLOSSARY.md", import.meta.url), "utf8"),
);
const terms = new Set(entries.map(({ term }) => term.toLowerCase()));

// An avoided word that is itself a term, such as "review (Review is a society
// term)" under Verification, steers between two terms; using it is correct.
const rules = entries.flatMap(({ term, avoided }) =>
	avoided
		.filter((word) => !terms.has(word.toLowerCase()))
		.map((word) => ({ term, word, pattern: matcher(word, "i") })),
);

type Compiled = Exemption & { readonly pattern: RegExp };

const exemptions: readonly Compiled[] = ALLOWED.map((a) => ({
	...a,
	pattern: matcher(words(a.phrase), "gi"),
}));

const blank = (allowed: readonly Compiled[], file: string, line: string) =>
	allowed
		.filter((a) => file.startsWith(a.in ?? ""))
		.reduce(
			(rest, { pattern }) => rest.replace(pattern, (m) => " ".repeat(m.length)),
			line,
		);

const sources = readdirSync(src, { recursive: true, encoding: "utf8" })
	.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
	.sort()
	.map((file) => ({
		file,
		lines: readFileSync(new URL(file, src), "utf8").split("\n"),
	}));

const scan = (allowed: readonly Compiled[]) =>
	sources.flatMap(({ file, lines }) =>
		lines.flatMap((line, i) => {
			const scanned = blank(allowed, file, words(line));
			return rules
				.filter(({ pattern }) => pattern.test(scanned))
				.map(({ term, word }) => ({
					file,
					word,
					text: `conductor/src/${file}:${i + 1}: ${term} avoids "${word}": ${line.trim()}`,
				}));
		}),
	);

const hits = scan(exemptions);

const isKnown = (hit: { file: string; word: string }) =>
	KNOWN_DRIFT.some((k) => k.file === hit.file && k.word === hit.word);

describe("GLOSSARY.md", () => {
	it("parses an avoided-word list for every term", () => {
		expect(entries.length).toBeGreaterThan(60);
		expect(entries.find((e) => e.term === "Room")?.avoided).toContain(
			"channel",
		);
		expect(entries.find((e) => e.term === "Mentor")?.avoided).toEqual([
			"lead",
			"coach",
		]);
	});

	it("keeps every avoided word out of the conductor source", () => {
		expect(hits.filter((h) => !isKnown(h)).map((h) => h.text)).toEqual([]);
	});

	it("still finds every known drift, so a fixed one leaves the list", () => {
		const unfound = KNOWN_DRIFT.filter(
			(k) => !hits.some((h) => h.file === k.file && h.word === k.word),
		);
		expect(unfound).toEqual([]);
	});

	it("needs every exemption", () => {
		const unused = exemptions.filter(
			(a) => scan(exemptions.filter((b) => b !== a)).length === hits.length,
		);
		expect(unused.map((a) => a.phrase)).toEqual([]);
	});
});
