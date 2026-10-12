---
status: proposed
---

# All Scripts and agent-written code run only in a Docker Sandbox with no network

Agents may rewrite their own Scripts, so the code they run is untrusted. Every Script and every piece of agent-written code runs in a Docker container started with `--network none`, `--cap-drop ALL`, CPU, memory, and time limits, read-only inputs, and a fresh output directory per Run. The Conductor never evaluates agent-written code in its own process.

## Considered Options

- The Agent SDK's built-in sandbox. Rejected because it covers only the Bash tool. Hooks and MCP tools run outside it, and our Ledger verbs are MCP tools.
