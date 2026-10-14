import { DIMENSIONS, type Dimension } from "./csv.js";
import { type ActorJson, actorName, escapeHtml } from "./markup.js";
import type { Sources } from "./views.js";

const LEDGER = "ledger?limit=1000";

/** The routes the Flow view reads. The Event panel reads the Ledger's first page. */
export const FLOW_SOURCES = [
	"stages",
	"tasks",
	"runs",
	"artifacts",
	"lots",
	LEDGER,
] as const;

type Actor = ActorJson;

type Stage = {
	readonly number: number;
	readonly name: string;
	readonly script_id: string;
};

type Task = {
	readonly id: string;
	readonly title: string;
	readonly state: {
		readonly tag: string;
		readonly assignee?: string;
		readonly to?: Actor;
	};
	readonly tat_class: string;
	readonly inputs: readonly string[];
	readonly outputs: readonly string[];
};

type Run = {
	readonly started: { readonly script: { readonly id: string } };
	readonly seq: number;
	readonly task_id?: string;
};

type FlowEvent = {
	readonly seq: number;
	readonly kind: string;
	readonly actor: Actor;
	readonly task_id?: string;
	readonly causation_id?: number;
	readonly payload: Readonly<Record<string, unknown>>;
};

/** The Projection JSON of `FLOW_SOURCES`, as the Conductor serves it. */
type FlowJson = {
	readonly stages: readonly Stage[];
	readonly tasks: { readonly tasks: Readonly<Record<string, Task>> };
	readonly runs: { readonly runs: Readonly<Record<string, Run>> };
	readonly artifacts: {
		readonly productions: Readonly<
			Record<
				string,
				readonly { readonly record: { readonly lineage: readonly string[] } }[]
			>
		>;
	};
	/** Each SubmissionRecord's Lot, by Artifact id. */
	readonly lots: Readonly<Record<string, string>>;
	readonly ledger: {
		readonly events: readonly FlowEvent[];
		readonly next: number | null;
	};
};

const flowJson = (data: Sources) =>
	({
		stages: data.stages,
		tasks: data.tasks,
		runs: data.runs,
		artifacts: data.artifacts,
		lots: data.lots,
		ledger: data[LEDGER],
	}) as FlowJson;

/** Whom a Task goes to: a role, not an act, so the Operator here is unnamed. */
const actorText = (actor: Actor): string => actor.id ?? actor.tag;

/** The stage number of each Task's latest Run, from the Script it ran. */
const stagesOfTasks = (json: FlowJson): ReadonlyMap<string, number> => {
	const byScript = new Map(json.stages.map((s) => [s.script_id, s.number]));
	const latest = new Map<string, Run>();
	for (const run of Object.values(json.runs.runs)) {
		if (run.task_id === undefined) continue;
		const previous = latest.get(run.task_id);
		if (previous === undefined || run.seq > previous.seq) {
			latest.set(run.task_id, run);
		}
	}
	const stages = new Map<string, number>();
	for (const [task, run] of latest) {
		const stage = byScript.get(run.started.script.id);
		if (stage !== undefined) stages.set(task, stage);
	}
	return stages;
};

/**
 * The Lots of a Task: those of the SubmissionRecords in the Lineage of its
 * input and output Artifacts, or made from one of them, as a record is made
 * from its Submission Form.
 */
const lotsOf = (json: FlowJson, task: Task): ReadonlySet<string> => {
	const lineage = (id: string) =>
		(json.artifacts.productions[id] ?? []).flatMap((p) => p.record.lineage);
	const reached = new Set<string>();
	const stack = [...task.inputs, ...task.outputs];
	for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
		if (reached.has(id)) continue;
		reached.add(id);
		stack.push(...lineage(id));
	}
	const lots = new Set<string>();
	for (const [record, lot] of Object.entries(json.lots)) {
		if (reached.has(record) || lineage(record).some((id) => reached.has(id))) {
			lots.add(lot);
		}
	}
	return lots;
};

/** `#/flow` with the current query changed: a null value drops that key. */
const flowHref = (
	params: URLSearchParams,
	changes: Readonly<Record<string, string | null>>,
): string => {
	const next = new URLSearchParams(params);
	for (const [key, value] of Object.entries(changes)) {
		if (value === null) next.delete(key);
		else next.set(key, value);
	}
	const query = next.toString();
	return query === "" ? "#/flow" : `#/flow?${query}`;
};

const card = (task: Task, params: URLSearchParams): string => {
	const open = params.get("open") === task.id;
	const { state } = task;
	const who =
		state.assignee ??
		(state.to === undefined ? "unassigned" : `to ${actorText(state.to)}`);
	return `<li><a class="card" href="${escapeHtml(flowHref(params, { open: task.id }))}" data-task="${escapeHtml(task.id)}"${open ? ' aria-current="true"' : ""}>
<span class="card-head"><b>${escapeHtml(task.id)}</b> <span class="state" data-state="${escapeHtml(state.tag)}">${escapeHtml(state.tag)}</span></span>
<span class="card-title">${escapeHtml(task.title)}</span>
<span class="card-meta">${escapeHtml(who)} · ${escapeHtml(task.tat_class)}</span>
</a></li>`;
};

const lane = (
	key: string,
	title: string,
	tasks: readonly Task[],
	params: URLSearchParams,
): string =>
	`<section class="lane" data-lane="${escapeHtml(key)}"><h2>${escapeHtml(title)} <span class="count">${tasks.length}</span></h2>${
		tasks.length === 0
			? `<p class="empty">No Tasks</p>`
			: `<ol class="cards">${tasks.map((t) => card(t, params)).join("")}</ol>`
	}</section>`;

const filterForm = (json: FlowJson, params: URLSearchParams): string => {
	const lot = params.get("lot") ?? "";
	const lots = [...new Set(Object.values(json.lots))].sort();
	const option = (value: string, label: string) =>
		`<option value="${escapeHtml(value)}"${value === lot ? " selected" : ""}>${escapeHtml(label)}</option>`;
	return `<form class="filter" data-route="#/flow">
<label>Task <input name="task" value="${escapeHtml(params.get("task") ?? "")}" placeholder="T-1" size="8"></label>
<label>Lot <select name="lot">${option("", "Any Lot")}${lots.map((l) => option(l, l)).join("")}</select></label>
<button type="submit">Filter</button>
<a href="#/flow">Clear</a>
</form>`;
};

type Payloads = {
	readonly TaskProposed: { readonly title: string };
	readonly TaskAssigned: { readonly assignee: string };
	readonly TaskHandedOff: { readonly from: string; readonly to: string };
	readonly TaskCompleted: { readonly review: { readonly tag: string } };
	readonly TaskFailed: { readonly reason: string };
	readonly TaskEscalated: { readonly to: Actor };
	readonly RunStarted: {
		readonly run_id: string;
		readonly script: { readonly id: string; readonly version: number };
	};
	readonly RunFinished: { readonly id: string; readonly exit_code: number };
	readonly ArtifactStored: {
		readonly artifact_type: string;
		readonly filename?: string;
	};
	readonly EvaluationRecorded: {
		readonly eval_id: string;
		readonly score: number;
		readonly passed: boolean;
	};
	readonly ReviewRecorded: Readonly<Record<Dimension, number>>;
};

/** What a row says about its Event beyond the kind and the actor. */
const DETAILS: { readonly [K in keyof Payloads]: (p: Payloads[K]) => string } =
	{
		TaskProposed: (p) => p.title,
		TaskAssigned: (p) => `to ${p.assignee}`,
		TaskHandedOff: (p) => `${p.from} to ${p.to}`,
		TaskCompleted: (p) => `review ${p.review.tag}`,
		TaskFailed: (p) => p.reason,
		TaskEscalated: (p) => `to ${actorText(p.to)}`,
		RunStarted: (p) => `${p.run_id} ${p.script.id} v${p.script.version}`,
		RunFinished: (p) => `${p.id} exit ${p.exit_code}`,
		ArtifactStored: (p) => `${p.filename ?? ""} ${p.artifact_type}`.trim(),
		EvaluationRecorded: (p) =>
			`${p.eval_id} score ${p.score.toFixed(3)}, ${p.passed ? "passed" : "failed"}`,
		ReviewRecorded: (p) => DIMENSIONS.map((d) => p[d]).join(" "),
	};

const detailOf = (event: FlowEvent): string =>
	Object.hasOwn(DETAILS, event.kind)
		? (DETAILS[event.kind as keyof Payloads] as (p: unknown) => string)(
				event.payload,
			)
		: "";

/** Each row's height, so an arrow's ends come from row indexes alone. */
export const ROW_PX = 28;
const GUTTER_PX = 56;

const rowMiddle = (index: number): number => index * ROW_PX + ROW_PX / 2;

const arrow = (from: FlowEvent, fromRow: number, toRow: number): string => {
	const x = GUTTER_PX - 2;
	const bend = Math.min(GUTTER_PX - 8, 8 + 6 * Math.abs(fromRow - toRow));
	const y1 = rowMiddle(fromRow);
	const y2 = rowMiddle(toRow);
	return `<path data-from="${from.seq}" data-to="${from.causation_id}" d="M ${x} ${y1} C ${x - bend} ${y1} ${x - bend} ${y2} ${x} ${y2}" marker-end="url(#cause)"/>`;
};

const carries = (event: FlowEvent, task: string) =>
	event.task_id === task || event.payload.task_id === task;

/**
 * A Task's Events in seq order, with each Event's cause from outside the
 * Task as its own row, and an arrow from each Event to the row of its cause.
 */
const eventPanel = (
	json: FlowJson,
	task: string,
	params: URLSearchParams,
): string => {
	const { events, next } = json.ledger;
	const bySeq = new Map(events.map((e) => [e.seq, e]));
	const own = events.filter((e) => carries(e, task));
	const ownSeqs = new Set(own.map((e) => e.seq));
	const outside = new Map<number, FlowEvent>();
	for (const { causation_id } of own) {
		const cause =
			causation_id === undefined ? undefined : bySeq.get(causation_id);
		if (cause !== undefined && !ownSeqs.has(cause.seq)) {
			outside.set(cause.seq, cause);
		}
	}
	const rows = [...own, ...outside.values()].sort((a, b) => a.seq - b.seq);
	const rowOf = new Map(rows.map((e, i) => [e.seq, i]));
	const arrows = rows.flatMap((e, i) => {
		const to =
			e.causation_id === undefined ? undefined : rowOf.get(e.causation_id);
		return to === undefined ? [] : [arrow(e, i, to)];
	});
	const close = `<a href="${escapeHtml(flowHref(params, { open: null }))}">Close</a>`;
	const more =
		next === null
			? ""
			: `<p class="note">The panel reads the Ledger to seq ${next - 1}; later Events are not shown.</p>`;
	if (own.length === 0) {
		return `<aside class="panel"><h2>${escapeHtml(task)} ${close}</h2><p class="empty">No Event carries ${escapeHtml(task)}.</p>${more}</aside>`;
	}
	const height = rows.length * ROW_PX;
	const row = (e: FlowEvent) =>
		`<li data-seq="${e.seq}"${ownSeqs.has(e.seq) ? "" : ' class="outside"'}><span class="seq">${e.seq}</span> <span class="kind">${escapeHtml(e.kind)}</span> <span class="actor">${escapeHtml(actorName(e.actor))}</span> <span class="detail">${escapeHtml(detailOf(e))}</span>${
			e.causation_id === undefined
				? ""
				: ` <span class="cause">cause ${e.causation_id}</span>`
		}</li>`;
	return `<aside class="panel"><h2>${escapeHtml(task)} Events ${close}</h2>
<div class="events" style="--row: ${ROW_PX}px">
<svg class="arrows" width="${GUTTER_PX}" height="${height}" viewBox="0 0 ${GUTTER_PX} ${height}" aria-hidden="true">
<defs><marker id="cause" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 6 3 L 0 6 z"/></marker></defs>
${arrows.join("\n")}
</svg>
<ol>${rows.map(row).join("")}</ol>
</div>${more}</aside>`;
};

/**
 * The Flow view: one swimlane per stage, by the Script of each Task's latest
 * Run, and one for Tasks in no stage. The query filters by `task` id or by
 * `lot`, and `open` names the Task whose Event panel shows.
 */
export const flowPage = (data: Sources, params: URLSearchParams): string => {
	const json = flowJson(data);
	const stageOf = stagesOfTasks(json);
	const task = params.get("task");
	const lot = params.get("lot");
	const shown = Object.values(json.tasks.tasks).filter(
		(t) =>
			(task === null || t.id === task) &&
			(lot === null || lotsOf(json, t).has(lot)),
	);
	const lanes = [
		...json.stages.map((s) =>
			lane(
				String(s.number),
				`${s.number} ${s.name}`,
				shown.filter((t) => stageOf.get(t.id) === s.number),
				params,
			),
		),
		lane(
			"none",
			"No stage",
			shown.filter((t) => !stageOf.has(t.id)),
			params,
		),
	];
	const open = params.get("open");
	return `<h1>Flow</h1>
${filterForm(json, params)}
<div class="flow${open === null ? "" : " with-panel"}">
<div class="lanes">${lanes.join("\n")}</div>
${open === null ? "" : eventPanel(json, open, params)}
</div>`;
};
