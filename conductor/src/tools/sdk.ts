import type {
	HookCallback,
	McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { callTool } from "./hook.js";
import { TOOLS } from "./table.js";
import type { ToolContext } from "./tool.js";

// The only module that loads the Agent SDK, and only when a server is built,
// so `tools list` and `tools call` never load it.

export const SERVER_NAME = "aliquot";

/** The name the model calls a Tool by: `mcp__aliquot__<tool>`. */
export const sdkToolName = (tool: string) => `mcp__${SERVER_NAME}__${tool}`;

/**
 * The in-process MCP server of one Agent, built from the Tool table. Every
 * call runs through the hook as the context's Agent, which no input names.
 */
export const aliquotServer = async (
	ctx: ToolContext,
): Promise<McpSdkServerConfigWithInstance> => {
	const { createSdkMcpServer, tool } = await import(
		"@anthropic-ai/claude-agent-sdk"
	);
	return createSdkMcpServer({
		name: SERVER_NAME,
		tools: TOOLS.map((row) =>
			tool(row.name, row.description, row.input.shape, async (args) => {
				const { tag, text } = await callTool(ctx, row.name, args);
				return {
					content: [{ type: "text", text }],
					...(tag === "Done" ? {} : { isError: true }),
				};
			}),
		),
	});
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
