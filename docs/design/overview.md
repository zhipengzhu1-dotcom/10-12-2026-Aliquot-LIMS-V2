# Aliquot LIMS design overview

This document describes the automation engine behind the LIMS of a regulated pharmaceutical contract testing lab. Read it first. The decisions it rests on are in `docs/adr/`, the vocabulary is in `GLOSSARY.md`, and the mechanics of Mood and Merit are in `docs/design/vitality-and-merit.md`.

## Vision

This repository is the automation engine behind the lab's human LIMS, the owner's aliquot-lims-dev ([ADR-0017](../adr/0017-this-repository-is-the-automation-engine-behind-the-human-lims.md)). The human LIMS keeps people, roles, two-person review, QA release, OOS investigations and the Client portal. The engine reads submissions, logs receipts, computes results and drafts reports. Every human act it records names the person (#74). Nothing leaves the Sandbox without the Operator's signature on a Gate. Every action is an Event in one hash-chained Ledger, so the lab can show an inspector who did what, when, and why.

**The engine.** Agents do the engine's work, each under a Charter and with its own Tools, and Scripts in the Sandbox do the computation. The Operator reports received Samples and then results in the Lab Room, and the engine logs the Samples, opens the Work Order, computes and verifies the results, and drafts the Report of Analysis behind an `ExternalMessage` Gate. Slices 0 to 2 run on synthetic data. Slice 3 takes the same flow to the lab's real documents, in parallel first. The engine writes shadow copies beside the lab's records and a comparison, and it writes the real Receiving Log only when the Operator says so ([ADR-0018](../adr/0018-slice-3-runs-in-parallel-first.md)). Vitality, Merit, Reviews, Trust tiers and Training are built and stay in the Ledger, but they are not on the first edition's path, and Mood is flat (#62).

## What exists today

On 2026-10-13 the repository holds slices 0, 1 and 2 of the roadmap, all on synthetic data. README.md says how to run each part. The agent tooling configuration is in `CLAUDE.md` and `docs/agents/`.

**The Ledger and its Projections.** The Conductor (`conductor/`, TypeScript on Node 24) is the only writer to one hash-chained Ledger in SQLite, with 33 Event kinds. Every other shape is a Projection that the Ledger keeps as it appends: the Org, Tasks, Gates, Rooms, Scripts, Runs, Artifacts, Turns, Training, Vitality, Merit, the Trust tiers and the Shadow setting. `ledger verify` walks the hash chain.

**The lifecycles.** Eleven lifecycle modules append every Event: Org, Task, Gate, Room, Sandbox, Training, Turn, Vitality, workflow, Tools and Shadow. Each names its Event's cause in `causation_id`, from the Projections. A guard refuses an Event that breaks a rule, in the words `<Kind> refused: <reason>`. The Operator writes only through the `aliquot` command line and the actions of `aliquot serve`, and both call the lifecycles.

**The toy workflow and its Fixtures.** Six Scripts run in the Docker Sandbox, one per stage, from `parse_submission` to `render_roa`, and an Evaluation scores each Run. `workflow run` takes a Submission Form Fixture through the six stages to a Report of Analysis in xlsx and PDF, and each stage writes the next version of the toy LIMS database. CI runs the three Fixtures under `fixtures/` on every push: seeds 1 and 2 in the synthetic layout, and seed 4 in the lab's real Submission Form layout, which `parse_submission` reads into the same record (#76). The synthetic generator writes each Fixture and its weighings, the real-layout one by filling the scrubbed blank form.

**The parallel run (ADR-0018).** `aliquot shadow receiving-log <path>` names the lab's Receiving Log workbook for a home and records its path and sha256 as `ReceivingLogNamed`. While one is named, the workflow reads the workbook read-only before stage 2, stores the bytes as the Operator's `ReceivingLog` Artifact, and stage 2 also writes the Shadow: a copy with one row per container added to the year's sheet and the day's sheet, in the lab's columns, found by position. Its Evaluation checks those rows against the record and that no cell of the lab's changed. `aliquot shadow compare` runs `compare_receiving_log` on the latest accepted Shadow and a fresh read, and stores the Comparison, JSON and a table, as `Comparison` Artifacts produced by that Run. Nothing in the Conductor opens the lab's workbook for writing, and a test checks its sha256 before and after. The chat Chain's stage 2 takes no `ReceivingLog`, so a receipt said in chat writes no Shadow yet. A Report of Analysis with a blank metadata value is refused, never rendered: ADR-0016, which would have printed "Not stated", was withdrawn.

**Turns and Tools.** A Turn is one `query()` through the Agent SDK on the `claude` CLI's subscription login, recorded as `TurnStarted` and `TurnFinished`. An Agent acts only through its 26 Tools, each a lifecycle verb or a read of a Projection. The hook refuses a call that the Charter forbids and records it as `ActionRefused`. Mood is flat (#62): Vitality is measured and shown but decides nothing, and Pause is the only stop. An assignment or Hand-off to a paused or Retired Agent is refused (#65). A scripted model stands in for the SDK in the tests.

**The Scheduler.** Inside `aliquot serve`, the Scheduler plans every Tick from the Ledger. It assigns a stage's Task to the Agent who works the stage, and any other Proposed Task, or a stage's Task whose Agent is paused, by Trust tier and load (#64). It starts Turns for the Agents that have something to do, two at a time, under the Energy budget's 80 percent rule. An Agent that a Task is escalated to gets a Turn (#63). `aliquot intake` gives the Director a Submission Form to work on.

**The chat flow.** The Operator reports received Samples in a Message in the Lab Room, and the Conductor runs the work as a Chain the moment the Message arrives in `aliquot serve`, with no Turn and no model ([ADR-0021](../adr/0021-the-conductor-runs-the-chain-a-message-starts.md)). It takes the Message by storing it as an Artifact (ADR-0015), runs `parse_message` on it, and runs stages 2 and 3 on one Task it proposes, assigns, starts and completes, then replies with the Lab References and the Work Order's due date, within 1 s on the serve's warm Sandbox (ADR-0020). The Lab References continue the toy LIMS database (#66). A receipt must state the Report To party and the Product Type, or `parse_message` refuses it and the Conductor's reply names what is missing. The Operator then gives the notebook reference and the weighings. `parse_results_message` feeds stage 4, stages 4 to 6 run on one Task, and the Conductor requests an `ExternalMessage` Gate naming the PDF and replies with the Gate id and the report's two Artifact ids. Each Event of a Chain names its cause, back to the Operator's Message. The Operator's `GateDecided` is the sign-off; nothing is sent on approval. The Agents' part is review beside the path: a Chain's Task goes to its reviewer when the Review sample picks it. A Message the Chains do not take, such as a question, goes to the Agents as before.

**The interface and its views.** `aliquot serve` serves every Projection under `/api/`, the Events over Server-Sent Events, the Operator's actions, and a single-page application in plain TypeScript. A new tab opens on the Access landing, and ENTER opens the shell: a black slab with the navigation over bone content. Nine routes exist. Org, Flow, Agent, Chat, Gates, Performance and Ledger are drawn. Rooms and Scripts have their routes and show their JSON as it came, until a ticket draws them. The project `verify` skill drives the views in a browser and writes a proof.

**People.** Every Event a person authors names the person by email ([ADR-0019](../adr/0019-every-human-act-names-the-person.md)). The Operator is a role that named people play: the command line takes the person from `--operator` or `ALIQUOT_OPERATOR` and refuses an Operator command without one, and the interface takes the person from the Access assertion. Events written before #74 read as `Operator (unnamed)`.

**Tunnel and Access.** With a Cloudflare Access team, audience and a list of Operator emails, the Conductor admits only a request whose Access assertion is valid and names a listed person; without them it serves `127.0.0.1` only, for the person named at start. `tools/serve.sh`, `tools/tunnel/` and `docs/ops/tunnel.md` hold the Tunnel configuration and the account steps, each with its undo. The owner has not applied them (gate G2), so no Tunnel, DNS route or Access application exists yet.

**The live run.** On 2026-10-13 the society ran live once, on one Fixture, through the Scheduler on the subscription login, for 20 minutes ([live-run-2026-10.md](live-run-2026-10.md)). Four Turns counted 28,140 tokens, every Mood was `fresh`, and the run stopped at stage 1. The stage 1 Task was escalated, and its target got no Turn; #63 fixed that. No full chain and no chat flow has yet run live.

**The Templates.** An untracked `Templates/` folder holds five files, 188 KB in total. They are real records of the lab and carry Client names, contact names, Lot numbers, and Product Codes. ADR-0009 keeps them out of git. The synthetic generator copies their shape only.

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
// email: the person acting as the Operator, lowercased; absent on an Event before #74 (ADR-0019)
// and on a payload that only refers to the role, such as a reviewer to be.
type Actor = { tag: "Agent"; id: AgentId } | { tag: "Operator"; email?: Email };
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
	| { kind: "VitalitySampled"; payload: Vitality }
	| { kind: "TurnStarted"; payload: { turn_id: TurnId; agent: AgentId; model: string; mood: Mood; policy: Policy } }
	| { kind: "TurnFinished"; payload: { turn_id: TurnId; usage: TurnUsage; outcome: TurnOutcome; tool_calls: number } };
	// and the rest of the set below

type TurnUsage = {
	input_tokens: number;
	output_tokens: number;
	cache_creation_tokens: number;
	cache_read_tokens: number;
	cost_usd: number;
};

type TurnOutcome =
	| { tag: "Completed" }
	| { tag: "MaxTurns" }
	| { tag: "Budget" }
	| { tag: "Error"; message: string };
```

The Ledger keeps every Projection: Org, Tasks, Gates, Rooms, Trust tier, work, Scripts, Runs, Artifacts, Turns, Training, and who proposed each Task. It builds them from its Events once when it opens (ADR-0001), and it advances each one by every Event it appends. A writer and a read-only opener build the same Projections from the same Events. Guards and commands read these Projections. No module outside the Ledger folds the Events.

Before the Ledger writes an Event, it advances the Projections by it and runs every guard. Each guard reads the Projections as they stood before the Event. A Projection that cannot apply the Event, or a guard, returns a reason. The Ledger then refuses the Event with `<Kind> refused: <reason>` and writes nothing. The guards always run on an append, and no option turns one off. Opening a Ledger does not run them again ([ADR-0012](../adr/0012-opening-a-ledger-does-not-rerun-the-guards.md)), so a Ledger written under older rules still opens. Only a stored Event that a Projection cannot apply makes the Ledger corrupt: opening it fails and names the `seq` and the reason. `ledger verify` reads only the hash chain, so it still reports on such a Ledger.

The Ledger stores its Events in SQLite, in `<home>/ledger.sqlite`, with one writer (ADR-0008). Tests use in-memory storage instead. Numbering, the hash chain, the guards, and the Projections all live in the Ledger, above the storage, so both storages run the same rules. SQLite stays the production storage, and the tests of persistence, the writer lock, and the chain on disk run on it.

The actor `Conductor` authors the tier Revisions that Merit and Gates require (ADR-0011), and records its own acts ([ADR-0013](../adr/0013-the-conductor-records-its-own-acts.md)): the `TurnStarted` and `TurnFinished` of each Turn it schedules, the `VitalitySampled` it takes at the end of each Turn, naming that Turn's `TurnFinished`, and the `ActionRefused` of each Tool call its hook refuses. The Ledger refuses any other Event it authors, a sample by it that names no `TurnFinished` of the same Agent, and a Turn Event or an `ActionRefused` from any actor but the Conductor. Only an Event's `actor` and a definition's `revised_by` can name it, so no payload can make the Conductor a reviewer, an escalation target, or a Skill author. No command takes the Conductor as its actor; `tools call` runs the Conductor's hook, which records a refusal as the Conductor would in a Turn.

The initial kinds are `AgentRecruited`, `AgentDefinitionRevised`, `AgentPaused`, `AgentResumed`, `AgentRetired`, `TaskProposed`, `TaskAssigned`, `TaskStarted`, `TaskHandedOff`, `TaskCompleted`, `TaskFailed`, `TaskEscalated`, `RoomOpened`, `MessageSent`, `HelpRequested`, `ScriptRegistered`, `ScriptRevised`, `RunStarted`, `RunFinished`, `ArtifactStored`, `EvaluationRecorded`, `ReviewRecorded`, `VitalitySampled`, `RestOrdered`, `GateRequested`, `GateDecided`, `HumanCoached`, `MemoryNoted`, and `SkillPublished`. Slice 1 adds `TurnStarted`, `TurnFinished`, and `ActionRefused`. Slice 3 adds `ReceivingLogNamed`, `{path, sha256}`: a named person sets the absolute path of the lab's Receiving Log workbook for this home, and the Ledger keeps the file's sha256 at that moment, never its contents. The latest one is the setting; a later one names the earlier one as its cause.

Only a domain's lifecycle module appends Events, and no command appends a raw one. Each verb mints the ids and derives `causation_id` from the Projections, so the Ledger records the true cause of every Event. `lifecycle-support.ts` holds what the verbs share: `Origin`, the actor and any cause from outside the domain; `Recorded`, the entity as the Event left it with the Event's seq, which each verb returns; and `readBack`, which reads that entity from the Projections after the append. A verb decides each refusal before it builds the Event, through the predicate the guard uses, and throws it with `orRefuse` from `append-guard.ts`. The lifecycle modules and the kinds each one appends:

| Lifecycle module | Event kinds |
|---|---|
| `org/lifecycle.ts` | `AgentRecruited`, `AgentDefinitionRevised`, `AgentPaused`, `AgentResumed`, `AgentRetired` |
| `task/lifecycle.ts` | `TaskProposed`, `TaskAssigned`, `TaskStarted`, `TaskHandedOff`, `TaskCompleted`, `TaskFailed`, `TaskEscalated`, `ReviewRecorded`, `HelpRequested` |
| `gate/lifecycle.ts` | `GateRequested`, `GateDecided`; only the Task lifecycle's `block` requests a Gate that blocks a Task |
| `room/lifecycle.ts` | `RoomOpened`, `MessageSent` |
| `sandbox/lifecycle.ts` | `ScriptRegistered`, `ScriptRevised`, `RunStarted`, `RunFinished`, `ArtifactStored` |
| `vitality/lifecycle.ts` | `VitalitySampled` by the Operator or an Agent, `RestOrdered` |
| `turn/lifecycle.ts` | `TurnStarted`, `TurnFinished`, and the end-of-Turn `VitalitySampled`, always as the Conductor (ADR-0013) |
| `workflow/lifecycle.ts` | `EvaluationRecorded` |
| `training/lifecycle.ts` | `MemoryNoted`, `SkillPublished`, `HumanCoached` |
| `tools/lifecycle.ts` | `ActionRefused`, always as the Conductor (ADR-0013) |
| `shadow/lifecycle.ts` | `ReceivingLogNamed`, only by a named person acting as the Operator; its read of the workbook stores a `ReceivingLog` through the Sandbox lifecycle |

The Ledger itself appends the Conductor's tier Revisions, as follow-ons and catch-ups (ADR-0011). Every kind has a lifecycle that appends it; none is reserved. Biome refuses an append call, and an `append` destructured from a Ledger or read by a computed key, in any non-test module except a `lifecycle.ts`, the Ledger's `ledger.ts`, and the test scenario in `test-support/`.

### 2. Agent definition

An Agent definition is a versioned document. A change is a Revision Event, never an edit in place. `trust_tier` always equals the projected Trust tier: the Ledger refuses a Recruitment or a Revision that records any other tier, whoever authors it. Granting a Skill is a Revision that adds its id to `skills`, and the Ledger refuses a Recruitment or a Revision whose `skills` names an id that no `SkillPublished` has published, naming that id.

One module, the Org lifecycle (`org/lifecycle.ts`), appends every Agent Event that the Operator or an Agent causes: it recruits, revises, pauses, resumes, and retires an Agent, and the seed recruits the starting roster through it. Each verb returns the Agent as the Event left it and the seq it appended. Each verb names the Event's cause in `causation_id`: the Agent's previous Org Event, which the Org Projection keeps, so a Recruitment names none, and for a retirement the `GateDecided` that approved its `RetireAgent` Gate, which the Gate Projection keeps. A caller names a cause only when it lies outside the Org; a retirement takes none, since its cause is always the approving decision. `retire` refuses an Agent that is not live, an actor other than the Operator, and a Gate that is unknown, undecided, rejected, of another kind or naming another Agent, before it builds the Event, through the predicate the Org guard uses. A retirement's reason defaults to the one in its `RetireAgent` Gate's payload, and is refused when neither gives one. The Conductor's tier Revisions stay Ledger follow-ons (ADR-0011).

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

type Action =
	| "RunScript" | "TouchArtifact" | "DecideGate" | "AssignLabWork" | "AcceptOwnProposal"
	| "DoLabWork" | "TouchResults" | "VerifyOwnTeamRun" | "RunOutsideSandbox" | "WriteSystemOfRecord";
```

A Charter's `forbidden` list is a closed vocabulary of Actions, each one predicate over a Tool call and the Projections (see "Runtime topology"). The Ledger refuses a Recruitment or a Revision that forbids anything but an Action, naming it. A Ledger seeded before the vocabulary keeps the roster's phrases, such as `Run Scripts`: the Event boundary still reads a forbidden list of free text (ADR-0012), a Revision may carry those phrases over but add none, and the hook reads each phrase as its Action through the seed's table.

### 3. Task

A Task moves through a state machine. A Hand-off is a transition back to `Assigned` with a new assignee, not a state of its own. A Task that the Trust tier rules do not select for Review goes from `InProgress` straight to `Done`. A `Done` Task keeps its assignee, so the Task Projection alone says whose work a Review scores.

One module, the Task lifecycle (`task/lifecycle.ts`), appends every Task Event: it proposes, assigns, starts, hands off, escalates, completes, reviews, and fails a Task, and blocks one on a Gate it requests. Each verb mints the ids it needs from the Projections and returns the new Task and the seq it appended. Each verb also names the Event's cause in `causation_id`, from the Projections. The cause is the Task's previous Event, which the Task Projection keeps, or for a completion after Review the reviewer's `ReviewRecorded`. A caller names a cause only when it lies outside the Task, as the workflow tracer names the `EvaluationRecorded` it completes a Task on. A verb that the Projections already refuse, such as a Hand-off of a Task that is not `InProgress`, is refused before the verb builds an Event, in the same words. Completing a Task decides its Review: the verb asks the Trust tier whether the sample picks the Task. If it does, the Task goes `UnderReview` with the named reviewer, and a completion that names none is refused as sampled for Review. If it does not, the Review is skipped, and a named reviewer is unused. So `task complete <id>` takes only `--reviewer` and `--output`, and on a Task `UnderReview` it completes the Task after Review. Assignment is the one verb the Conductor also calls, as its own act (ADR-0013): the Scheduler assigns a Proposed Task that no one assigned within a Tick, naming its previous Event, and the verb and the Task guard refuse the Conductor's assignment of a Task that is not Proposed.

A Task is assigned or handed off only to a live Agent that is not paused (#65). The Task guard refuses a `TaskAssigned` or `TaskHandedOff` whose new assignee is paused, with `<id> is paused`, or is Retired or not in the Org, with `<id> is not a live Agent in the Org`. The predicate is the one the Turn guard uses to refuse a `TurnStarted` (`activeAgent` in `org/projection.ts`), and the `assign` and `handOff` verbs refuse with it before they build the Event. So `task assign` and `task handoff` print the refusal. A Ledger written before #65 that holds such an assignment still opens (ADR-0012). The same predicate refuses a `TaskEscalated` whose target, and a `HelpRequested` whose helper, is an Agent that is paused, Retired or not in the Org (#72), and the `escalate` and `requestHelp` verbs refuse with it before they build the Event; the Operator is always a lawful target.

Two rules from `docs/design/vitality-and-merit.md` decide who takes a Task and who reviews it. Each is one predicate. The Ledger's guard refuses an Event with it, and the lifecycle verb refuses with it before it builds the Event, so both refusals use the same words.

- The reviewer rule (`vitality/reviewers.ts`). The role of the assignee decides the reviewer: either Supervisor for a Specialist, the Director for a Supervisor, and the Operator for the Director, the Steward, and the Auditor. The Auditor may review any Task, and a `Senior` or `Mentor` Agent may review an Agent on `Probation`. No one reviews their own Task. One predicate decides both the reviewer that a `TaskCompleted` names and the actor of a `ReviewRecorded`, so the two cannot disagree. A refusal names the assignee, its role, and who may review it. The design names no reviewer for the Developer and the Tester, so until they join in slice 2 they take the Specialists' rule.
- No Mood rule. Mood is flat (#62): every Agent is `fresh`, so no `TaskAssigned` or `TaskHandedOff` is refused for the new assignee's Vitality or Rest.

A Help request is a `HelpRequested` Event with payload `{ task_id, to: Actor, question }`, by the assignee of a live Task (`Assigned`, `InProgress`, `UnderReview` or `Blocked`), to the Operator or a live Agent. The Task keeps its state, and the Event names the Task's previous Event as its cause. The Task Projection refuses a Help request from anyone but the assignee, and on a Task with no assignee or that is no longer live. It keeps each Task's Help requests as `{ seq, from, to, question }[]`, and every Agent each Task has been assigned to, which the Training guard reads for a Memory note. A reply is a Message in a Room, not an Event kind of its own.

An escalation is a `TaskEscalated` Event with payload `{ task_id, to: Actor, reason }`. It ends the Task in `Escalated`, which has no way out. The Task Projection keeps each escalation as `{ seq, from, to, reason }`, `from` being the Event's actor, so the Scheduler can wake an Agent a Task is escalated to and its Turn prompt can show who escalated the Task and why.

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
	| "SubmissionForm" | "SubmissionRecord" | "ReceivingLogRow" | "LimsDatabase"
	| "WorkOrder" | "ResultWorksheet" | "VerificationRecord" | "ReportOfAnalysis"
	| "ReceivingLog" | "ShadowReceivingLog" | "Comparison"
	| "Other";

type Artifact = {
	id: ArtifactId;
	sha256: Sha256;
	media_type: string;
	artifact_type: ArtifactType;
	produced_by: { tag: "Run"; id: RunId } | { tag: "Operator"; email?: Email };
	lineage: ArtifactId[];
};
```

`sandbox lineage <artifact id>` walks an Artifact's Lineage back to the Artifacts that have none, one line per production, each naming the Run and Script version that produced it. The Auditor's Lineage check reads this walk.

A `LimsDatabase` Artifact is one version of the toy LIMS database (see "Toy System of record"), stored as `application/vnd.sqlite3`. Its Lineage names the record that changed it and the version before it, so the walk from any version reaches every Submission Form behind its rows.

The parallel run adds three types (ADR-0018). A `ReceivingLog` is one read of the lab's Receiving Log workbook, produced by the person who ran the command, with no Lineage, named `receiving-log.xlsx` whatever the file is called; its `ArtifactStored` names the `ReceivingLogNamed` that set the path. A `ShadowReceivingLog` is the Shadow stage 2 writes, whose Lineage holds the record and that read. A `Comparison` is the report `shadow compare` writes, `comparison.json` and `comparison.txt`, produced by the comparison's Run, whose Lineage holds the Shadow, its `shadow.json` and the fresh read.

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

One module, the Sandbox lifecycle (`sandbox/lifecycle.ts`), appends every Sandbox Event: it registers and revises a Script, starts and finishes a Run, and stores an Artifact. The Script registry, the runner and the Artifact store keep their own work, the copy of a Script's code, the `docker run` and the blob, and call the lifecycle to record it. Each verb mints the ids it needs from the Projections and returns what it appended with its seq. Each verb also names the Event's cause in `causation_id`, from the Projections. A `ScriptRevised` names the Script's previous version. An `ArtifactStored` that a Run produces, and the Run's `RunFinished`, name the Run's `RunStarted` and carry its Task. A caller names a cause only when it lies outside the Sandbox, as the workflow tracer names the `TaskStarted` it runs a Script on, so only starting a Run takes a cause and a Task from its caller. Storing bytes the Ledger already holds appends nothing unless a new Run produced them, and returns the `ArtifactStored` that already records them.

### 6. Vitality, Mood, and Policy

Vitality is measured from the Ledger, never reported by the Agent. The Conductor samples it once per Turn. Mood and Policy are pure functions. Mood is flat in the first edition (#62): every live Agent's Mood is `fresh`, so its Policy is the normal one, and `moodOf` with its thresholds is kept but not in force.

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

`fatigue` is the sum of input, output and cache creation tokens of the Agent's `TurnFinished` Events in the trailing 5 hours, divided by its share of the Energy budget. Cache reads are recorded but not counted. The Turn Projection keeps each Agent's open Turn and every Turn with its start and finish times, and answers the tokens one Agent, or the whole society, used in a window.

One module, the Turn lifecycle (`turn/lifecycle.ts`), appends both Turn Events, always as the Conductor. Starting a Turn mints `TN-<n>` from the Turn Projection and records the model and the Mood and Policy that `vitality show` gives the Agent at that moment. It is refused for an Agent that is not live, is paused, or already has an open Turn; Rest does not stop it (#62). Finishing a Turn names its `TurnStarted` as the cause, and is refused for a Turn that is unknown or already finished. After the finish, the Turn lifecycle samples the Agent's Vitality as the Conductor, from the same computation as the Vitality lifecycle, naming the `TurnFinished` as its cause; the Ledger refuses a Conductor sample that names no `TurnFinished` of the same Agent. No command writes a Turn Event directly: `turn run` runs a Turn through the lifecycle (see **Conductor** under "Runtime topology"), and `turn list` prints them.

One module, the Vitality lifecycle (`vitality/lifecycle.ts`), appends every Vitality Event the Operator or an Agent records. It samples a live Agent's Vitality from the Ledger and returns the sample and the seq it appended. A sample from the command line names no cause. It orders Rest for an Agent or ends it, and returns the seq. A Rest order names the Agent's previous `VitalitySampled` or `RestOrdered` as its cause: the Vitality it acts on, or the Rest it ends. A Rest order that the Rest guard would refuse is refused before the verb builds an Event, in the same words.

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

A Gate is a request for an Operator decision. Only the Operator emits `GateDecided`. The decision is the electronic signature record, and it names the person who signed it, as its actor and as `decided_by` (ADR-0019). The Ledger stamps `decided_at` with the decision Event's own `ts`, so the caller supplies no time and the signature time is the time the decision is recorded (ADR-0006).

One module, the Gate lifecycle (`gate/lifecycle.ts`), appends every Gate Event: it requests a Gate under the next free gate id and records the Operator's decision on it, and each verb returns the Gate and the seq it appended. A decision names the Gate's request as its `causation_id` and carries the payload hash the Operator checked, which the Ledger refuses, writing nothing, when it is not the stored one. A request that blocks a Task comes only from the Task lifecycle's `block`, which names the Task's previous Event as the request's cause. Biome refuses a call to the Gate lifecycle's `requestGateForTask` in any other module.

```ts
type GateKind = "Deploy" | "WriteSystemOfRecord" | "ExternalMessage" | "RetireAgent" | "PromoteToMentor";

type GateState = "Open" | "Approved" | "Rejected" | "Expired";

type GateDecision = {
	gate_id: GateId;
	decided_by: { tag: "Operator"; email?: Email };
	decided_at: IsoTime;
	payload_hash: Sha256;
	meaning: "approve" | "reject";
	reason: string;
};
```

### 9. Skill and Memory note

A Skill is a versioned Markdown procedure that any Agent can be granted. A Memory note is a private lesson that one Agent reads before similar Tasks. Coaching is the Operator's guidance to one Agent. All three are Events, so Training is auditable.

One module, the Training lifecycle (`training/lifecycle.ts`), appends `MemoryNoted`, `SkillPublished` and `HumanCoached`. Each verb decides its refusals before it builds the Event, through the predicate the Training guard uses, and returns what it recorded with the seq it appended.

- A Memory note is the Agent's own, on a Task the Agent has been assigned at some point, which the Task Projection keeps. The Ledger refuses a note by any other actor, and a note on a Task the Agent was never assigned. The note names the Task's previous Event, the outcome it learned from, as its cause.
- Publishing a Skill id appends its next version, starting at 1, with the actor as `author`. A version after the first names the version before it as its cause. The Ledger refuses a version that skips one, an author other than the actor, and a later version that names any other cause. A Skill id is a name the publisher chooses.
- Coaching is a `HumanCoached` Event with payload `{ agent_id, task_id?, note }`, by the Operator only, to an Agent in the Org. With a Task, it names the Task's previous Event as its cause.

The Training Projection (`training/projection.ts`) keeps each Agent's Memory notes and Coaching, and every version of each Skill, each with its seq.

```ts
type Skill = { id: SkillId; version: number; title: string; body_md: string; author: Actor };

type MemoryNote = { agent: AgentId; task_id: TaskId; lesson: string; applies_to: string[] };

type Coaching = { agent_id: AgentId; task_id?: TaskId; note: string };
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

**Conductor.** The Conductor is a TypeScript process on Node. It is the only writer to the SQLite Ledger. It schedules Turns, enforces each Agent's Charter, serves the interface, and streams Ledger Events over SSE. Each Turn is one `query()` call from `@anthropic-ai/claude-agent-sdk`. The Agent's Tools are an in-process MCP server that exposes Ledger-backed verbs (see **Tools** below). Each call runs through the hook, which refuses the Charter's forbidden Actions, and the Conductor records each refusal. A `PreToolUse` hook denies every tool outside that server, because allow rules bypass `canUseTool`. `maxTurns` and `maxBudgetUsd` cap each Turn. The Conductor records each Turn as a `TurnStarted`, with the Agent's model, Mood and Policy, and a `TurnFinished`, with the usage the result reports, its outcome and its number of tool calls (ADR-0013). Fatigue is computed from the `TurnFinished` Events.

**Scheduler.** The Scheduler runs inside `aliquot serve`, unless `--no-schedule` is given, so the society works on its own while the interface shows it. Every Tick (`--tick`, 15 seconds by default) it plans from the Ledger and applies the plan. The plan (`scheduler/plan.ts`) is a pure function from the Projections, the time and the options to a list of decisions, so the same Ledger gives the same decisions. The loop (`scheduler/scheduler.ts`) applies them through the Task lifecycle and `runTurn`, as the Conductor, and prints one line per decision, `scheduler <time> <agent or nobody> <verb> <why>`. It keeps the last Tick for `GET /api/scheduler`. A refusal by the Ledger is a line, never a crash. A Tick does three things.

- It assigns each Proposed Task proposed at least one Tick ago. The assignment is the Conductor's own act (ADR-0013): its `TaskAssigned` names the Task's `TaskProposed` as the cause, and the Task guard refuses one by the Conductor of a Task that is not Proposed or that names another cause. A stage's Task is routed, not drawn (#64). The plan reads the Task's stage from its inputs as the Action table does, the last stage whose input types they cover, so a stage 6 Task is stage 6 (#59). It assigns the Task to the Agent the stage table names to work that stage when that Agent is active and the Verifier rule allows it, and the reason reads `T-7: A-ines works stage 6 Report`. Otherwise the other Agents of that Agent's role take the Task by the weighted pick below, and the reason names why the stage's Agent did not take it: `T-7: A-ines works stage 6 Report, but A-ines is paused; pick ...`. Any other Task goes to a Specialist by the weighted pick. The pick passes over an Agent that is not active (`activeAgent`) and one the Verifier rule refuses; Mood passes over no one (#62). Each remaining Agent weighs its Trust tier's allocation weight times `1 - load`, in hundredths, and `hash(task_id) mod total weight` picks one in id order (see "Allocation favors trusted, unloaded Agents" in `docs/design/vitality-and-merit.md`).
- It starts Turns for the Agents with something to do: an `Assigned` or `InProgress` Task, or, since its last Turn started (its prompt was built then), a Message from someone else in one of its Rooms, a Help request to it, a Task escalated to it, or a decision on a Gate it requested. The Director also has a Submission Form with no Task to work on, and the Steward and the Auditor have a standing duty every `--duty` (30 minutes). An Agent that is paused or in a Turn is skipped; Rest skips no one (#62). The others start, oldest last Turn first, while fewer than `--concurrency` (2) Turns are open. A Turn is open from its `TurnStarted` to its `TurnFinished`, so the Turn Projection's open Turns are the Turns that run.
- Over 80 percent of the Energy budget (`--budget`) in the trailing 5 hours, as the Turn Projection counts the society's tokens, it starts Turns only for Agents holding a Task with a rush TAT class.

The Scheduler's Turns run on the model `turn run` uses, with `maxTurns` 20 and no `maxBudgetUsd`, on the subscription login; `serve` refuses to schedule with `ALIQUOT_API_KEY` set. On SIGINT or SIGTERM it stops ticking and waits for the Turns still open before the Ledger closes. `aliquot intake <docx>` stores a Submission Form as an Artifact the Operator produced, which is how the Operator drops work on the society.

`turn run <agent>` runs one Turn (`turn/run.ts`). It starts the Turn, which refuses an Agent that is not live, is paused, or has an open Turn before any Event. It builds the prompt from the Ledger (`turn/prompt.ts`). What holds for the whole Turn is the Agent's identity, Charter, Persona and reporting line, its Skills' bodies, its Memory notes, and its Tools, each marked when the Charter refuses it. What opens the Turn is its live Tasks by state with their inputs, each stage's Task naming its stage, the stage's Script id and the input types the Script takes (#64), each Task the Trust tier samples for Review saying that `complete_task` names a reviewer and which one, the stage's reviewer when the reviewer rule allows it and else the first it allows, a stage 6 Task saying to request an `ExternalMessage` Gate on the report and reply in the Lab Room, the Messages in its Rooms and the Coaching since its previous Turn started, the open Help requests addressed to it, the Tasks escalated to it since its previous Turn started, each with who escalated it and the reason in their words, and the note that an Escalated Task has no way out, so the Agent takes it on by proposing a new Task with the same inputs and assigning it, or says in a Room why not, the Gates it requested with their state, and, for the Director, the Submission Forms no Task has been proposed for and the Operator's Messages in the Lab Room since its previous Turn started, each with the Artifact id it has once stored and the instruction that a report of received Samples is work for stage 2's Specialist and a report of results is work for stage 4's, naming every Script id of the chain. A Task's input that is an Operator's Message is named as that Message. The model runs behind one boundary (`turn/model.ts`), a function from that request to an outcome and a usage. The real model (`sdkModel` in `tools/sdk.ts`) is one `query()` with the Agent's `model`, the Tool server and no built-in tools, `dontAsk` permissions with every Tool of the server allowed, so the hook judges and records every call, no settings or MCP servers from the machine, the `PreToolUse` hook, and a scratch working directory, `<home>/scratch`. The usage is the result's `modelUsage` summed over models. The outcome is `Completed` for a successful result, `MaxTurns` or `Budget` for those caps, and `Error` with the text for any other result, or for a model call that throws, so no Turn stays open. The tool call count is every call that reached the server. The Conductor then samples the Agent's Vitality naming the `TurnFinished`, and prints the Turn, the sample and the Mood. A scripted model (`ALIQUOT_SCRIPTED_MODEL`, a JSON file of Tool calls, the usage of each round trip, and how it stops) stands in for the SDK in the tests and for a Turn run by hand without the network. It makes its calls through the same hook and stops at the same caps.

**Tools.** The Tools are one table (`tools/table.ts`). Each row names the Tool, its input shape, the lifecycle verb it calls with the Agent as actor, and the plain Action it performs. The MCP server of one Agent is built from the table with the Agent fixed in its context, never read from an input, so a Tool cannot act as another Agent. A Tool returns the Event its verb appended, or the Projection it read, as JSON text, and a refusal by the Ledger as its text. `run_script` on a workflow stage's Script records the stage's Evaluation after the Run, as the workflow tracer does, and returns it with the Run; it needs the Task the Evaluation scores. `tools/sdk.ts` is the only module that loads the SDK, and only when it builds a server.

| Tools | Verb |
|---|---|
| `read_tasks` | the Task Projection |
| `propose_task`, `assign_task`, `start_task`, `complete_task`, `fail_task`, `escalate_task`, `hand_off`, `review_task`, `request_help` | the Task lifecycle |
| `run_script` | the Sandbox runner, then the workflow lifecycle on a stage Script |
| `read_artifact`, `list_artifacts`, `lineage` | the Artifact Projection and blob store |
| `send_message`, `read_room`, `open_room` | the Room lifecycle and the membership rule |
| `note_memory`, `publish_skill` | the Training lifecycle |
| `propose_revision` | the Org lifecycle's `revise` |
| `request_gate` | the Gate lifecycle, or the Task lifecycle's `block` when it names a Task |
| `order_rest`, `end_rest` | the Vitality lifecycle |
| `verify_ledger` | the hash chain |

The hook runs before every Tool call. It refuses the call when it performs an Action the Agent's Charter forbids. Mood is flat (#62), so the Policy refuses nothing; an `ActionRefused` whose `action` is `Policy` exists only in a Ledger written before #62. The Conductor records a refusal as `ActionRefused` with payload `{ agent, tool, action: Action | "Policy", reason, task_id? }`, naming the Agent's open `TurnStarted` as its cause, so the Auditor and a Review's boundary score can see every attempt. A call the hook allows and the Ledger then refuses is not an `ActionRefused`; the Ledger's refusal text goes back to the model.

The Actions are one table of predicates (`tools/actions.ts`). A plain Action covers the Tools whose row names it. A relational one also reads the Projections. A Task works a stage when its inputs hold an Artifact of each of the stage's input types.

| Action | The calls it covers |
|---|---|
| `RunScript` | `run_script` |
| `TouchArtifact` | `read_artifact` |
| `DecideGate`, `RunOutsideSandbox`, `WriteSystemOfRecord` | none: only the Operator decides a Gate, `run_script` runs in the Sandbox, and the toy LIMS is not a System of record |
| `AssignLabWork` | `propose_task` or `assign_task` of a stage's Task |
| `AcceptOwnProposal` | `assign_task` or `start_task` on a Task the caller proposed |
| `DoLabWork` | `run_script` of a stage's Script, or `complete_task` on a stage's Task |
| `TouchResults` | the same, for stages 4 to 6 |
| `VerifyOwnTeamRun` | `run_script` of stage 5 on an Artifact of a Run whose Task's assignee is on the caller's team: the caller, an Agent that reports to it, or one that reports to a Supervisor the caller reports to, with the Specialists reporting to every Supervisor |

`tools list <agent>` prints the Tools an Agent may use given its Charter, and `tools call <agent> <tool> [json]` calls one through the hook.

**Authentication.** The Agent SDK spawns the `claude` CLI, which uses the subscription login when no API key is set. The SDK documentation, read on 2026-10-12 for SDK 0.3.296, lists subscription OAuth last in precedence. It says `claude setup-token` and `CLAUDE_CODE_OAUTH_TOKEN` authenticate scripts with a subscription. It also says third-party developers may not offer claude.ai login in products built on the SDK, and it says nothing about personal internal tools. Authentication is one module, `turn/auth.ts`, so an API key with `maxBudgetUsd` can replace it. By default a Turn uses the subscription login, and the `claude` CLI it spawns gets no `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, so an inherited key cannot bill an API account. When `ALIQUOT_API_KEY` is set, the CLI gets it as `ANTHROPIC_API_KEY`, and `turn run` refuses to start without `--max-budget-usd`. The Turn's printout says which login it used; the Ledger never records it. Two Turns run at the same time to start. The Energy budget is the subscription's 5-hour window.

**Sandbox.** One Docker image holds `python:3.13-slim`, openpyxl, python-docx, pdfplumber, reportlab, and sqlite3. Scripts and inputs mount read-only. Each Run writes to a fresh output directory. Containers run with `--network none`, `--cap-drop ALL`, and CPU, memory, and time limits. An Agent changes a Script by writing a new version into the Sandbox repository and running its Fixtures.

**The warm Sandbox.** The command line starts a container per Run, about 0.25 s each. `aliquot serve` keeps one container per image warm and runs each of its Runs in it, about 25 ms for `parse_message` ([ADR-0020](../adr/0020-the-serve-runs-scripts-in-a-warm-sandbox.md)). The runner asks a Sandbox for each Run's Workspace (`sandbox/container.ts`). The cold Sandbox is the default, and the serve installs its warm one with `useSandbox` (`sandbox/warm.ts`), so every Run the serve starts is warm, whichever path starts it. The warm container has the cold Run's flags and mounts, and its supervisor runs one Run at a time with the cold Run's command. Between Runs it kills every process the Run left and empties every place a Run can write. A container that stops fails the Run in flight, which says so in its stderr, and the next Run starts a fresh one.

**Toy System of record.** A SQLite database in the Sandbox stands in for the lab's LIMS tables (samples, lots, work orders, results, and reports). It is synthetic, so it is not a System of record and Agents write to it without a Gate. Each data source declares in configuration whether it is a System of record. Connecting a real database turns the `WriteSystemOfRecord` Gate on by configuration, with no code change.

The toy LIMS database is an Artifact, never a mutable file. It is one SQLite file, `lims.sqlite`, of type `LimsDatabase`. A stage that changes it carries the latest `LimsDatabase` Artifact in the Ledger as an input, copies it inside the container, writes its rows, and outputs the next version. The Run's Lineage makes each version name the version before it and the record that changed it. When the Ledger holds no version, stage 2 (`log_receipt`) creates the database. The five tables' schema lives in one module, `sandbox/scripts/log_receipt/lims_schema.py`. It sits in that Script's directory because a container mounts only its own Script; later stages find the tables in the database they carry, and they add rows, not tables. The module sets `PRAGMA user_version` to the schema version, 1, and `log_receipt`, `create_work_order`, `compute_results` and `render_roa` refuse a carried database of another version.

Every table is `STRICT`. Every row's `source_artifact` holds the Artifact id of the document that produced the row, so a Lineage query can start from a row. Dates are ISO 8601 text (`YYYY-MM-DD`) and times are `HH:MM`.

| Table | Key | Columns | Written by |
|---|---|---|---|
| `lots` | `lot` | `product_code`, `product_name` (the Sample Description), `product_type`, `client` (the Submitted By company), `exp_date` (empty: the Submission Form gives no expiry), `source_artifact` | Stage 2, one row per Lot; a Lot already in the table keeps its first row |
| `samples` | `lab_reference` | `lot` (references `lots`), `container` (1, 2, 3 across all the record's Samples, in form order, as the weighings number them), `qty_received` (1), `sample_type`, `tat_code`, `tat_class`, `date_submitted`, `date_received`, `time_received`, `received_by`, the six Submission Form fields (`company`, `contact`, `address`, `city`, `phone`, `email`) of each party as `submitted_by_*`, `bill_to_*` and `report_to_*`, `source_artifact` | Stage 2, one row per container |
| `work_orders` | `work_order`, `lab_reference`, `test` | `lab_reference` (references `samples`), `test`, `due_date`, `source_artifact` (the Receiving Log row) | Stage 3, one row per Sample and Test of a Work Order |
| `results` | `lab_reference`, `test` | `value` (a real number), `unit`, `source_artifact` (the weighings) | Stage 4, two rows per Sample: "Average capsule weight" holds its container's average, and "Average capsule weight, Work Order mean" the mean of the Work Order's averages |
| `reports` | `lab_reference` | `issued_date` (the day the Run rendered the report, UTC), `document_revision` (the report form's revision), `source_artifact` (the PDF Report of Analysis, whose Run also wrote the xlsx) | Stage 6, one row for the Sample the report is for |

Stage 2 assigns each container a Lab Reference at receipt, `LR-<year received>-<n>` with n written as four digits or more. n is one more than the highest n for that year in `samples`, so the numbering continues from the carried version, and a container numbered in one version is never numbered again.

**Interface.** `aliquot serve` is the Conductor process. It holds the Ledger's writer for its lifetime. On Node's built-in `http`, with no framework, it serves four things: every Projection as JSON under `/api/`, the Ledger's Events as Server-Sent Events at `/api/events` with each Event's seq as its id, the Operator's actions at `POST /api/actions/<verb>`, and a single-page application. An action runs the lifecycle verb its command runs, as the Operator named by the person the request came from, and answers with the Event it appended or the Ledger's refusal. `GET /api/operator` answers that person's email, which the Access landing shows. The application is plain TypeScript in `conductor/ui/`, compiled to ES modules with no bundler. Without Cloudflare Access, the Conductor serves `127.0.0.1` only, for the person `--operator` named at start. With Access, it admits only a request whose `Cf-Access-Jwt-Assertion` is signed by one of the team's published keys and names the application's audience and one of the emails a repeated `--operator-email` lists. README.md's Serve section lists the routes. Cloudflare Tunnel exposes the application at `agents.nitrolims-demo.com`, and Cloudflare Access admits only the listed emails. We prefer a subdomain to the path `app.nitrolims-demo.com/development`. A path would route through whatever serves `app.` today and would share its cookies.

**Cost.** Everything on Cloudflare stays on the free tier, which covers Tunnel, Access for up to 50 users, and DNS. There is no Workers paid plan, no Containers, and no R2 beyond the free tier. The Ledger and the Artifact store stay on the Mac.

**Data boundary.** Real lab documents never leave the Mac, except as text inside prompts sent to Anthropic. The owner accepted this on 2026-10-13 for the demo to lab members (see "Risks and open questions").

## The starting roster

Slice 1 starts with eight Agents. Their names are invented. Developer and Tester join after the first edition (see "Slices and roadmap"). Any other Recruitment is a Steward proposal.

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

The seed records each phrase of the "Forbidden actions" column as its Action: Odile `RunScript`, `TouchArtifact` and `DecideGate`; Mabel `AssignLabWork` and `AcceptOwnProposal`; Thorne `DoLabWork`; Pia `TouchResults`; Anselm `VerifyOwnTeamRun`; Rin and Ines `RunOutsideSandbox`; Bram `WriteSystemOfRecord`. Thorne's "Only the Operator may revise its definition" is a rule on others, which the Org guard enforces.

## The toy workflow

A synthetic generator invents Clients, products, Lots, and dates in the shape of the real templates. Each stage is a Script with Fixtures. Agents supervise the Runs, evaluate the outputs, and write new Script versions when an Evaluation fails. The Auditor samples the Lineage of each Report of Analysis back to its Submission Form with `aliquot sandbox lineage <report id>`.

| Stage | Input Artifact | Script | Output Artifact | Evaluation |
|---|---|---|---|---|
| 1. Submission | Submission Form (docx) in the synthetic layout or the lab's real one, told apart by the form's tables | `parse_submission` | Structured submission record (`SubmissionRecord`, schema `submission/2`), one Sample per Sample line of the form, each with its containers | The record lists a Sample, every required field of it and of each Sample is present, and every TAT code is valid. |
| 2. Receipt | Submission record, the toy LIMS database it carries, and a fresh read of the lab's Receiving Log (`ReceivingLog`) when the home names one | `log_receipt` | Receiving Log row (`ReceivingLogRow`, xlsx) and the next toy LIMS database version (`LimsDatabase`) with the Sample rows; with the lab's Receiving Log, also the Shadow (`ShadowReceivingLog`, xlsx) and `shadow.json` | One row per container of every Sample in form order, the Lot and Product Code on every row match its Sample's, the database has a `samples` row per row's Lab Reference and one `lots` row for each Lot, and every Lab Reference is new in this version. With a Shadow: one new row per container in the year's sheet and the day's sheet, each holding the record's and its Sample's values and the Lab Reference in the lab's columns, and no cell of the lab's workbook changed. |
| 3. Work Order | Receiving Log row, and the toy LIMS database it carries | `create_work_order` | Work Order (`WorkOrder`, xlsx) that plans each Sample with its Lot, a Test and a due date from TAT, and the next toy LIMS database version with the `work_orders` rows | Each Sample's due date equals the one the Evaluation computes from the Receiving Log row's date and the Sample's TAT class, every Sample on the row has a Test and its own Lot, the Work Order is due with its last Sample, the Work Order number is new, and the `work_orders` rows agree with the document. |
| 4. Results | Work Order and weighings (synthetic, or read from the Operator's results Message), and the toy LIMS database it carries | `compute_results` | Result Worksheet (`ResultWorksheet`, xlsx with `=F/20` style formulas, and the notebook reference in its header when the weighings name one) and the next toy LIMS database version with the `results` rows | Every average and the mean are formulas, the weights equal the weighings, the header holds the weighings' notebook reference, and each `results` row agrees with the worksheet within 0.0001 g. |
| 5. Verification | Result Worksheet and synthetic weighings | `verify_results`, run by a different Agent than stage 4 | Verification Record (`VerificationRecord`, JSON) | The record names the worksheet and the weighings the Run took, every recomputation agrees with the weighings within 0.0001 g, and the record's verdict says so. |
| 6. Report | Verification Record, Receiving Log row and the weighings, and the toy LIMS database it carries | `render_roa` | Report of Analysis (`ReportOfAnalysis`, xlsx and PDF) and the next toy LIMS database version with the `reports` row | The record's verdict was pass, every metadata cell equals the Receiving Log row's and the database's value, the result is the record's mean, the PDF shows the Lab Reference, Lot, Product Code, result and the weighings' notebook reference, and the `reports` row names the PDF. |

The chain runs end to end: `aliquot workflow run` takes a Submission Form Fixture through all six stages, and `aliquot sandbox lineage <report id>` walks the Report of Analysis back through every Artifact it was made from to the Fixture and the weighings.

The chat flow has a second entry point. The Operator reports received Samples in a Message in the Lab Room, and the Conductor runs it as a Chain in `aliquot serve` (ADR-0021). It stores the Message as an `Other` Artifact (ADR-0015), runs `parse_message` on it to write a `SubmissionRecord` in stage 1's shape, runs stages 2 and 3 on one Task, and replies with each Lab Reference and the due date. Stage 2 carries the latest `LimsDatabase` a Run with a passed Evaluation wrote, so a second receipt continues the first's sequence though the first Chain's Task still waits `UnderReview`. A receipt said with `room say` on the command line, which no Chain takes, goes to the Agents instead: the Director gives a Task on it to the Specialist who works stage 2, and the Task's goal names the latest `LimsDatabase` as stage 2's second input, because `run_script` passes only the inputs the Agent names. The Lab References and the Work Order number continue the database's sequence, and on a home with no database `log_receipt` starts one. The Message must state every value the Report of Analysis is rendered from, each after its label: the Lot, the Product Code, the Client, the product, the Product Type after "Product Type", and the Report To party after "Report to", its company first, then its "Contact", "Address" and "City" (and optionally "Phone" and "Email"), to the end of the line. `parse_message` puts the party where `parse_submission` puts a form's Report To, so `log_receipt` stores it in the `samples` row. A receipt that lacks any of them is refused by `parse_message`, which names every one missing; the Conductor's reply gives that reason and nothing more runs, so no receipt reaches stage 2 that could only be refused at stage 6.

The chat flow's second half starts from the Operator's results Message: a Lab Reference or a Lot, the notebook reference, and for each container the weight of 20 capsules and the weight taken. The Conductor's results Chain runs `parse_results_message` on it and the latest accepted Work Order, which writes the weighings in the shape stage 4 reads from a Fixture, each entry also naming the notebook reference. It refuses a Message with no notebook reference, a container count other than the Work Order's, or a container without both weights. Stages 4, 5 and 6 then run on one Task assigned to the Agent who works stage 4; the Verifier rule binds the Agents' path, where each stage is its own Task and stage 5 goes to another Agent. The Conductor requests an `ExternalMessage` Gate naming the PDF and the Lab Reference, and replies to the results Message with the Gate id and the two report ids, within 1 s on the warm Sandbox. The Operator decides the Gate; nothing is sent on approval in the first edition, and the `GateDecided` is the sign-off.

The workflow is one table of stages in code (`workflow/stages.ts`). A row names the stage number and name, the Script, the input Artifact types the stage takes, each from the latest earlier stage that wrote one, the types it carries from the Ledger instead (the latest Artifact of that type that a Run of a `Done` Task wrote, such as the toy LIMS database from stage 2), its output types, the Agent that works it, the Agent that reviews it, and the Evaluation that scores the Run. An Evaluation reads the Run's input Artifacts and every Artifact the Run wrote, so stage 2 checks its rows against the record it read and its Lab References against the database version it carried. Adding a stage is adding a row, a Script directory, and an Evaluation. The table is refused at load when its rows are not stages 1, 2, 3 in order, or when stage 5 is worked by the Agent that works stage 4. The rows as built:

| Stage | Script | Worked by | Reviewed by |
|---|---|---|---|
| 1 Submission | `parse_submission` | Rin | Pia |
| 2 Receipt | `log_receipt` | Bram | Pia |
| 3 Work Order | `create_work_order` | Bram | Pia |
| 4 Results | `compute_results` | Rin | Anselm |
| 5 Verification | `verify_results` | Bram | Anselm |
| 6 Report | `render_roa` | Ines | Anselm |

The workflow tracer (`workflow/tracer.ts`) runs the table on a Submission Form Fixture. Each stage is a Task worked by the stage's Agent, on the earlier stages' outputs chosen by Artifact type, each type from the latest stage that wrote one, and, for stages 4, 5 and 6, the weighings beside the Fixture, until the table ends or a Task fails. Stage 6 takes stage 5's Verification Record and stage 2's Receiving Log row this way. A stage whose input type is missing is refused before its Task is proposed. Each stage's `TaskProposed` names the previous stage's last `TaskCompleted` as its cause, so the causal chain runs unbroken from the Fixture to the last stage.

A carried type takes only an Artifact that a Run of a `Done` Task wrote. When a stage's Evaluation fails, its Task fails, and the database version its Run wrote stays in the Ledger as a record of the attempt; no later stage carries it, because no Evaluation accepted it. The next stage that carries the database takes the version before it.

Stage 2's Script writes a third file, `receipt.json` (typed `Other`): the Receiving Log sheet as the Script reads it back from the xlsx it saved. The Conductor has no xlsx reader and takes no new dependency for one, so the stage 2 Evaluation reads the rows from this read-back. It reads the record and both database versions itself, with `node:sqlite`.

**The due date rule.** A Sample's due date is a number of business days after the date it was received, set by its TAT class: 10 business days for `Regular`, 2 for `Rush1to2Days`, and 4 for `Rush3to4Days`. Business days are Monday to Friday. Slice 1 has no holiday calendar, so a holiday counts as a business day. A Sample received on a Saturday or Sunday starts counting from the next Monday, which is business day 1. A Work Order is due when its last Sample is.

Stage 3 (`create_work_order`) writes one Work Order per Receiving Log row, which plans every Sample a receipt logged, though they come from several Sample lines with their own Lots and TAT classes (#83). It finds each Lab Reference on the row in the carried database's `samples` rows, which give the Sample's Lot, Product Code, Client, Sample type and TAT class, and it refuses a row whose Samples differ in Client or date received. Each Sample gets the Tests its Sample type names, and a Sample type with none is refused. Today only a finished product (FP) has one, the Test "Average capsule weight", so an RM or IP Sample stops stage 3 (#82). The Work Order number is `WO-<year received>-<n>`, numbered like the Lab Reference from the `work_orders` rows of the carried version. The sheet has a header block, which holds the Work Order number, Client, date received and the Work Order's due date. Below a blank row, it has one row per Sample and Test, with the Sample's Lot, Product Code, TAT class and due date. The Script and the stage 3 Evaluation each hold the day counts in a table of their own and compute the dates on their own, so a wrong date on either side fails the Evaluation. The Script also writes `work_order.json` (typed `Other`, schema `work_order/2`), which holds the Receiving Log row's Lab References and dates as the Script read them, and the Work Order as it reads it back from its xlsx. The Evaluation reads the Work Order from this read-back, and the TAT classes, Lots and `work_orders` rows of both database versions itself. Stages 4 to 6 still treat a Work Order as one Sample: stage 4 takes one mean over all its containers, and stage 6 reports its first Sample with that mean.

**The weighings.** Stage 4 needs bench measurements, which no earlier stage writes. The synthetic generator invents them with the record and writes them as `weighings.json`: one JSON array of `{container, weight_of_20_g, weight_taken_g}`, one entry per container. Each Fixture has its seed's weighings beside it as `<fixture stem>.weighings.json`. Before the first stage that takes `Other` as input, the tracer stores that file as an `Other` Artifact produced by the Operator, with media type `application/json` and no Lineage, as it stores the Fixture. A stage takes `Other` only as the weighings. The `Other` files an earlier stage writes are read-backs for its own Evaluation and are never another stage's input. When the file is missing, the stage is refused before its Task is proposed, and the refusal names the file. The weighings' `ArtifactStored` names no cause, as the Fixture's does, and the stage's `TaskProposed` still names the previous stage's last `TaskCompleted`.

Stage 4 (`compute_results`) writes one Result Worksheet per Work Order, in the layout of the synthetic generator's worksheet. The header block holds the title, the Work Order number and the Test. When the weighings name a notebook reference, as those read from the Operator's results Message do, row 4 holds "Notebook Reference" and the reference; the Fixtures' weighings name none, and row 4 stays empty. Weighings whose entries name two references are refused. Row 5 holds the columns `#` (the container number), Code, Name, Status, Lot#, the weight of 20 capsules, the weight taken, and the average weight. Below it is one row per container in container order. The two weights are the weighings, typed as values. The average is the formula `=F<row>/20`, never a typed value. A Mean row follows, with `=AVERAGE(H<first>:H<last>)`. The Script finds each Sample of the Work Order in the carried database's `samples` rows, which give its container number and Lot, and it refuses weighings that miss a container of the Work Order or weigh a container that is on no Sample. It computes each average and the mean in Python and writes two `results` rows per Sample, both in `g` with the weighings' Artifact id as `source_artifact`. The row for the Test "Average capsule weight" holds the Sample's own average. The row "Average capsule weight, Work Order mean" holds the mean of the Work Order's averages. The Script also writes `result_worksheet.json` (typed `Other`), the sheet as the Script reads it back from its xlsx with every formula as its text. The stage 4 Evaluation reads the worksheet from this read-back, the weighings from the Run's `Other` input, and both database versions itself. It requires the following. Every container row's average is its `=F<row>/20` formula. The weights equal the weighing of the row's container, and every weighing has a row. The Mean row holds its `AVERAGE` formula. The header's Notebook Reference is the weighings' one, or absent when they name none. For each Sample of the Work Order, the average row in `results` equals its container row's weight of 20 capsules divided by 20, and its mean row equals the mean of those, each within 0.0001 g.

Stage 5 (`verify_results`) takes the Result Worksheet and the same weighings Artifact, and carries nothing. It reads the xlsx itself, not stage 4's read-back, so a worksheet whose read-back hides a typed value still fails here. It finds the column row and the Mean row, and pairs each container row with its weighing by the `#` column. For each container row, it evaluates the Average Weight (g) cell on the worksheet's own cells. A formula `=<cell>/<number>` or `=AVERAGE(<cell>:<cell>)` is evaluated, a typed number counts as it stands, and anything else recomputes to nothing. The Script compares the result with the weighing's weight of 20 capsules divided by 20, and the Mean row with the mean of the weighings' averages. It writes `verification_record.json` (`VerificationRecord`, schema `verification_record/1`). The record holds the worksheet's and the weighings' Artifact ids, the Work Order number, and the tolerance, 0.0001 g. For each container row, it holds the row, the container, the formula text (null for a typed value), the recomputed value, the weighing's average, their difference, and whether it is within tolerance. It also holds the same for the Mean row, the weighed containers with no row, and a verdict, `pass` or `fail`. The verdict is `pass` when every row and the mean are within tolerance and every weighing has a row. The stage 5 Evaluation reads the record and the weighings the Run took. It requires the following. The record names the Run's worksheet and weighings. It has a row for every weighing. Each row's recomputed value, and the mean's, agrees with the average the Evaluation computes from the weighings, within 0.0001 g. The verdict is `pass` exactly when all of that agrees. A worksheet that fails Verification fails the stage 5 Task.

**The Verifier rule.** A Verifier is never the author of the Result Worksheet. Two checks hold the rule. The stage table refuses a stage 5 worked by the Agent that works stage 4. The workflow guard (`workflow/guards.ts`) holds it for every Task Event, from the tracer, the command line, or an Agent's Tool call. A Task is a Verification when its title starts `Stage <n> <name>: ` for the stage that writes a `VerificationRecord`, which is how the tracer titles it. The guard refuses a `TaskAssigned` or `TaskHandedOff` that gives a Verification Task to an Agent the Task Projection lists as ever assigned to the Task whose Run wrote a Result Worksheet among the Verification's inputs. The refusal reads `TaskAssigned refused: A-rin was assigned T-4, whose Run wrote the Result Worksheet that T-6 verifies; a Verifier is never the author of the Result Worksheet`. The stage 5 Evaluation does not check the rule, because it scores Artifacts and sees no Agent. The rule binds who holds the Task. The Sandbox does not yet check that a Run's actor is its Task's assignee.

Stage 6 (`render_roa`) takes the Verification Record, the Receiving Log row and the weighings, and carries the version stage 4 wrote. The report is for the first Sample, by Lab Reference, of the record's Work Order that the Receiving Log row lists. The Script reads every metadata value from that Sample's Receiving Log row or its `samples` row. The Lab Reference, product, Lot, Product Code, Product Type, Client, and date and time received come from the row. The Attention, address and received-by values come from the `samples` row. The Test comes from the Sample's `work_orders` row and the unit from its `results` row. The result is the record's recomputed mean, rounded to 4 places. The Script refuses to render, and writes nothing, when any of these is missing or blank. The letterhead, the Method, the Specification and the Document Revision belong to the report form, not to the Sample. The xlsx and the PDF are drawn from one Python structure, so they cannot disagree. The xlsx keeps the layout of the synthetic generator's report. The PDF is drawn by reportlab with uncompressed page streams and invariant metadata, so the same report gives the same bytes. The signature area names the Script and the Verification Record by its Artifact id and verdict, and below it the weighings' notebook reference, when they name one. The Run that rendered the report and the Run that wrote the record name their Agents in the Ledger. The next database version holds one `reports` row for the Sample. Its `source_artifact` is the PDF's Artifact id, which the Script computes as the sha256 of the bytes it wrote, because an Artifact id is the sha256 of its bytes. The schema's one `source_artifact` column holds no second id, so the xlsx is found through the PDF's Run. The Script also writes `report_of_analysis.json` (typed `Other`), which holds the Sample's Receiving Log row as the Script read it and the report's sheet as it reads back its xlsx. A report leaves the lab only through an `ExternalMessage` Gate (ADR-0006): when an Agent holds stage 6's Task, its Task line tells it to request one after the Run, naming the PDF's Artifact id and the report's Lab Reference, and to reply to the latest Operator's Message the Task's inputs trace back to with the Gate id and the two report ids.

The stage 6 Evaluation reads the record, the weighings, both database versions and the PDF itself, and the sheet and the Receiving Log row from the read-back. It requires the following. The record's verdict is `pass`. The report's Sample is on the record's Work Order. Every Client and metadata cell equals the Receiving Log row's value where the row has that column, and equals the carried version's `samples` or `lots` value. The result equals the record's mean within 0.0001 g. The text that the PDF's `Tj` operators show includes the Lab Reference, Lot, Product Code and result to 4 places. The signature area holds the weighings' notebook reference, and the PDF's text shows it, when the weighings name one; otherwise the sheet holds none. The written version's `reports` row names the PDF and the report's Document Revision, and the carried version had no `reports` row for the Sample. A report with a hand-typed metadata value, or one rendered from a failed Verification, fails the stage 6 Task.

The workflow lifecycle (`workflow/lifecycle.ts`) appends every `EvaluationRecorded`. It mints the Evaluation id from the Projections, records the stage the Evaluation scores, and names the `RunFinished` of the Run it scores as the Event's cause. It refuses an Evaluation of a Run that has not finished, or for a Task that is no longer live, before it builds the Event, in the words of the workflow guard. The guard also refuses a new Evaluation that names no stage; one recorded before Evaluations named their stage still loads (ADR-0012). The workflow tracer appends nothing itself: it calls the Sandbox, the Task lifecycle, and this lifecycle.

## The Operator's interface

Every view is a Projection of the Ledger and updates live over SSE. No view stores its own state. Each view has a hash route (`#/org`, `#/flow`, `#/agent`, `#/chat`, `#/rooms`, `#/scripts`, `#/gates`, `#/performance`, `#/ledger`). It fetches its Projections from `/api/` and fetches them again on every Event the stream delivers. A view's markup is a pure function of that JSON. Until its own ticket draws it, a view shows the JSON as it came. A new browser tab first shows the Access landing, a lock frame with the Operator, the laboratory, the terminal and a clock; ENTER opens the shell. It asks for no password, because Cloudflare Access already decided who may load the page. The look follows the owner's Aliquot LIMS design: bone paper, black slab panels with a lime edge, orange for refused and rejected states, and a dark theme.

| View | Shows | Operator actions |
|---|---|---|
| Org | A tree of Agents by supervisor, with a Trust tier and load bar for each | Pause, resume, reassign, retire (opens a `RetireAgent` Gate), open an Agent |
| Flow | Tasks in one swimlane per stage, with causation arrows between Events, filtered by Task or Lot | Open a Task and read its Events |
| Agent | Charter, Persona, current Vitality (Mood is flat in the first edition), Merit history, Memory notes, and Skills | Open the Agent's Room, a Room whose only listed member is that Agent; author a Revision; give Coaching |
| Chat | The Lab Room `RM-lab`: every Message newest last, with the name of who said it. A Submission Form still goes through `aliquot intake` and stage 1. | Say a Message in `RM-lab` as the Operator, such as a report of received Samples |
| Rooms | Every Room, private ones included, with its Messages live | Say a Message in any Room, open a Room |
| Scripts | Each Script with its versions, owner, Fixtures, and latest Runs | Open a Run, read its stdout and stderr |
| Gates | Open Gates, each with a diff of its payload | Approve or reject, with a reason |
| Performance | Merit per Agent over time, the rubric breakdown, the Energy budget, and Tasks by state | Export CSV |
| Ledger | Raw Events with the status of the hash chain | Verify the chain |

## Slices and roadmap

Each slice ends in something the Operator can check. The first edition is the chat flow: the Operator reports received Samples in the Lab Room and an Agent logs them; the Operator gives the notebook reference and the results, and an Agent drafts the Report of Analysis as xlsx and PDF behind a Gate. Everything that does not serve that flow waits for a later edition, whatever its ticket says.

1. **Slice 0, the base.** Done 2026-10-12. Repository layout, the ten types, the Ledger with its hash chain and reducers, the Docker image, the synthetic generator, and CI that runs every Fixture. No Agents. Beyond its line: it also built the Org, Task, Gate, Room, Sandbox and Vitality domains with their commands, and stage 1 under a tracer. Its tip is kept as the branch `slice-0-v1`.
2. **Slice 1, the society on toy work.** Done 2026-10-13. Built: the lifecycles, the six stages of the toy workflow under a tracer, the views behind Tunnel and Access, Turns as Events, the Agent's Tools, the first real Turn through the Agent SDK, and the Scheduler. It ends with one live run of the society on a Fixture. Mood is flat (#62): the Mood thresholds stay written but are not in force until the chat flow has produced data to tune against. Beyond its line: flat Mood (#62), an escalated Task's target gets a Turn (#63), assignment refuses a paused or Retired Agent (#65), the Access landing and the Aliquot design, and the project `verify` skill. Short of its line: the live run stopped at stage 1, the Rooms and Scripts views show their JSON undrawn, and the Tunnel and Access setup is written but not applied.
3. **Slice 2, the chat flow.** Done 2026-10-13. A Chat view on the Lab Room. Receiving from chat: the Operator's Message becomes a Submission Record, and stages 2 and 3 log the Samples and open the Work Order. Results from chat: the Operator's Message with the notebook reference and the weighings feeds stage 4, stages 4 to 6 run as built, and the Specialist that rendered the report requests an `ExternalMessage` Gate the Operator decides. It ends when the Operator has logged Samples and approved a report from the Chat view, on synthetic data. Beyond its line: the receipt must state the Report To party and the Product Type, so no receipt reaches stage 2 that stage 6 would refuse (ADR-0016 withdrawn), and the Lab References continue the toy LIMS database (#66). Short of its line: the end check ran with a scripted model in the tests and the `verify` proofs, not live; no live Turn has taken the chat flow to its Gate.

   Slice 2 is finished by four tickets:
   - #70: the Tunnel serve runs the Scheduler (resolves #68).
   - #71: a stage's Task goes to the stage's worker, who sees the stage's Script (resolves #64 and the Scheduler's half of #59).
   - #72: Escalation and Help go only to an active Agent (resolves #67).
   - #73: one live run of the chat flow, from a receipt in the Lab Room to a decided `ExternalMessage` Gate, after #70, #71 and #72. Slice 2 is finished when its note is read.

   Two more items stay open. At gate G2 the owner applies the Tunnel and Access setup in `docs/ops/tunnel.md`. The Rooms and Scripts views still show their JSON as it came, until a ticket draws them.
4. **Identity, before slice 3.** Done ([ADR-0019](../adr/0019-every-human-act-names-the-person.md)). #74: every Event a person authors names the person by email, from the Cloudflare Access assertion in the interface and from `--operator` on the command line, and `aliquot serve` admits a list of people. Events written before it read as the unnamed Operator (ADR-0012). The email on the actor is the shape the seam to the human LIMS will use (ADR-0017).
5. **Slice 3, real work in parallel.** The same flow on the lab's real documents, run beside the lab's own work first (ADR-0018). #75: scrubbed copies of the real templates, in their layout, become Fixtures (the `anonymize` of the risks table). #76, built: stages 1 and 2 read the real Submission Form layout and write a Shadow Receiving Log in the real columns and sheets, and `shadow compare` writes the Comparison against the rows the lab entered by hand (see "The parallel run" under "What exists today"). #77: reports in the real layouts, beside the lab's, once #76's comparisons are read. Slice 3 has started when the first comparison is read. Only after the Operator has judged the parallel run does a separate ticket write the real Receiving Log behind the `WriteSystemOfRecord` Gate.

After slice 3, by the owner's word: the Client submission interface, where a Client gives text, .csv, .xlsx or .txt, a model on Sonnet or Haiku fills the lab's Submission Form, the Client confirms it, and the Client sees status and downloads the report; the seam to aliquot-lims-dev; and the login mechanism, chosen last, before deployment.

Not on the first edition's path: Vitality, Merit, Reviews, Trust tiers and Training (ADR-0017). They stay built and in the Ledger, and nothing is deleted. Later still: tuning the Mood thresholds, Developer and Tester building for Lab staff behind the `Deploy` Gate, and reading VBA.

## Risks and open questions

Each item states the default we take and the one word the Operator can send to reverse it.

| Risk or question | Default | Reverse word |
|---|---|---|
| The SDK documentation does not cover subscription login for a personal tool, and forbids third parties from offering claude.ai login in products. | Proceed for personal internal use and keep authentication swappable. The Operator may confirm with Anthropic. | `apikey` |
| Lab text reaches Anthropic inside prompts. | Accepted by the owner on 2026-10-13 for the demo to lab members: real lab text goes to Anthropic inside prompts in slice 3's parallel run. The real templates are still never committed (ADR-0009). | `local`, which replaces the model with a local one before real data reaches it |
| Is the society the product? | No. This repository is the automation engine behind the human LIMS, aliquot-lims-dev, which keeps people, roles, review, OOS and the Client portal (ADR-0017). | `society` |
| Does slice 3 write the lab's real records? | Not at first. It writes shadow copies and a comparison, and writes the real Receiving Log only when the Operator says so, behind the `WriteSystemOfRecord` Gate (ADR-0018). | `direct` |
| Subdomain or path on the Cloudflare zone. | `agents.nitrolims-demo.com`. | `path` |
| The templates hold real Client data and are untracked. | Ignore them in git. Since #75, `anonymize` (`sandbox/synth/anonymize/`) writes scrubbed copies in their layout to `fixtures/real-layout/`: an allowlist keeps labels, units and formulas' form, and every other value gets a synthetic value of the same shape. A test on the lab's machine proves that no template value of four or more characters survives in any Fixture, and CI's forbidden-terms check scans every Fixture. | `shapes`, which deletes the scrubbed copies and keeps the synthetic generator's shapes only |
| Nobody knows how many Turns the subscription allows at once. | Two at a time. The live run of 2026-10-13 ([live-run-2026-10.md](live-run-2026-10.md)) had 2 Turns open at once for 6 seconds, and the subscription refused neither. It never asked for a third, so the ceiling is still unknown. | `serial`, which runs one Turn at a time |
| The Energy budget of 1,000,000 tokens per 5-hour window is a guess. | Keep it. The live run counted 28,140 tokens in 4 Turns, which is 2.8 percent of the budget and an average of 7,035 per Turn, and the subscription refused nothing. The run stopped at stage 1, so it does not show what a full chain costs. | `budget`, with the Operator's number of tokens |
| The Mood thresholds are guesses. | `flat`, taken in #62: every Agent is `fresh`, and Vitality is recorded but decides nothing. The live run of 2026-10-13 sampled every Agent `fresh`. | `thresholds`, which puts the Mood table of `docs/design/vitality-and-merit.md` back in force |
| Agents may talk in private Rooms. | Allowed. The Operator is a member of every Room and reads everything. | `open`, which forbids Listed Rooms |
| An Agent may write a Revision that removes one of its own forbidden Actions. | Allow it. The Conductor, not the Charter, enforces Gates, and the Auditor flags every Revision that removes a boundary. | `lock`, which puts such Revisions behind a Gate |
