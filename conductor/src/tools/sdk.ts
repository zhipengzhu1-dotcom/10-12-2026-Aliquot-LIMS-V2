import type {
	HookCallback,
	McpSdkServerConfigWithInstance,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { loginEnvironment } from "../turn/auth.js";
import {
	outcomeOf,
	type RunModel,
	type ToolCaller,
	usageOf,
} from "../turn/model.js";
import { callTool } from "./hook.js";
import { TOOLS } from "./table.js";
import type { ToolContext } from "./tool.js";

// The only module that loads the Agent SDK, and only when a server is built
// or a real Turn runs, so `tools list`, `tools call` and a Turn on the
// scripted model never load it.

export const SERVER_NAME = "aliquot";

/** The name the model calls a Tool by: `mcp__aliquot__<tool>`. */
export const sdkToolName = (tool: string) => `mcp__${SERVER_NAME}__${tool}`;

/**
 * The in-process MCP server of one Agent, built from the Tool table. Every
 * call runs through the hook as the context's Agent, which no input names.
 */
export const aliquotServer = (
	ctx: ToolContext,
): Promise<McpSdkServerConfigWithInstance> =>
	toolServer((name, args) => callTool(ctx, name, args));

/** The server of the Tool table, whose every call goes to `call`. */
const toolServer = async (
	call: ToolCaller,
): Promise<McpSdkServerConfigWithInstance> => {
	const { createSdkMcpServer, tool } = await import(
		"@anthropic-ai/claude-agent-sdk"
	);
	return createSdkMcpServer({
		name: SERVER_NAME,
		tools: TOOLS.map((row) =>
			tool(row.name, row.description, row.input.shape, async (args) => {
				const { tag, text } = await call(row.name, args);
				return {
					content: [{ type: "text", text }],
					...(tag === "Done" ? {} : { isError: true }),
				};
			}),
		),
	});
};

/**
 * The model of a real Turn: one `query()` of the Agent SDK, with this
 * server's Tools and no other, no settings or MCP servers from the machine,
 * permissions that deny every tool not allowed, and the hook below.
 */
export const sdkModel: RunModel = async (request) => {
	const { query } = await import("@anthropic-ai/claude-agent-sdk");
	const server = await toolServer(request.call);
	async function* opening(): AsyncGenerator<SDKUserMessage> {
		yield {
			type: "user",
			message: { role: "user", content: request.prompt.work },
			parent_tool_use_id: null,
		};
	}
	const turn = query({
		prompt: opening(),
		options: {
			model: request.model,
			systemPrompt: request.prompt.standing,
			mcpServers: { [SERVER_NAME]: server },
			strictMcpConfig: true,
			settingSources: [],
			tools: [],
			allowedTools: request.tools.map(sdkToolName),
			permissionMode: "dontAsk",
			hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
			cwd: request.cwd,
			maxTurns: request.maxTurns,
			...(request.maxBudgetUsd === undefined
				? {}
				: { maxBudgetUsd: request.maxBudgetUsd }),
			env: loginEnvironment(request.login, process.env),
		},
	});
	for await (const message of turn) {
		if (message.type === "result") {
			return {
				outcome: outcomeOf(message),
				usage: usageOf(message.modelUsage),
			};
		}
	}
	throw new Error("the model stopped without a result");
};

/**
 * The `PreToolUse` hook of a Turn: it denies every tool but this server's,
 * whose calls the server's own hook judges, so an Agent has no tool that
 * reaches past the Ledger or the Sandbox.
 */
export const preToolUse: HookCallback = async (input) => {
	if (
		input.hook_event_name !== "PreToolUse" ||
		input.tool_name.startsWith(sdkToolName(""))
	) {
		return {};
	}
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: `${input.tool_name} is not an Aliquot Tool; an Agent calls only the Tools of the ${SERVER_NAME} server`,
		},
	};
};
