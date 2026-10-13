/**
 * How a Turn authenticates to the model (`docs/design/overview.md`,
 * "Authentication"): the `claude` CLI's subscription login, or an API key
 * from `ALIQUOT_API_KEY`, which needs a budget cap. The printout of a Turn
 * names it; the Ledger never does.
 */
export type Login =
	| { readonly tag: "Subscription" }
	| { readonly tag: "ApiKey"; readonly key: string };

export const API_KEY_VARIABLE = "ALIQUOT_API_KEY";

// Variables through which the `claude` CLI would bill an API account instead
// of the subscription.
const BILLED_VARIABLES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

export const loginFrom = (env: NodeJS.ProcessEnv): Login => {
	const key = env[API_KEY_VARIABLE];
	return key === undefined || key === ""
		? { tag: "Subscription" }
		: { tag: "ApiKey", key };
};

export const loginText = (login: Login): string =>
	login.tag === "Subscription"
		? "the subscription login of the claude CLI"
		: `an API key from ${API_KEY_VARIABLE}`;

/**
 * The environment of the `claude` CLI for `login`: the subscription login
 * drops every variable that would bill an API account, and an API key is the
 * only one set.
 */
export const loginEnvironment = (
	login: Login,
	env: NodeJS.ProcessEnv,
): Record<string, string> => {
	const kept = Object.fromEntries(
		Object.entries(env).filter(
			(entry): entry is [string, string] =>
				entry[1] !== undefined &&
				!BILLED_VARIABLES.includes(entry[0]) &&
				entry[0] !== API_KEY_VARIABLE,
		),
	);
	return login.tag === "Subscription"
		? kept
		: { ...kept, ANTHROPIC_API_KEY: login.key };
};
