---
status: proposed
---

# Agents run as Agent SDK sessions on the Operator's Mac, and Cloudflare only tunnels the interface

No API key exists, and the Operator will not pay any new invoice. We run every Turn as a Claude Agent SDK `query()` from the Conductor on the Operator's Mac, authenticated by the Operator's Claude subscription through the `claude` CLI. Cloudflare Tunnel and Cloudflare Access, both on the free tier, expose only the Operator's interface.

## Considered Options

- An API key on a hosted server. Rejected for now because it bills per token.
- A Cloudflare Workers runtime. Rejected because the Agent SDK spawns a local CLI process, and paid Workers or Containers plans would create an invoice.

## Consequences

- Agents work only while the Mac runs the Conductor.
- Authentication is one module with one interface, so an API key with `maxBudgetUsd` can replace the subscription later without other changes.
- The Agent SDK documentation does not list subscription login for a personal tool as a supported path, and it forbids third parties from offering claude.ai login in their products. We record this as an open risk in `docs/design/overview.md`.
- Lab text reaches Anthropic inside prompts. Real lab data waits for slice 3 and an explicit Operator decision.
