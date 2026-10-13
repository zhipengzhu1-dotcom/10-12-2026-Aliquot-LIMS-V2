import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { describe, expect, it } from "vitest";

type Exemption = {
	/** Word or phrase blanked out before the scan. */
	readonly phrase: string;
	/**
	 * Path prefix from conductor/src the exemption covers, `../ui/` for the
	 * interface; every file when absent.
	 */
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
	// Scoped to where the type is named, since its words also match the
	// prose "toy LIMS database".
	...["types/artifact.ts", "workflow/"].map((file) => ({
		phrase: "LimsDatabase",
		in: file,
		reason: "the Artifact type of the toy LIMS database",
	})),
	{ phrase: "lims.sqlite", reason: "the toy LIMS database's filename" },
	{
		phrase: "log_receipt",
		reason: "the stage 2 Script, which writes Receiving Log rows",
	},
	{
		phrase: "render_roa",
		in: "workflow/",
		reason:
			"the stage 6 Script, which renders the Report of Analysis; issue 33 names it",
	},
	{
		phrase: "toy LIMS",
		reason: "the glossary's own name for the practice database",
	},
	{ phrase: "MemoryNoted", reason: "the Event kind for a Memory note" },
	{ phrase: "team-level", reason: "English" },
	{ phrase: "update(", reason: "Node's Hash.update" },
	{
		phrase: "level",
		in: "events.ts",
		reason: "nesting levels of a payload schema",
	},
	...["cache_creation", "cache_read"].map((phrase) => ({
		phrase,
		reason: "prompt-cache tokens the model reports for a Turn",
	})),
	{ phrase: "--format", reason: "a docker CLI flag" },
	{ phrase: "--memory", reason: "a docker CLI flag" },
	{
		phrase: "history",
		in: "room/",
		reason: "a Room's Messages, the `room history` command",
	},
	{
		phrase: "history",
		in: "tools/table.ts",
		reason: "the Room function that reads a Room's Messages",
	},
	{
		phrase: "note_memory",
		in: "tools/table.ts",
		reason: "the Tool that notes a Memory note, as the ticket names it",
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
	...[
		"types/skill.ts",
		"training/commands.ts",
		"tools/table.ts",
		"turn/prompt.ts",
	].map((file) => ({
		phrase: "lesson",
		in: file,
		reason: "the Memory note field the glossary names",
	})),
	...["training/commands.ts", "serve/actions.ts"].map((file) => ({
		phrase: "coach",
		in: file,
		reason:
			"the `training coach` command and the `coach` action, by which the Operator gives Coaching",
	})),
	{ phrase: "ticket", in: "events.ts", reason: "a GitHub issue, not a Task" },
	{
		phrase: "inspector",
		in: "gate/guards.ts",
		reason: "a regulatory inspector, not the Auditor",
	},
	...["storage.ts", "ledger.ts", "test-support/scenario.ts"].map((file) => ({
		phrase: "memory",
		in: file,
		reason: "process memory, the Ledger's storage for tests, not a Memory note",
	})),
	...["createServer", "ServerResponse", "Server-Sent"].map((phrase) => ({
		phrase,
		in: "serve/",
		reason: "names in Node's http API and the SSE standard, not the Conductor",
	})),
	{ phrase: "POST", in: "serve/", reason: "the HTTP method" },
	{
		phrase: "McpSdkServerConfigWithInstance",
		in: "tools/sdk.ts",
		reason: "the Agent SDK's type of an in-process MCP server",
	},
	...["systemPrompt", "strictMcpConfig", "dontAsk", '"user"'].map((phrase) => ({
		phrase,
		in: "tools/sdk.ts",
		reason:
			"names in the Agent SDK's query options and the Messages API's role of the prompt that opens a Turn",
	})),
	{
		phrase: "server",
		in: "tools/",
		reason:
			"an MCP server, the Agent SDK's name for what serves an Agent its Tools, not the Conductor",
	},
	{
		phrase: "no-cache",
		in: "serve/sse.ts",
		reason: "an HTTP cache-control value",
	},
	{
		phrase: "cache-control",
		in: "serve/",
		reason: "the HTTP header, not a Projection",
	},
	{
		phrase: "format",
		in: "serve/access.ts",
		reason: "the key format createPublicKey reads, a JWK",
	},
	{ phrase: "POST", in: "../ui/actions.ts", reason: "the HTTP method" },
	...["../ui/chat.ts", "../ui/views.ts", "serve/routes.ts"].map((file) => ({
		phrase: "chat",
		in: file,
		reason: "the Chat view (a glossary term) and the `chat` route it reads",
	})),
	{
		phrase: "coach",
		in: "../ui/agent.ts",
		reason: "the `coach` action, by which the Operator gives Coaching",
	},
	{
		phrase: "lesson",
		in: "../ui/agent.ts",
		reason: "the Memory note field the glossary names",
	},
	{
		phrase: "polyline points",
		in: "../ui/agent.ts",
		reason: "the SVG attribute",
	},
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

// The interface's modules are keyed by their path from conductor/src too, as
// `../ui/org.ts`, so an exemption's `in` reads the same for both.
const modules = (dir: string) =>
	readdirSync(new URL(dir, src), { recursive: true, encoding: "utf8" })
		.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
		.map((f) => `${dir}${f}`);

const sources = [
	...modules(""),
	...modules("../ui/").filter((f) => f !== "../ui/test-support.ts"),
]
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
					text: `${posix.normalize(`conductor/src/${file}`)}:${i + 1}: ${term} avoids "${word}": ${line.trim()}`,
				}));
		}),
	);

const hits = scan(exemptions);

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
		expect(hits.map((h) => h.text)).toEqual([]);
	});

	it("reads the interface's modules but not its tests, and names a hit's path", () => {
		const ui = sources
			.map(({ file }) => file)
			.filter((file) => file.startsWith("../ui/"));
		expect(ui).toContain("../ui/org.ts");
		expect(ui).not.toContain("../ui/test-support.ts");
		expect(ui.filter((file) => file.endsWith(".test.ts"))).toEqual([]);

		const unexempted = scan(
			exemptions.filter((a) => a.in !== "../ui/actions.ts"),
		);
		expect(unexempted.map((h) => h.text)).toContainEqual(
			expect.stringMatching(
				/^conductor\/ui\/actions\.ts:\d+: Message avoids "post"/,
			),
		);
	});

	it("needs every exemption", () => {
		// An exemption is needed when the scan without it reports more hits. Leaving
		// it out changes only the lines where it blanked something, so only those
		// lines are scanned again, once per exemption that blanked them.
		const added = new Map<Compiled, number>();
		const count = (text: string) =>
			rules.filter(({ pattern }) => pattern.test(text)).length;
		for (const { file, lines } of sources) {
			const allowed = exemptions.filter((a) => file.startsWith(a.in ?? ""));
			for (const line of lines) {
				const text = words(line);
				const blanked: Compiled[] = [];
				const scanned = allowed.reduce((rest, a) => {
					const next = rest.replace(a.pattern, (m) => " ".repeat(m.length));
					if (next !== rest) blanked.push(a);
					return next;
				}, text);
				for (const a of blanked) {
					const without = blank(
						allowed.filter((b) => b !== a),
						file,
						text,
					);
					added.set(a, (added.get(a) ?? 0) + count(without) - count(scanned));
				}
			}
		}
		const unused = exemptions.filter((a) => (added.get(a) ?? 0) === 0);
		expect(unused.map((a) => a.phrase)).toEqual([]);
	});
});
