import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// GLOSSARY.md lists these under Room and Message as words to avoid.
const AVOIDED =
	/\b(channels?|chats?|chat rooms?|dms?|threads?|logs?|groups?|posts?|pings?)\b/i;

const here = new URL("./", import.meta.url);
const sources = [
	...readdirSync(here)
		.filter((f) => f.endsWith(".ts") && f !== "words.test.ts")
		.map((f) => new URL(f, here)),
	new URL("../types/room.ts", import.meta.url),
];

describe("Room vocabulary", () => {
	it("keeps the glossary's avoided words out of the Room code and tests", () => {
		const hits = sources.flatMap((url) =>
			readFileSync(url, "utf8")
				.split("\n")
				.map((line, i) => [line, i + 1] as const)
				.filter(([line]) => AVOIDED.test(line))
				.map(([line, n]) => `${fileURLToPath(url)}:${n}: ${line.trim()}`),
		);

		expect(hits).toEqual([]);
	});
});
