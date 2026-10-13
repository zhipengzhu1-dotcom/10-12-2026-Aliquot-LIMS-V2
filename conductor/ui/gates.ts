import type { AgentState } from "./agent.js";
import { escapeHtml } from "./markup.js";
import type { Sources, View } from "./views.js";

export type Actor =
	| { readonly tag: "Operator" }
	| { readonly tag: "Conductor" }
	| { readonly tag: "Agent"; readonly id: string };

/** A Gate as `/api/gates` sends it. */
export type GateJson = {
	readonly id: string;
	readonly kind: string;
	readonly requester: Actor;
	readonly requested_at: string;
	readonly requested_seq: number;
	readonly task_id?: string;
	readonly payload: unknown;
	readonly payload_hash: string;
	readonly lifetime_s: number;
	readonly decision?: {
		readonly meaning: "approve" | "reject";
		readonly reason: string;
		readonly decided_at: string;
		readonly seq: number;
	};
};

type GateState = "Open" | "Approved" | "Rejected" | "Expired";

export const actorText = (actor: Actor): string =>
	actor.tag === "Agent" ? actor.id : actor.tag;

/** `45s`, `12m`, `2h 5m`, `3d 0h`, as `gate list` prints an age. */
const durationText = (ms: number): string => {
	const s = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(s / 60);
	const h = Math.floor(m / 60);
	const d = Math.floor(h / 24);
	if (m < 1) return `${s}s`;
	if (h < 1) return `${m}m`;
	if (d < 1) return `${h}h ${m % 60}m`;
	return `${d}d ${h % 24}h`;
};

const expiresAt = (gate: GateJson): number =>
	Date.parse(gate.requested_at) + gate.lifetime_s * 1000;

/** The Gate lifecycle's rule: a decision is final, and an undecided Gate expires with its lifetime. */
const stateOf = (gate: GateJson, now: Date): GateState => {
	if (gate.decision !== undefined)
		return gate.decision.meaning === "approve" ? "Approved" : "Rejected";
	return now.getTime() >= expiresAt(gate) ? "Expired" : "Open";
};

/** When a closed Gate was decided, or else when it expired. */
const closedAt = (gate: GateJson): number =>
	gate.decision === undefined
		? expiresAt(gate)
		: Date.parse(gate.decision.decided_at);

/**
 * Open Gates oldest first, since the oldest expires first; the decided and
 * expired ones most recently closed first.
 */
const byState = (gates: readonly GateJson[], now: Date) => ({
	open: gates
		.filter((g) => stateOf(g, now) === "Open")
		.sort((a, b) => a.requested_seq - b.requested_seq),
	closed: gates
		.filter((g) => stateOf(g, now) !== "Open")
		.sort(
			(a, b) => closedAt(b) - closedAt(a) || b.requested_seq - a.requested_seq,
		),
});

/** One field that differs, with its value now and its value as proposed. */
export type DiffRow = {
	readonly field: string;
	readonly current: string;
	readonly proposed: string;
};

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Every leaf by its dotted path; an array is one leaf. */
const leaves = (value: Json, prefix = ""): [string, unknown][] =>
	Object.entries(value).flatMap(([key, v]) =>
		isObject(v) ? leaves(v, `${prefix}${key}.`) : [[`${prefix}${key}`, v]],
	);

const valueText = (value: unknown): string =>
	value === undefined
		? ""
		: typeof value === "string"
			? value
			: JSON.stringify(value);

/** The fields of `current` and `proposed` that differ, in `current`'s order. */
export const definitionDiff = (current: Json, proposed: Json): DiffRow[] => {
	const now = new Map(leaves(current));
	const next = new Map(leaves(proposed));
	return [...new Set([...now.keys(), ...next.keys()])]
		.map((field) => ({
			field,
			current: valueText(now.get(field)),
			proposed: valueText(next.get(field)),
		}))
		.filter((row) => row.current !== row.proposed);
};

/** The Agent as the Org holds it: its definition and whether it is Retired. */
const agentFields = (agent: AgentState): Json => ({
	...agent.definition,
	retired: agent.retired,
});

/** What approving each kind of Gate that names an Agent would make of it. */
const PROPOSALS: Readonly<Record<string, (agent: Json) => Json>> = {
	RetireAgent: (agent) => ({ ...agent, retired: true }),
	PromoteToMentor: (agent) => ({ ...agent, trust_tier: "Mentor" }),
};

/**
 * For a Gate that changes the Agent its payload names, the Agent now against
 * the Agent the Gate proposes; undefined for any other Gate.
 */
export const proposedChange = (
	gate: GateJson,
	agents: Readonly<Record<string, AgentState>>,
): DiffRow[] | undefined => {
	const propose = PROPOSALS[gate.kind];
	const named = isObject(gate.payload) ? gate.payload.agent_id : undefined;
	const agent = typeof named === "string" ? agents[named] : undefined;
	if (propose === undefined || agent === undefined) return undefined;
	const current = agentFields(agent);
	return definitionDiff(current, propose(current));
};

const diffTable = (rows: readonly DiffRow[]) =>
	`<table class="diff"><thead><tr><th>Field</th><th>Now</th><th>Proposed</th></tr></thead><tbody>${rows
		.map(
			(r) =>
				`<tr><th>${escapeHtml(r.field)}</th><td>${escapeHtml(r.current)}</td><td>${escapeHtml(r.proposed)}</td></tr>`,
		)
		.join("")}</tbody></table>`;

/** Approve or reject, each with a reason, signed for the hash this page read. */
const decideForm = (gate: GateJson, decision: "approve" | "reject") => {
	const id = `${decision}-${escapeHtml(gate.id)}`;
	const body = { gate_id: gate.id, decision, hash: gate.payload_hash };
	return `<form id="${id}" class="act" data-action="gate-decide" data-body="${escapeHtml(JSON.stringify(body))}"><input id="${id}-reason" name="reason" placeholder="Reason" aria-label="Reason to ${decision}" required><button>${decision === "approve" ? "Approve" : "Reject"}</button></form>`;
};

const facts = (pairs: readonly (readonly [string, string])[]) =>
	`<dl class="facts">${pairs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;

const openGate = (
	gate: GateJson,
	agents: Readonly<Record<string, AgentState>>,
	now: Date,
) => {
	const change = proposedChange(gate, agents);
	const age = now.getTime() - Date.parse(gate.requested_at);
	return [
		`<article class="gate" data-gate="${escapeHtml(gate.id)}">`,
		`<h3>${escapeHtml(gate.id)} <span class="kind">${escapeHtml(gate.kind)}</span> <span class="badge state-open">Open</span></h3>`,
		facts([
			["Requester", escapeHtml(actorText(gate.requester))],
			["Age", durationText(age)],
			[
				"Lifetime",
				`${durationText(gate.lifetime_s * 1000)}, expires in ${durationText(expiresAt(gate) - now.getTime())}`,
			],
			[
				"Blocks",
				gate.task_id === undefined ? "no Task" : escapeHtml(gate.task_id),
			],
			["Payload hash", `<code>${escapeHtml(gate.payload_hash)}</code>`],
		]),
		change === undefined ? "" : diffTable(change),
		`<pre class="payload">${escapeHtml(JSON.stringify(gate.payload, null, 2))}</pre>`,
		`<div class="decide">${decideForm(gate, "approve")}${decideForm(gate, "reject")}</div>`,
		"</article>",
	].join("");
};

const closedGate = (gate: GateJson, now: Date) => {
	const state = stateOf(gate, now);
	const { decision } = gate;
	const outcome =
		decision === undefined
			? `expired ${new Date(expiresAt(gate)).toISOString()}`
			: `decided by the Operator ${escapeHtml(decision.decided_at)} at seq ${decision.seq}: ${escapeHtml(decision.reason)}`;
	return `<li class="gate" data-gate="${escapeHtml(gate.id)}"><b>${escapeHtml(gate.id)}</b> <span class="kind">${escapeHtml(gate.kind)}</span> <span class="badge state-${state.toLowerCase()}">${state}</span> requested by ${escapeHtml(actorText(gate.requester))}, ${outcome}</li>`;
};

/**
 * Open Gates first, each with its kind, requester, age, lifetime, the Task it
 * blocks, the change it proposes or its payload, and approve and reject;
 * then the decided and expired ones. `now` is when the page read the Gates,
 * since expiry needs no Event.
 */
const render = (_view: View, data: Sources): string => {
	const gates = Object.values(
		(data.gates as { gates: Readonly<Record<string, GateJson>> }).gates,
	);
	const agents = (data.org as { agents: Readonly<Record<string, AgentState>> })
		.agents;
	const now = new Date(data.now as string);
	const { open, closed } = byState(gates, now);
	return [
		"<h1>Gates</h1>",
		`<h2>Open</h2>`,
		open.length === 0
			? `<p class="empty">No open Gates.</p>`
			: open.map((g) => openGate(g, agents, now)).join(""),
		`<h2>Decided and expired</h2>`,
		closed.length === 0
			? `<p class="empty">None yet.</p>`
			: `<ul class="gates">${closed.map((g) => closedGate(g, now)).join("")}</ul>`,
	].join("");
};

export const gatesView: View = {
	name: "gates",
	title: "Gates",
	sources: ["gates", "org"],
	render,
	load: async (_params, get) => ({
		gates: await get("gates"),
		org: await get("org"),
		now: new Date().toISOString(),
	}),
};
