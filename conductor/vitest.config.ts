import { defineConfig } from "vitest/config";

// The glossary check walks the whole repository and the command tests spawn
// the command line; on a shared CI runner both run past vitest's 5 s default.
export default defineConfig({
	test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
