import { defineConfig } from "vitest/config";

// Task and Vitality rules and the interface's views run in process, so their
// suites keep vitest's default timeouts. The glossary check walks the whole
// repository and every command test, Task and Vitality ones included, spawns
// the command line; on a shared CI runner both run past the 5 s default.
const IN_PROCESS = [
	"src/task/**/!(commands).test.ts",
	"src/vitality/**/!(commands).test.ts",
	"ui/**/*.test.ts",
];

// The warm Sandbox suite times its Runs against a bound, so it runs after
// every other suite, when their containers no longer take the CPU.
const ALONE = ["src/sandbox/warm.test.ts"];

// The Chains' tests time the Conductor's reply against a bound, so they run
// last of all, after the warm Sandbox suite too.
const TIMED = ["src/chain/chains.test.ts"];

export default defineConfig({
	test: {
		// Every command line a test spawns acts for this person, as README's
		// examples do; a test of the refusal unsets it. TEST_OPERATOR matches it.
		env: { ALIQUOT_OPERATOR: "operator@lab.test" },
		projects: [
			{
				extends: true,
				test: { name: "default timeouts", include: IN_PROCESS },
			},
			{
				extends: true,
				test: {
					name: "long timeouts",
					include: ["src/**/*.test.ts"],
					exclude: [...IN_PROCESS, ...ALONE, ...TIMED],
					testTimeout: 30_000,
					hookTimeout: 30_000,
				},
			},
			{
				extends: true,
				test: {
					name: "alone",
					include: ALONE,
					testTimeout: 30_000,
					hookTimeout: 30_000,
					sequence: { groupOrder: 1 },
				},
			},
			{
				extends: true,
				test: {
					name: "timed",
					include: TIMED,
					testTimeout: 30_000,
					hookTimeout: 30_000,
					sequence: { groupOrder: 2 },
				},
			},
		],
	},
});
