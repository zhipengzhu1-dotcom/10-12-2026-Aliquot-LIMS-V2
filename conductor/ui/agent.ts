import { DIMENSIONS, type ReviewRow } from "./csv.js";
import { escapeHtml } from "./markup.js";
import type { Sources, View } from "./views.js";

/** An Agent definition as `/api/org` sends it. */
export type Definition = {
	readonly id: string;
	readonly version: number;
	readonly name: string;
	readonly role: string;
	readonly supervisor_id?: string;
	readonly persona: {
		readonly voice: string;
		readonly traits: readonly string[];
		readonly quirk: string;
	};
	readonly charter: {
		readonly purpose: string;
		readonly responsibilities: readonly string[];
		readonly forbidden: readonly string[];
		readonly escalation: string;
	};
	readonly skills: readonly string[];
	readonly trust_tier: string;
	readonly revision_reason: string;
	readonly [field: string]: unknown;
};

/** One Agent of `/api/org`. */
export type AgentState = {
	readonly definition: Definition;
	readonly paused: boolean;
	readonly retired: boolean;
};

/** One Review of `/api/reviews` that counted toward the Agent's Merit. */
type CountedReview = ReviewRow & {
	readonly note: string;
	readonly merit: number;
};

/** One live Agent of `/api/vitality`. */
type AgentVitality = {
	readonly vitality: Readonly<Record<string, number>>;
	readonly sampled: boolean;
	readonly mood: string;
	readonly policy: Readonly<Record<string, boolean>>;
};

/** One live Agent of `/api/tiers`. */
type Standing = {
	readonly tier: string;
	readonly standing: {
		readonly merit?: number;
		readonly reviewedTasks: number;
	};
};

type Sequenced<T> = T & { readonly seq: number };

/** `/api/training`, each map an object keyed by id. */
type Training = {
	readonly notes: Readonly<
		Record<
			string,
			readonly Sequenced<{
				task_id: string;
				lesson: string;
				applies_to: readonly string[];
			}>[]
		>
	>;
	readonly coaching: Readonly<
		Record<string, readonly Sequenced<{ task_id?: string; note: string }>[]>
	>;
	readonly skills: Readonly<
		Record<string, readonly Sequenced<{ version: number; title: string }>[]>
	>;
};

type Room = {
	readonly id: string;
	readonly name: string;
	readonly membership:
		| { readonly tag: "Everyone" }
		| { readonly tag: "Listed"; readonly agents: readonly string[] };
};

/** The Agent's Room: a Listed Room whose only Agent is `agentId`. */
export const agentRoom = (
	rooms: Readonly<Record<string, Room>>,
	agentId: string,
): Room | undefined =>
	Object.values(rooms).find(
		({ membership: m }) =>
			m.tag === "Listed" && m.agents.length === 1 && m.agents[0] === agentId,
	);

const list = (items: readonly string[]) =>
	items.length === 0
		? `<p class="empty">None.</p>`
		: `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;

const section = (id: string, title: string, body: string) =>
	`<section id="${id}"><h2>${title}</h2>${body}</section>`;

const charter = ({ charter: c }: Definition) =>
	section(
		"charter",
		"Charter",
		[
			`<p>${escapeHtml(c.purpose)}</p>`,
			"<h3>Responsibilities</h3>",
			list(c.responsibilities.map(escapeHtml)),
			"<h3>Forbidden</h3>",
			list(c.forbidden.map(escapeHtml)),
			`<h3>Escalation</h3><p>${escapeHtml(c.escalation)}</p>`,
		].join(""),
	);

const persona = ({ persona: p }: Definition) =>
	section(
		"persona",
		"Persona",
		`<dl class="facts"><dt>Voice</dt><dd>${escapeHtml(p.voice)}</dd><dt>Traits</dt><dd>${escapeHtml(p.traits.join(", "))}</dd><dt>Quirk</dt><dd>${escapeHtml(p.quirk)}</dd></dl>`,
	);

const vitalitySection = (v: AgentVitality | undefined) =>
	section(
		"vitality",
		"Vitality",
		v === undefined
			? `<p class="empty">No Vitality: the Agent is Retired.</p>`
			: [
					`<p>Mood <span class="badge mood-${escapeHtml(v.mood)}">${escapeHtml(v.mood)}</span> from ${v.sampled ? "the latest sample" : "a sample computed now"}.</p>`,
					`<dl class="facts">${Object.entries(v.vitality)
						.filter(([, value]) => typeof value === "number")
						.map(
							([k, value]) =>
								`<dt>${escapeHtml(k)}</dt><dd>${value.toFixed(2)}</dd>`,
						)
						.join("")}</dl>`,
					"<h3>Policy</h3>",
					`<dl class="facts">${Object.entries(v.policy)
						.map(
							([k, on]) =>
								`<dt>${escapeHtml(k)}</dt><dd>${on ? "yes" : "no"}</dd>`,
						)
						.join("")}</dl>`,
				].join(""),
	);

/** One point per Review on a 0 to 3 scale, joined in Ledger order. */
const meritChart = (points: readonly number[]) => {
	const w = 240;
	const h = 60;
	const x = (i: number) =>
		points.length === 1 ? w / 2 : 6 + (i * (w - 12)) / (points.length - 1);
	const y = (merit: number) => h - 6 - (merit / 3) * (h - 12);
	const at = points.map((m, i) => [x(i).toFixed(1), y(m).toFixed(1)] as const);
	return `<svg class="merit" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Merit after each Review"><polyline points="${at.map((p) => p.join(",")).join(" ")}" />${at
		.map(
			([cx, cy], i) =>
				`<circle cx="${cx}" cy="${cy}" r="3"><title>${(points[i] ?? 0).toFixed(2)}</title></circle>`,
		)
		.join("")}</svg>`;
};

const meritSection = (
	t: Standing | undefined,
	reviews: readonly CountedReview[],
) => {
	if (t === undefined)
		return section(
			"merit",
			"Merit",
			`<p class="empty">No Merit: the Agent is Retired.</p>`,
		);
	const { merit, reviewedTasks } = t.standing;
	const rows = reviews.map(
		(r) =>
			`<tr><td>${escapeHtml(r.task_id)}</td><td>${escapeHtml(r.reviewer)}</td>${DIMENSIONS.map((s) => `<td>${r[s]}</td>`).join("")}<td>${r.merit.toFixed(2)}</td><td>${escapeHtml(r.note)}</td></tr>`,
	);
	return section(
		"merit",
		"Merit",
		[
			`<p>Trust tier <span class="badge tier">${escapeHtml(t.tier)}</span>, Merit ${merit === undefined ? "none" : merit.toFixed(2)} over ${reviewedTasks} reviewed Tasks.</p>`,
			reviews.length === 0
				? `<p class="empty">No Reviews yet.</p>`
				: `${meritChart(reviews.map((r) => r.merit))}<table class="rows"><thead><tr><th>Task</th><th>Reviewer</th>${DIMENSIONS.map((s) => `<th>${s.replace("_", " ")}</th>`).join("")}<th>Merit after</th><th>Note</th></tr></thead><tbody>${rows.join("")}</tbody></table>`,
		].join(""),
	);
};

/** The Reviews of `/api/reviews` that counted toward `id`'s Merit. */
const countedFor = (reviews: readonly ReviewRow[], id: string) =>
	reviews.filter(
		(r): r is CountedReview => r.assignee === id && r.merit !== null,
	);

const notesSection = (notes: Training["notes"][string] = []) =>
	section(
		"notes",
		"Memory notes",
		list(
			notes.map(
				(n) =>
					`seq ${n.seq}, on ${escapeHtml(n.task_id)} (applies to ${escapeHtml(n.applies_to.join(", "))}): ${escapeHtml(n.lesson)}`,
			),
		),
	);

const coachingSection = (coaching: Training["coaching"][string] = []) =>
	section(
		"coaching",
		"Coaching",
		list(
			coaching.map(
				(c) =>
					`seq ${c.seq}${c.task_id === undefined ? "" : `, on ${escapeHtml(c.task_id)}`}: ${escapeHtml(c.note)}`,
			),
		),
	);

const skillsSection = (d: Definition, published: Training["skills"]) =>
	section(
		"skills",
		"Skills",
		list(
			d.skills.map((id) => {
				const versions = published[id] ?? [];
				const latest = versions.at(-1);
				return latest === undefined
					? `<b>${escapeHtml(id)}</b>, not published`
					: `<b>${escapeHtml(id)}</b> version ${latest.version}: ${escapeHtml(latest.title)} (versions ${versions.map((v) => `${v.version} at seq ${v.seq}`).join(", ")})`;
			}),
		),
	);

const actionForm = (
	id: string,
	verb: string,
	body: unknown,
	fields: string,
	button: string,
	go?: string,
) =>
	`<form id="${id}" class="act" data-action="${verb}" data-body="${escapeHtml(JSON.stringify(body))}"${go === undefined ? "" : ` data-go="${escapeHtml(go)}"`}>${fields}<button>${button}</button></form>`;

const roomRoute = (roomId: string) =>
	`#/rooms?id=${encodeURIComponent(roomId)}`;

/** Go to the Agent's Room, opening it as the Operator the first time. */
const roomAction = (d: Definition, rooms: Readonly<Record<string, Room>>) => {
	const room = agentRoom(rooms, d.id);
	if (room !== undefined)
		return `<p><a id="room-${escapeHtml(d.id)}" href="${escapeHtml(roomRoute(room.id))}">Open ${escapeHtml(room.name)} (${escapeHtml(room.id)})</a></p>`;
	const opened = {
		id: `RM-${d.id.slice("A-".length)}`,
		name: `${d.name}'s Room`,
		purpose: `The Operator and ${d.name}`,
		membership: { tag: "Listed", agents: [d.id] },
	};
	return actionForm(
		`room-open-${escapeHtml(d.id)}`,
		"room-open",
		opened,
		"",
		`Open ${escapeHtml(opened.name)}`,
		roomRoute(opened.id),
	);
};

/**
 * An editor over the next version of the definition, written by the
 * Operator; the reason the Operator gives is its `revision_reason`.
 */
const revisionAction = (d: Definition) => {
	const { revision_reason: _, ...rest } = d;
	const next = {
		...rest,
		version: d.version + 1,
		revised_by: { tag: "Operator" },
	};
	const id = `revise-${escapeHtml(d.id)}`;
	return `<details id="${id}-panel"><summary>Author a Revision</summary>${actionForm(
		id,
		"revise",
		{},
		`<textarea id="${id}-definition" name="definition" data-json rows="20" aria-label="Definition">${escapeHtml(JSON.stringify(next, null, 2))}</textarea><input id="${id}-reason" name="definition.revision_reason" placeholder="Reason" aria-label="Reason for the Revision" required>`,
		"Post the Revision",
	)}</details>`;
};

const coachingAction = (d: Definition) => {
	const id = `coach-${escapeHtml(d.id)}`;
	return actionForm(
		id,
		"coach",
		{ agent_id: d.id },
		`<textarea id="${id}-note" name="note" placeholder="Coaching" aria-label="Coaching" required></textarea><input id="${id}-task" name="task_id" placeholder="Task, such as T-3 (optional)" aria-label="Task">`,
		"Give Coaching",
	);
};

const index = (agents: readonly AgentState[]) =>
	`<h1>Agents</h1>${list(
		agents.map(
			({ definition: d }) =>
				`<a href="#/agent?id=${encodeURIComponent(d.id)}">${escapeHtml(d.name)}</a> <span class="role">${escapeHtml(d.role)}</span>`,
		),
	)}`;

/**
 * One Agent: its Charter, Persona, Vitality with Mood and Policy, Merit after
 * each Review, Memory notes, Coaching and Skills, and the Operator's actions
 * on it. Without an Agent id, the list of Agents to choose from.
 */
const render = (_view: View, data: Sources): string => {
	const agents = (data.org as { agents: Readonly<Record<string, AgentState>> })
		.agents;
	const id = data.id as string | null;
	if (id === null) return index(Object.values(agents));
	const agent = agents[id];
	if (agent === undefined)
		return `<h1>Agent</h1><p role="alert">${escapeHtml(id)} is not in the Org.</p>${index(Object.values(agents))}`;
	const d = agent.definition;
	const training = data.training as Training;
	const rooms = (data.rooms as { rooms: Readonly<Record<string, Room>> }).rooms;
	return [
		`<h1>${escapeHtml(d.name)} <span class="role">${escapeHtml(d.role)}, ${escapeHtml(d.id)}, version ${d.version}</span>`,
		agent.paused ? ` <span class="badge paused">paused</span>` : "",
		agent.retired ? ` <span class="badge">Retired</span>` : "",
		"</h1>",
		`<div class="actions">${roomAction(d, rooms)}${coachingAction(d)}${revisionAction(d)}</div>`,
		charter(d),
		persona(d),
		vitalitySection(
			(data.vitality as Readonly<Record<string, AgentVitality>>)[id],
		),
		meritSection(
			(data.tiers as Readonly<Record<string, Standing>>)[id],
			countedFor(data.reviews as readonly ReviewRow[], id),
		),
		notesSection(training.notes[id]),
		coachingSection(training.coaching[id]),
		skillsSection(d, training.skills),
	].join("");
};

const SOURCES = [
	"org",
	"vitality",
	"tiers",
	"reviews",
	"training",
	"rooms",
] as const;

export const agentView: View = {
	name: "agent",
	title: "Agent",
	sources: SOURCES,
	render,
	load: async (params, get) => ({
		id: params.get("id"),
		...Object.fromEntries(
			await Promise.all(SOURCES.map(async (s) => [s, await get(s)] as const)),
		),
	}),
};
