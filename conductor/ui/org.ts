import { escapeHtml } from "./markup.js";
import type { Sources, View } from "./views.js";

/** An Agent definition as `/api/org-tree` sends it, the fields this view reads named. */
type Definition = {
	readonly id: string;
	readonly version: number;
	readonly name: string;
	readonly role: string;
	readonly supervisor_id?: string;
	readonly trust_tier: string;
	readonly [field: string]: unknown;
};

type AgentState = { readonly definition: Definition; readonly paused: boolean };

/** A node of the reporting tree `org tree` prints. */
type OrgNode =
	| { readonly tag: "Operator"; readonly children: readonly OrgNode[] }
	| {
			readonly tag: "Agent";
			readonly agent: AgentState;
			readonly children: readonly OrgNode[];
	  }
	| {
			readonly tag: "Pool";
			readonly supervisors: readonly AgentState[];
			readonly children: readonly OrgNode[];
	  };

/** One live Agent of `/api/vitality`, the fields this view reads. */
type AgentVitality = {
	readonly vitality: { readonly load: number };
	readonly mood: string;
};

/** The roles an Agent may report to by `supervisor_id`. */
const SUPERVISING_ROLES: ReadonlySet<string> = new Set([
	"Director",
	"Supervisor",
]);

const andList = (names: readonly string[]) =>
	names.length <= 1
		? names.join("")
		: `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

const agentsIn = (node: OrgNode): AgentState[] => [
	...(node.tag === "Agent" ? [node.agent] : []),
	...node.children.flatMap(agentsIn),
];

const form = (
	verb: string,
	id: string,
	body: unknown,
	fields: string,
	button: string,
) =>
	`<form id="${verb}-${id}" data-action="${verb}" data-body="${escapeHtml(JSON.stringify(body))}">${fields}<button>${button}</button></form>`;

const reasonField = (formId: string, name: string) =>
	`<input id="${formId}-reason" name="${name}" placeholder="Reason" aria-label="Reason" required>`;

/**
 * Pause or resume, reassign (a Revision of `supervisor_id`), and request a
 * RetireAgent Gate. A supervisor that is the Agent or reports to it would
 * make a loop, so it is not offered.
 */
const actions = (
	node: OrgNode & { tag: "Agent" },
	supervisors: AgentState[],
) => {
	const { definition, paused } = node.agent;
	const id = escapeHtml(definition.id);
	const below = new Set(agentsIn(node).map((a) => a.definition.id));
	const options = [
		`<option value="">Operator</option>`,
		...supervisors
			.filter((supervisor) => !below.has(supervisor.definition.id))
			.map(
				({ definition: d }) =>
					`<option value="${escapeHtml(d.id)}"${d.id === definition.supervisor_id ? " selected" : ""}>${escapeHtml(d.name)}, ${escapeHtml(d.role)}</option>`,
			),
	].join("");
	const next = {
		...definition,
		version: definition.version + 1,
		revised_by: { tag: "Operator" },
	};
	return [
		paused
			? form("resume", id, { agent_id: definition.id }, "", "Resume")
			: form(
					"pause",
					id,
					{ agent_id: definition.id },
					reasonField(`pause-${id}`, "reason"),
					"Pause",
				),
		form(
			"revise",
			id,
			{ definition: next },
			`<select id="revise-${id}-supervisor" name="definition.supervisor_id" aria-label="Supervisor">${options}</select>${reasonField(`revise-${id}`, "definition.revision_reason")}`,
			"Reassign",
		),
		form(
			"retire-request",
			id,
			{ agent_id: definition.id },
			reasonField(`retire-request-${id}`, "reason"),
			"Request retirement",
		),
	].join("");
};

const agentLine = (
	node: OrgNode & { tag: "Agent" },
	vitality: Readonly<Record<string, AgentVitality>>,
	supervisors: AgentState[],
) => {
	const { definition, paused } = node.agent;
	const id = escapeHtml(definition.id);
	const v = vitality[definition.id];
	const load = v?.vitality.load;
	return [
		`<div class="agent" data-agent="${id}">`,
		`<a href="#/agent?id=${encodeURIComponent(definition.id)}">${escapeHtml(definition.name)}</a>`,
		`<span class="role">${escapeHtml(definition.role)}</span>`,
		v === undefined
			? ""
			: `<span class="badge mood-${escapeHtml(v.mood)}">${escapeHtml(v.mood)}</span>`,
		`<span class="badge tier">${escapeHtml(definition.trust_tier)}</span>`,
		paused ? `<span class="badge paused">paused</span>` : "",
		load === undefined
			? ""
			: `<meter class="load" min="0" max="1" low="0.7" high="0.99" optimum="0" value="${load}" aria-label="Load">${load}</meter><span class="load-value">load ${load.toFixed(2)}</span>`,
		`<details id="act-${id}"><summary>Actions</summary>${actions(node, supervisors)}</details>`,
		"</div>",
	].join("");
};

const branch = (
	node: OrgNode,
	vitality: Readonly<Record<string, AgentVitality>>,
	supervisors: AgentState[],
): string => {
	const line =
		node.tag === "Operator"
			? `<div class="operator">Operator</div>`
			: node.tag === "Pool"
				? `<div class="pool">Specialist pool, reports to ${escapeHtml(andList(node.supervisors.map((s) => s.definition.name)))}</div>`
				: agentLine(node, vitality, supervisors);
	const children = node.children
		.map((c) => branch(c, vitality, supervisors))
		.join("");
	return `<li>${line}${children === "" ? "" : `<ul>${children}</ul>`}</li>`;
};

/**
 * The reporting tree in `org tree`'s order, each Agent with its Mood (the
 * Vitality reading's), Trust tier, load from its latest Vitality sample, and
 * the Operator's actions on it. The name opens the Agent view.
 */
const render = (_view: View, data: Sources): string => {
	const root = data["org-tree"] as OrgNode;
	const vitality = data.vitality as Readonly<Record<string, AgentVitality>>;
	const supervisors = agentsIn(root).filter((a) =>
		SUPERVISING_ROLES.has(a.definition.role),
	);
	return `<h1>Org</h1><ul class="org">${branch(root, vitality, supervisors)}</ul>`;
};

export const orgView: View = {
	name: "org",
	title: "Org",
	sources: ["org-tree", "vitality"],
	render,
};
