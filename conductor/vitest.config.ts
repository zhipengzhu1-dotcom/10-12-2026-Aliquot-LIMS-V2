import { defineConfig } from "vitest/config";

// Task and Vitality rules run in process, so their suites keep vitest's
// default timeouts. The glossary check walks the whole repository and the
// other command tests spawn the command line; on a shared CI runner both run
// past the 5 s default.
const IN_PROCESS = ["src/task/**/*.test.ts", "src/vitality/**/*.test.ts"];

export default defineConfig({
	test: {
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
					exclude: IN_PROCESS,
					testTimeout: 30_000,
					hookTimeout: 30_000,
				},
			},
		],
	},
});
