# Aliquot LIMS design overview

This document describes the agent society that will run a regulated pharmaceutical contract testing lab. Read it first. The decisions it rests on are in `docs/adr/`, the vocabulary is in `GLOSSARY.md`, and the mechanics of Mood and Merit are in `docs/design/vitality-and-merit.md`.

## Vision

A small society of Agents does the paperwork and the computation of the lab, from the Submission Form to the Report of Analysis. Each Agent has a Charter, a Persona, and a measured Vitality that changes what it may do. Agents earn Trust tiers through Reviews, train each other through Skills and Revisions, and rewrite their own Scripts in a Sandbox. The Operator sees every Agent's Mood and Merit live, and decides every Gate. Nothing leaves the Sandbox without the Operator's signature. Every action is an Event in one hash-chained Ledger, so the lab can show an inspector who did what, when, and why. The first slice runs on synthetic lab work. Real data connects only after the Operator has watched the society work.

## What exists today

The repository holds this design, the agent tooling configuration in `CLAUDE.md` and `docs/agents/`, and an untracked `Templates/` folder. The folder has five files, 188 KB in total. They are real records of the lab and carry Client names, contact names, Lot numbers, and Product Codes. ADR-0009 keeps them out of git. The synthetic generator copies their shape only.

| Template | What it is | Shape to copy |
|---|---|---|
| Sample receiving log (xlsx) | The Receiving Log, one yearly sheet plus one sheet per day | Columns #, Rec. DATE, Rec. Time, Product Code, PRODUCT NAME, TYPE, LOT#, CLIENT, EXP DATE, and QTY RECD. One row per container received. |
| Sample submission form (docx) | The Client-facing Submission Form | A header table for submitter, bill-to, and report-to. An 11 by 8 Sample table with number, description, Sample Type, TAT code, Lot, and Product Code. A lab-use-only receipt block with date, time, and received-by initials. |
| Report of Analysis, finished product (xlsx) | A Report of Analysis with static values | Letterhead, Client block, a metadata block (Lab Reference, product, Lot, Product Code, Product Type, document revision, date and time received, received by), a results table, and a signature area. |
| Report of Analysis, raw material (xlsx) | A heavy metals Report of Analysis | The same layout, but the metadata cells are formulas that read the Receiving Log workbook by external reference, such as `'[1]2026'!$L$22`. This link is how the lab traces a report to its receipt today. |
| Analyst worksheet (xlsx) | A Result Worksheet for average capsule weight | Columns #, Code, Name, Status, Lot#, weight of 20 capsules, weight taken, and average weight computed by `=F/20` style formulas. A Verifier recomputes these. |

None of the five files contains VBA. The macro workbooks, the SQL database, and the PDF reports and forms exist at the lab but are not yet available.

## The ten data shapes

Everything in the system derives from ten shapes. The Ledger holds Events. Every other shape is either the payload of an Event or a Projection computed from Events. The Ledger, its reducers, and these types are built before any Agent logic.

### 1. Event

An Event is one entry in the Ledger. Events are numbered, append-only, and hash-chained, so a changed or deleted Event breaks the chain. `kind` is a closed union. A Projection is a reducer over Event kinds, so an illegal state change has no Event that can express it.

```ts
type Actor = { tag: "Agent"; id: AgentId } | { tag: "Operator" };
type EventActor = Actor | { tag: "Conductor" };

type Event = {
	seq: Seq;
	ts: IsoTime;
	actor: EventActor;
	task_id?: TaskId;
	causation_id?: Seq;
	prev_hash: Sha256;
	hash: Sha256;
} & EventBody;

type EventBody =
	| { kind: "AgentRecruited"; payload: AgentDefinition }
	| { kind: "AgentDefinitionRevised"; payload: { definition: AgentDefinition } }
	| { kind: "TaskAssigned"; payload: { task_id: TaskId; assignee: AgentId } }
	| { kind: "GateDecided"; payload: GateDecision }
	| { kind: "VitalitySampled"; payload: Vitality };
	// and the rest of the initial set below
```

The Ledger keeps every Projection: Org, Tasks, Gates, Rooms, Trust tier, work, Scripts, Runs, and Artifacts. It builds them from its Events once when it opens (ADR-0001), and it advances each one by every Event it appends. A writer and a read-only opener build the same Projections from the same Events. Guards and commands read these Projections. No module outside the Ledger folds the Events.

Before the Ledger writes an Event, it advances the Projections by it and runs every guard. Each guard reads the Projections as they stood before the Event. A Projection that cannot apply the Event, or a guard, returns a reason. The Ledger then refuses the Event with `<Kind> refused: <reason>` and writes nothing. The guards always run on an append, and no option turns one off. Opening a Ledger does not run them again ([ADR-0012](../adr/0012-opening-a-ledger-does-not-rerun-the-guards.md)), so a Ledger written under older rules still opens. Only a stored Event that a Projection cannot apply makes the Ledger corrupt: opening it fails and names the `seq` and the reason. `ledger verify` reads only the hash chain, so it still reports on such a Ledger.

The Ledger stores its Events in SQLite, in `<home>/ledger.sqlite`, with one writer (ADR-0008). Tests use in-memory storage instead. Numbering, the hash chain, the guards, and the Projections all live in the Ledger, above the storage, so both storages run the same rules. SQLite stays the production storage, and the tests of persistence, the writer lock, and the chain on disk run on it.

The actor `Conductor` authors only the tier Revisions that Merit and Gates require (ADR-0011). The Ledger refuses any other Event it authors. Only an Event's `actor` and a definition's `revised_by` can name it, so no payload can make the Conductor a reviewer, an escalation target, or a Skill author. No command line acts as the Conductor.

The initial kinds are `AgentRecruited`, `AgentDefinitionRevised`, `AgentPaused`, `AgentResumed`, `AgentRetired`, `TaskProposed`, `TaskAssigned`, `TaskStarted`, `TaskHandedOff`, `TaskCompleted`, `TaskFailed`, `TaskEscalated`, `RoomOpened`, `MessageSent`, `HelpRequested`, `ScriptRegistered`, `ScriptRevised`, `RunStarted`, `RunFinished`, `ArtifactStored`, `EvaluationRecorded`, `ReviewRecorded`, `VitalitySampled`, `RestOrdered`, `GateRequested`, `GateDecided`, `HumanCoached`, `MemoryNoted`, and `SkillPublished`.

### 2. Agent definition

An Agent definition is a versioned document. A change is a Revision Event, never an edit in place. `trust_tier` always equals the projected Trust tier: the Ledger refuses a Recruitment or a Revision that records any other tier, whoever authors it.

One module, the Org lifecycle (`org/lifecycle.ts`), appends every Agent Event that the Operator or an Agent causes: it recruits, revises, pauses, resumes, and retires an Agent, and the seed recruits the starting roster through it. Each verb returns the Agent as the Event left it and the seq it appended. Each verb names the Event's cause in `causation_id`: the Agent's previous Org Event, which the Org Projection keeps, so a Recruitment names none. A caller names a cause only when it lies outside the Org. A retirement's reason defaults to the one in its `RetireAgent` Gate's payload. The Conductor's tier Revisions stay Ledger follow-ons (ADR-0011).

```ts
type Role = "Director" | "Steward" | "Auditor" | "Supervisor" | "Specialist" | "Developer" | "Tester";

type AgentDefinition = {
	id: AgentId;
	version: number;
	name: string;
	role: Role;
	supervisor_id?: AgentId;
	persona: { voice: string; traits: string[]; quirk: string };
	charter: { purpose: string; responsibilities: string[]; forbidden: Action[]; escalation: string };
	tools: ToolName[];
	skills: SkillId[];
	memory_notes_ref: MemoryNotesRef;
	model: ModelName;
	capacity: number;
	trust_tier: TrustTier;
	revised_by: EventActor;
	revision_reason: string;
};
```

### 3. Task

A Task moves through a state machine. A Hand-off is a transition back to `Assigned` with a new assignee, not a state of its own. A Task that the Trust tier rules do not select for Review goes from `InProgress` straight to `Done`. A `Done` Task keeps its assignee, so the Task Projection alone says whose work a Review scores.

One module, the Task lifecycle (`task/lifecycle.ts`), appends every Task Event: it proposes, assigns, starts, hands off, escalates, completes, reviews, and fails a Task, and blocks one on a Gate it requests. Each verb mints the ids it needs from the Projections and returns the new Task and the seq it appended. Each verb also names the Event's cause in `causation_id`, from the Projections. The cause is the Task's previous Event, which the Task Projection keeps, or for a completion after Review the reviewer's `ReviewRecorded`. A caller names a cause only when it lies outside the Task, as the stage 1 tracer names the `EvaluationRecorded` it completes a Task on. A verb that the Projections already refuse, such as a Hand-off of a Task that is not `InProgress`, is refused before the verb builds an Event, in the same words. Completing a Task decides its Review: the verb asks the Trust tier whether the sample picks the Task. If it does, the Task goes `UnderReview` with the named reviewer, and a completion that names none is refused as sampled for Review. If it does not, the Review is skipped, and a named reviewer is unused. So `task complete <id>` takes only `--reviewer` and `--output`, and on a Task `UnderReview` it completes the Task after Review.

```ts
type TaskState =
	| { tag: "Proposed" }
	| { tag: "Assigned"; assignee: AgentId }
	| { tag: "InProgress"; assignee: AgentId }
	| { tag: "UnderReview"; assignee: AgentId; reviewer: Actor }
	| { tag: "Blocked"; assignee: AgentId; gate: GateId }
	| { tag: "Escalated"; to: Actor }
	| { tag: "Failed"; reason: string }
	| { tag: "Done"; assignee: AgentId };

type TatClass = "Regular" | "Rush1to2Days" | "Rush3to4Days";

type Task = {
	id: TaskId;
	title: string;
	goal: string;
	inputs: ArtifactId[];
	outputs: ArtifactId[];
	state: TaskState;
	rubric_id: RubricId;
	priority: number;
	tat_class: TatClass;
	parent_task?: TaskId;
};
```

### 4. Artifact

An Artifact is a content-addressed file. Its Lineage lists the Artifacts it was made from. In the toy workflow, Lineage does the job that external-reference formulas do in the lab's workbooks today.

```ts
type ArtifactType =
	| "SubmissionForm" | "ReceivingLogRow" | "WorkOrder"
	| "ResultWorksheet" | "VerificationRecord" | "ReportOfAnalysis" | "Other";

type Artifact = {
	id: ArtifactId;
	sha256: Sha256;
	media_type: string;
	artifact_type: ArtifactType;
	produced_by: { tag: "Run"; id: RunId } | { tag: "Operator" };
	lineage: ArtifactId[];
};
```

### 5. Script and Run

A Script is a versioned Python program that runs only in the Sandbox. A new version replaces the previous one only after it handles every Fixture. A Run is one execution.

```ts
type Script = {
	id: ScriptId;
	version: number;
	name: string;
	owner_agent: AgentId;
	input_types: ArtifactType[];
	output_types: ArtifactType[];
	entrypoint: string;
	fixtures: ArtifactId[];
	image_digest: Sha256;
};

type Run = {
	id: RunId;
	script: { id: ScriptId; version: number };
	inputs: ArtifactId[];
	outputs: ArtifactId[];
	exit_code: number;
	stdout_ref: ArtifactId;
	stderr_ref: ArtifactId;
	duration_ms: number;
	eval_id?: EvaluationId;
};
```

### 6. Vitality, Mood, and Policy

Vitality is measured from the Ledger, never reported by the Agent. The Conductor samples it once per Turn. Mood and Policy are pure functions.

```ts
type Vitality = {
	agent: AgentId;
	load: number;
	fatigue: number;
	friction: number;
	confidence: number;
	morale: number;
};

type Mood = "fresh" | "focused" | "strained" | "overloaded" | "discouraged" | "resting";

type Policy = {
	mayAcceptTasks: boolean;
	mayOfferHelp: boolean;
	mustHandOff: boolean;
	mustRequestHelp: boolean;
	mustNameBlocker: boolean;
	schedulable: boolean;
};

declare function moodOf(v: Vitality, restInEffect: boolean, hasTaskInProgress: boolean): Mood;
declare function policyOf(m: Mood): Policy;
```

One module, the Vitality lifecycle (`vitality/lifecycle.ts`), appends every Vitality Event. It samples a live Agent's Vitality from the Ledger and returns the sample and the seq it appended. A sample names no cause, because the end of a Turn lies outside Vitality. It orders Rest for an Agent or ends it, and returns the seq. A Rest order names the Agent's previous `VitalitySampled` or `RestOrdered` as its cause: the Vitality it acts on, or the Rest it ends. A Rest order that the Rest guard would refuse is refused before the verb builds an Event, in the same words.

### 7. Merit and Trust tier

A Review scores a completed Task on five dimensions. Merit is the rolling mean. The Trust tier is a Projection of Merit, tenure and approved `PromoteToMentor` Gates. One approved Gate covers one Promotion to Mentor.

The Trust tier Projection is the only place that decides the tier. It answers three questions: the Agent's tier, whether a Revision may record a given tier, and whether a Task must have a Review. After every append, in the same transaction, the Ledger appends one follow-on `AgentDefinitionRevised` for each live Agent whose `trust_tier` differs from its projected tier (ADR-0011). Each follow-on Revision has the actor `Conductor` as its actor and its `revised_by`, names the Event that caused it in `causation_id`, and gives the Merit or Gate change as its `revision_reason`. A refused follow-on refuses its cause too. So `org tree` prints the tier that Review sampling uses.

A Ledger written before ADR-0011 has definitions whose `trust_tier` lags the projected tier. When the Ledger opens for writing, before any caller appends, it appends one catch-up `AgentDefinitionRevised` by the `Conductor` for each Agent whose `trust_tier` lags, Retired Agents included, in its own transaction. A refused append after it leaves the catch-up in place. Each catch-up Revision names in `causation_id` the Event where the projected tier last changed to the tier it records: the Review, the `GateDecided`, or the Recruitment for an Agent that has held Probation since. Its `revision_reason` gives the Merit or Gate change at that Event and says that the Revision is recorded late. The projected tier changes only at a Review or a `GateDecided`, so the same rule decides the cause of a follow-on and of a late Revision: the Ledger refuses a Conductor Revision that names any Event other than the one where the projected tier last changed to the tier it records, and the refusal names that Event. A Ledger already caught up, or opened read-only, appends nothing.

```ts
type Score = 0 | 1 | 2 | 3;

type Review = {
	task_id: TaskId;
	reviewer: Actor;
	quality: Score;
	traceability: Score;
	boundary_adherence: Score;
	collaboration: Score;
	timeliness: Score;
	note: string;
};

type TrustTier = "Probation" | "Trusted" | "Senior" | "Mentor";
```

### 8. Gate

A Gate is a request for an Operator decision. Only the Operator emits `GateDecided`. The decision is the electronic signature record. The Ledger stamps `decided_at` with the decision Event's own `ts`, so the caller supplies no time and the signature time is the time the decision is recorded (ADR-0006).

One module, the Gate lifecycle (`gate/lifecycle.ts`), appends every Gate Event: it requests a Gate under the next free gate id and records the Operator's decision on it, and each verb returns the Gate and the seq it appended. A decision names the Gate's request as its `causation_id` and carries the payload hash the Operator checked, which the Ledger refuses, writing nothing, when it is not the stored one. A request that blocks a Task comes only from the Task lifecycle's `block`, which names the Task's previous Event as the request's cause. Biome refuses a call to the Gate lifecycle's `requestGateForTask` in any other module.

```ts
type GateKind = "Deploy" | "WriteSystemOfRecord" | "ExternalMessage" | "RetireAgent" | "PromoteToMentor";

type GateState = "Open" | "Approved" | "Rejected" | "Expired";

type GateDecision = {
	gate_id: GateId;
	decided_by: { tag: "Operator" };
	decided_at: IsoTime;
	payload_hash: Sha256;
	meaning: "approve" | "reject";
	reason: string;
};
```

### 9. Skill and Memory note

A Skill is a versioned Markdown procedure that any Agent can be granted. A Memory note is a private lesson that one Agent reads before similar Tasks. Both are Events, so Training is auditable.

```ts
type Skill = { id: SkillId; version: number; title: string; body_md: string; author: Actor };

type MemoryNote = { agent: AgentId; task_id: TaskId; lesson: string; applies_to: string[] };
```

### 10. Room and Message

A Room is where Agents talk (ADR-0010). The Lab Room, `RM-lab`, admits every recruited Agent that is not retired. Any Agent may open a `Listed` Room that names itself. The Operator is a member of every Room. A Message is a `MessageSent` Event projected for its reader. A reply names the Message it answers through the envelope's `causation_id`, which must be a Message in the same Room. One membership rule decides both who may say a Message and who may read a Room's history. One module, the Room lifecycle (`room/lifecycle.ts`), appends every Room Event. It opens a Room, which the Room's `opened_by` appends, and says a Message, returning the Room or the Message and the seq it appended. Neither Event names a cause, except a reply, whose `causation_id` is the Message it answers.

```ts
type RoomId = `RM-${string}`;

type Membership = { tag: "Everyone" } | { tag: "Listed"; agents: AgentId[] };

type Room = { id: RoomId; name: string; purpose: string; membership: Membership; opened_by: Actor; task_id?: TaskId };

// Events: { kind: "RoomOpened"; payload: { room: Room } } and { kind: "MessageSent"; payload: { room_id: RoomId; body: string } }
type Message = { seq: Seq; ts: IsoTime; actor: Actor; room_id: RoomId; body: string; causation_id?: Seq };
```

## Runtime topology

Five parts run on the Operator's Mac. Cloudflare carries only the Operator's browser traffic.

```
 Operator (browser)                     Anthropic API
      |  https, Cloudflare Access             ^
      v                                       | subscription login via `claude` CLI
 Cloudflare Tunnel  ---->  Conductor (TS) ----+
                            |  |  |
             SQLite ledger  |  |  +--> Agent turn = Agent SDK query() + MCP tools + hooks
             blob store ----+  |
                               +--> Docker sandbox: Python scripts, toy LIMS SQLite, artifacts
```

**Conductor.** The Conductor is a TypeScript process on Node. It is the only writer to the SQLite Ledger. It schedules Turns, enforces Policy, serves the interface, and streams Ledger Events over SSE. Each Turn is one `query()` call from `@anthropic-ai/claude-agent-sdk`. The Agent's tools are an in-process MCP server that exposes Ledger-backed verbs: `read_tasks`, `send_message`, `read_room`, `open_room`, `request_help`, `hand_off`, `run_script`, `propose_revision`, `request_gate`, `note_memory`, and `publish_skill`. A `PreToolUse` hook records every tool call in the Ledger and blocks the Charter's forbidden actions. The hook does this job because allow rules bypass `canUseTool`. `maxTurns` and `maxBudgetUsd` cap each Turn. The `modelUsage` field of each result feeds fatigue.

**Authentication.** The Agent SDK spawns the `claude` CLI, which uses the subscription login when no API key is set. The SDK documentation, read on 2026-10-12 for SDK 0.3.296, lists subscription OAuth last in precedence. It says `claude setup-token` and `CLAUDE_CODE_OAUTH_TOKEN` authenticate scripts with a subscription. It also says third-party developers may not offer claude.ai login in products built on the SDK, and it says nothing about personal internal tools. Authentication is one module, so an API key with `maxBudgetUsd` can replace it. Two Turns run at the same time to start. The Energy budget is the subscription's 5-hour window.

**Sandbox.** One Docker image holds `python:3.13-slim`, openpyxl, python-docx, pdfplumber, reportlab, and sqlite3. Scripts and inputs mount read-only. Each Run writes to a fresh output directory. Containers run with `--network none`, `--cap-drop ALL`, and CPU, memory, and time limits. An Agent changes a Script by writing a new version into the Sandbox repository and running its Fixtures.

**Toy System of record.** A SQLite database in the Sandbox stands in for the lab's LIMS tables (samples, lots, work orders, results, and reports). It is synthetic, so it is not a System of record and Agents write to it without a Gate. Each data source declares in configuration whether it is a System of record. Connecting a real database turns the `WriteSystemOfRecord` Gate on by configuration, with no code change.

**Interface.** The Conductor serves a single-page application. Cloudflare Tunnel exposes it at `agents.nitrolims-demo.com`, and Cloudflare Access admits only the Operator's email. We prefer a subdomain to the path `app.nitrolims-demo.com/development`. A path would route through whatever serves `app.` today and would share its cookies.

**Cost.** Everything on Cloudflare stays on the free tier, which covers Tunnel, Access for up to 50 users, and DNS. There is no Workers paid plan, no Containers, and no R2 beyond the free tier. The Ledger and the Artifact store stay on the Mac.

**Data boundary.** Real lab documents never leave the Mac, except as text inside prompts sent to Anthropic. The Operator must accept this before slice 3 or replace the model with a local one.

## The starting roster

Slice 1 starts with eight Agents. Their names are invented. Developer and Tester join in slice 2. Any other Recruitment is a Steward proposal.

| Name | Role | Reports to | Purpose | Forbidden actions | Persona |
|---|---|---|---|---|---|
| Odile | Director | Operator | Turns the lab's goals into Tasks for Supervisors, accepts or declines team-level proposals, and reports to the Operator weekly | Run Scripts, touch Artifacts directly, decide Gates | A calm planner who asks "what is the lab waiting on?" |
| Mabel | Steward | Operator | Watches Vitality, aggregates Merit, holds the Energy budget, orders Rest, proposes Recruitment and Retirement, and writes Revisions that Train the society | Assign lab work, accept its own proposals | Warm, and notices who has gone quiet |
| Thorne | Auditor | Operator, independent of the Director | Verifies the hash chain, checks that every required Gate was used, samples Reviews, and flags boundary violations and ALCOA+ gaps | Do lab work. Only the Operator may revise its definition. | Dry, precise, and unimpressed by speed |
| Pia | Supervisor, intake and Work Orders | Director | Owns the stages from Submission Form to Receiving Log to Work Order, and reviews the Specialists on them | Touch results or Reports of Analysis | Brisk, and likes checklists |
| Anselm | Supervisor, results and Verification | Director | Owns the stages from Result Worksheet to Verification to Report of Analysis, and makes sure a different Agent verifies each Result Worksheet | Verify a calculation from its own team's Run | Patient, and recomputes everything |
| Rin | Specialist, office documents | Supervisors | Reads and writes xlsx and docx, knows the template layouts, and later reads VBA | Run code outside the Sandbox | Tidy, and mildly obsessive about merged cells |
| Ines | Specialist, PDF | Supervisors | Extracts text from PDFs and renders PDFs, including supplier certificates, Submission Forms, and Reports of Analysis | Run code outside the Sandbox | Curious, and flags unreadable scans |
| Bram | Specialist, SQL | Supervisors | Reads and writes the toy LIMS database, writes migrations, and writes Lineage queries | Write to a System of record without a Gate | Blunt, and hates nulls |

## The toy workflow

A synthetic generator invents Clients, products, Lots, and dates in the shape of the real templates. Each stage is a Script with Fixtures. Agents supervise the Runs, evaluate the outputs, and write new Script versions when an Evaluation fails. The Auditor samples the Lineage of each Report of Analysis back to its Submission Form.

| Stage | Input Artifact | Script | Output Artifact | Evaluation |
|---|---|---|---|---|
| 1. Submission | Synthetic Submission Form (docx) | `parse_submission` | Structured submission record | Every required field is present and every TAT code is valid. |
| 2. Receipt | Submission record | `log_receipt` | Receiving Log row (xlsx) and toy LIMS Sample rows | One row per container, and the Lot and Product Code match the Submission Form. |
| 3. Work Order | Sample rows | `create_work_order` | Work Order (xlsx) with Tests and a due date from TAT | The due date arithmetic is correct and every Sample has Tests. |
| 4. Results | Work Order and synthetic weighings | `compute_results` | Result Worksheet (xlsx with `=F/20` style formulas) | The formulas are present and agree with the values. |
| 5. Verification | Result Worksheet | `verify_results`, run by a different Agent than stage 4 | Verification Record | The independent recomputation agrees within tolerance. |
| 6. Report | Verification Record and metadata | `render_roa` | Report of Analysis (xlsx and PDF) | Every metadata field traces to the Receiving Log row, and no field is typed by hand. |

The stage 1 lifecycle (`stage1/lifecycle.ts`) appends every `EvaluationRecorded`. It mints the Evaluation id from the Projections and names the `RunFinished` of the Run it scores as the Event's cause. It refuses an Evaluation of a Run that has not finished, or for a Task that is no longer live, before it builds the Event, in the words of the stage 1 guard. The stage 1 tracer appends nothing itself: it calls the Sandbox, the Task lifecycle, and this lifecycle.

## The Operator's interface

Every view is a Projection of the Ledger and updates live over SSE. No view stores its own state.

| View | Shows | Operator actions |
|---|---|---|
| Org | A tree of Agents by supervisor, with a Mood badge, Trust tier, and load bar for each | Pause, resume, reassign, retire (opens a `RetireAgent` Gate), open an Agent |
| Flow | Tasks in one swimlane per stage, with causation arrows between Events, filtered by Task or Lot | Open a Task and read its Events |
| Agent | Charter, Persona, current Vitality and Mood, Merit history, Memory notes, and Skills | Open the Agent's Room, a Room whose only listed member is that Agent; author a Revision; give Coaching |
| Rooms | Every Room, private ones included, with its Messages live | Say a Message in any Room, open a Room |
| Scripts | Each Script with its versions, owner, Fixtures, and latest Runs | Open a Run, read its stdout and stderr |
| Gates | Open Gates, each with a diff of its payload | Approve or reject, with a reason |
| Performance | Merit per Agent over time, the rubric breakdown, the Energy budget, and Tasks by state | Export CSV |
| Ledger | Raw Events with the status of the hash chain | Verify the chain |

## Slices and roadmap

Each slice ends in something the Operator can check.

1. **Slice 0, the base.** Repository layout, the ten types, the Ledger with its hash chain and reducers, the Docker image, the synthetic generator, and CI that runs every Fixture. No Agents.
2. **Slice 1, the society on toy work.** The eight Agents run the toy workflow with live Vitality and Merit. The interface ships the Org, Flow, Agent, Gates, Performance, and Ledger views behind Tunnel and Access. The Mood thresholds get tuned against real data.
3. **Slice 2, building for Lab staff.** Developer and Tester join. They build the first web application for a lab task, probably a Sample receiving screen that replaces the Receiving Log sheet. The `Deploy` Gate goes live.
4. **Slice 3, real work.** A real data source connects behind the `WriteSystemOfRecord` Gate. Agents start reading VBA. Anonymized copies of the real templates become Fixtures.

## Risks and open questions

Each item states the default we take and the one word the Operator can send to reverse it.

| Risk or question | Default | Reverse word |
|---|---|---|
| The SDK documentation does not cover subscription login for a personal tool, and forbids third parties from offering claude.ai login in products. | Proceed for personal internal use and keep authentication swappable. The Operator may confirm with Anthropic. | `apikey` |
| Lab text reaches Anthropic inside prompts. | Accept for the toy phase. Real data waits for slice 3 and an explicit decision. | `local` |
| Subdomain or path on the Cloudflare zone. | `agents.nitrolims-demo.com`. | `path` |
| The templates hold real Client data and are untracked. | Ignore them in git and copy shapes only. | `anonymize`, which creates scrubbed copies for Fixtures |
| Nobody knows how many Turns the subscription allows at once. | Two at a time, measured in slice 1. | `serial`, which runs one Turn at a time |
| The Mood thresholds are guesses. | The numbers in `docs/design/vitality-and-merit.md`, tuned against slice 1 data. | `flat`, which treats every Agent as `fresh` until the data exists |
| Agents may talk in private Rooms. | Allowed. The Operator is a member of every Room and reads everything. | `open`, which forbids Listed Rooms |
| An Agent may write a Revision that removes one of its own forbidden actions. | Allow it. The Conductor, not the Charter, enforces Gates, and the Auditor flags every Revision that removes a boundary. | `lock`, which puts such Revisions behind a Gate |
