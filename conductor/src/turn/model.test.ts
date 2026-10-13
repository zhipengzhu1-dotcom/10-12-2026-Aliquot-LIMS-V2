import { describe, expect, it } from "vitest";
import { loginEnvironment, loginFrom } from "./auth.js";
import { outcomeOf, usageOf } from "./model.js";

describe("the SDK's result as a Turn's usage and outcome", () => {
	it("sums modelUsage over every model the Turn called", () => {
		expect(
			usageOf({
				"claude-sonnet-5-5": {
					inputTokens: 1200,
					outputTokens: 300,
					cacheReadInputTokens: 9000,
					cacheCreationInputTokens: 40,
					costUSD: 0.02,
				},
				"claude-haiku-5-5": {
					inputTokens: 100,
					outputTokens: 10,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 5,
					costUSD: 0.001,
				},
			}),
		).toEqual({
			input_tokens: 1300,
			output_tokens: 310,
			cache_creation_tokens: 45,
			cache_read_tokens: 9000,
			cost_usd: 0.021,
		});
	});

	it("reads the outcome from the result's subtype", () => {
		const result = (subtype: string, extra = {}) =>
			outcomeOf({ subtype, is_error: subtype !== "success", ...extra });

		expect(result("success")).toEqual({ tag: "Completed" });
		expect(result("error_max_turns")).toEqual({ tag: "MaxTurns" });
		expect(result("error_max_budget_usd")).toEqual({ tag: "Budget" });
		expect(
			result("error_during_execution", { errors: ["the CLI crashed"] }),
		).toEqual({
			tag: "Error",
			message: "error_during_execution: the CLI crashed",
		});
		expect(
			outcomeOf({ subtype: "success", is_error: true, result: "API Error" }),
		).toEqual({ tag: "Error", message: "API Error" });
	});
});

describe("the login of a Turn", () => {
	it("is the subscription unless ALIQUOT_API_KEY is set, and never passes a billed variable to it", () => {
		const env = { PATH: "/bin", ANTHROPIC_API_KEY: "inherited" };

		expect(loginFrom(env)).toEqual({ tag: "Subscription" });
		expect(loginEnvironment({ tag: "Subscription" }, env)).toEqual({
			PATH: "/bin",
		});
		expect(loginFrom({ ...env, ALIQUOT_API_KEY: "k" })).toEqual({
			tag: "ApiKey",
			key: "k",
		});
		expect(
			loginEnvironment(
				{ tag: "ApiKey", key: "k" },
				{
					...env,
					ALIQUOT_API_KEY: "k",
				},
			),
		).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "k" });
	});
});
